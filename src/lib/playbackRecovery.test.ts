import { describe, expect, it } from 'vitest';
import {
  CONFIRM_TAIL_MS,
  RECOVERY_RETRY_OFFSETS_MS,
  createPlaybackRecovery,
  type RecoveryEvent,
  type RecoveryTarget,
  type RecoveryTimers,
} from './playbackRecovery';

/**
 * These tests exercise the coordinator's decision logic against a fake player
 * on a virtual clock. They say nothing about whether Twitch actually resumes —
 * that is cross-origin behaviour no unit test can reach. What they do pin down
 * is every rule the coordinator is supposed to enforce, especially the ones
 * that caused real regressions when they were absent.
 */

/** Minimal virtual clock: run pending timers in due order. */
function createFakeTimers(): RecoveryTimers & { advance(ms: number): void; now(): number } {
  let now = 0;
  let nextHandle = 1;
  const scheduled = new Map<number, { at: number; fn: () => void }>();

  return {
    setTimeout(fn, ms) {
      const handle = nextHandle++;
      scheduled.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let dueHandle: number | null = null;
        let dueAt = Infinity;
        for (const [handle, entry] of scheduled) {
          if (entry.at <= target && entry.at < dueAt) {
            dueAt = entry.at;
            dueHandle = handle;
          }
        }
        if (dueHandle === null) break;
        const entry = scheduled.get(dueHandle);
        if (!entry) break;
        scheduled.delete(dueHandle);
        now = entry.at;
        entry.fn();
      }
      now = target;
    },
    now() {
      return now;
    },
  };
}

type FakePlayer = RecoveryTarget & {
  plays: number;
  paused: boolean | null;
  eligible: boolean;
};

function createFakePlayer(id: string, paused: boolean | null = true): FakePlayer {
  return {
    id,
    plays: 0,
    paused,
    eligible: true,
    isPaused() {
      return this.paused;
    },
    isEligible() {
      return this.eligible;
    },
    play() {
      this.plays += 1;
    },
  };
}

type RecoveryOptions = Parameters<typeof createPlaybackRecovery>[0];

function setup(overrides: Partial<Omit<RecoveryOptions, 'timers' | 'log'>> = {}) {
  const timers = createFakeTimers();
  const events: { event: RecoveryEvent; detail: Record<string, unknown> }[] = [];
  const recovery = createPlaybackRecovery({
    timers,
    log: (event, detail) => events.push({ event, detail }),
    ...overrides,
  });
  const names = (): RecoveryEvent[] => events.map((entry) => entry.event);
  return { timers, events, recovery, names };
}

const LAST_OFFSET = RECOVERY_RETRY_OFFSETS_MS[RECOVERY_RETRY_OFFSETS_MS.length - 1];
const FULL_RUN_MS = LAST_OFFSET + CONFIRM_TAIL_MS;

describe('createPlaybackRecovery', () => {
  it('does nothing at all when the player is not paused', () => {
    const { timers, recovery, names } = setup();
    const player = createFakePlayer('a', false);

    recovery.begin([player], 'add');
    timers.advance(FULL_RUN_MS + 1000);

    expect(player.plays).toBe(0);
    expect(names()).toContain('success');
    expect(recovery.pendingIds()).toEqual([]);
  });

  it('confirms success once a play() takes hold, and stops early', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    timers.advance(0);
    expect(player.plays).toBe(1);

    player.paused = false; // the play() worked
    timers.advance(750);

    expect(player.plays).toBe(1);
    expect(recovery.pendingIds()).toEqual([]);
    expect(events.find((entry) => entry.event === 'success')?.detail.reason).toBe(
      'play-confirmed',
    );
  });

  it('calls play() only on a confirmed paused reading, and retries on the schedule', () => {
    const { timers, recovery } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');

    timers.advance(0);
    expect(player.plays).toBe(1);

    timers.advance(750);
    expect(player.plays).toBe(2);

    timers.advance(750);
    expect(player.plays).toBe(3);

    timers.advance(1500);
    expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
  });

  it('stops retrying as soon as playback comes back', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    timers.advance(0);
    expect(player.plays).toBe(1);

    player.paused = false;
    timers.advance(750);

    expect(player.plays).toBe(1);
    expect(recovery.pendingIds()).toEqual([]);
    const success = events.find((entry) => entry.event === 'success');
    expect(success?.detail.reason).toBe('play-confirmed');

    timers.advance(FULL_RUN_MS);
    expect(player.plays).toBe(1);
  });

  it('is bounded — it gives up instead of looping forever', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    timers.advance(FULL_RUN_MS + 60_000);

    expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
    expect(recovery.pendingIds()).toEqual([]);
    const exhausted = events.find((entry) => entry.event === 'exhausted');
    expect(exhausted?.detail.reason).toBe('still-paused');
  });

  it('escalates to the target reload once bounded play() recovery is exhausted still-paused', () => {
    const { timers, recovery } = setup();
    let escalations = 0;
    const player = createFakePlayer('a', true);
    player.escalate = () => {
      escalations += 1;
    };

    recovery.begin([player], 'headers');
    timers.advance(FULL_RUN_MS + 60_000);

    expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
    expect(escalations).toBe(1);
  });

  it('never plays a target that became ineligible (user paused it, card removed, focused)', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    timers.advance(0);
    expect(player.plays).toBe(1);

    player.eligible = false;
    timers.advance(FULL_RUN_MS);

    expect(player.plays).toBe(1);
    const skip = events.find((entry) => entry.event === 'skip');
    expect(skip?.detail.reason).toBe('ineligible');
  });

  it('never plays a target that was ineligible from the start', () => {
    const { timers, recovery } = setup();
    const player = createFakePlayer('a', true);
    player.eligible = false;

    recovery.begin([player], 'add');
    timers.advance(FULL_RUN_MS);

    expect(player.plays).toBe(0);
  });

  it('treats an unreadable isPaused() as unknown, not as paused', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', null);

    recovery.begin([player], 'add');
    timers.advance(FULL_RUN_MS);

    expect(player.plays).toBe(0);
    const exhausted = events.find((entry) => entry.event === 'exhausted');
    expect(exhausted?.detail.reason).toBe('unreadable');
  });

  it('recovers from a transient unreadable window once isPaused() answers again', () => {
    const { timers, recovery } = setup();
    const player = createFakePlayer('a', null);

    recovery.begin([player], 'add');
    timers.advance(0);
    expect(player.plays).toBe(0);

    player.paused = true;
    timers.advance(750);
    expect(player.plays).toBe(1);
  });

  it('accepts a real PLAYING event as positive confirmation and stops', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    timers.advance(0);
    expect(player.plays).toBe(1);

    recovery.confirmPlaying('a');
    expect(recovery.pendingIds()).toEqual([]);

    timers.advance(FULL_RUN_MS);
    expect(player.plays).toBe(1);
    const success = events.find((entry) => entry.event === 'success');
    expect(success?.detail.reason).toBe('playing-event');
  });

  it('stops on PLAYBACK_BLOCKED rather than retrying play() against autoplay policy', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    timers.advance(0);
    expect(player.plays).toBe(1);

    recovery.markBlocked('a');
    timers.advance(FULL_RUN_MS);

    expect(player.plays).toBe(1);
    expect(events.some((entry) => entry.event === 'blocked')).toBe(true);
    expect(recovery.pendingIds()).toEqual([]);
  });

  it('cancels stale work when another transaction begins', () => {
    const { timers, recovery, events } = setup();
    const first = createFakePlayer('a', true);
    const second = createFakePlayer('b', true);

    recovery.begin([first], 'add');
    timers.advance(0);
    expect(first.plays).toBe(1);

    recovery.begin([second], 'remove');
    expect(recovery.pendingIds()).toEqual(['b']);

    timers.advance(FULL_RUN_MS);
    expect(first.plays).toBe(1);
    expect(second.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);

    const cancel = events.find((entry) => entry.event === 'cancel');
    expect(cancel?.detail.reason).toBe('superseded-by-remove');
  });

  it('runs targets independently — one stuck player does not delay another', () => {
    const { timers, recovery } = setup();
    const stuck = createFakePlayer('a', true);
    const healthy = createFakePlayer('b', false);

    recovery.begin([stuck, healthy], 'add');
    timers.advance(0);

    expect(stuck.plays).toBe(1);
    expect(healthy.plays).toBe(0);
  });

  /*
   * Regression, found in a live harness run. Twitch pauses on a resize
   * ASYNCHRONOUSLY — the first pass almost always reads healthy, because
   * Twitch has not reacted yet. Retiring the target on that first healthy
   * read meant the later passes never ran for the exact case they exist to
   * catch, making the whole schedule dead code in the real scenario.
   */
  it('keeps watching after an early healthy read, and catches a later pause', () => {
    const { timers, recovery } = setup();
    const player = createFakePlayer('a', false);

    recovery.begin([player], 'add');

    timers.advance(0);
    expect(player.plays).toBe(0);
    expect(recovery.pendingIds()).toEqual(['a']);

    // Twitch pauses it only now, after the layout had already settled.
    player.paused = true;
    timers.advance(750);
    expect(player.plays).toBe(1);
  });

  it('never calls play() on a player that stays healthy for the whole run', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', false);

    recovery.begin([player], 'add');
    timers.advance(FULL_RUN_MS + 5000);

    expect(player.plays).toBe(0);
    const success = events.find((entry) => entry.event === 'success');
    expect(success?.detail.reason).toBe('never-paused');
    expect(recovery.pendingIds()).toEqual([]);
  });

  it('track() adds a new-player run without disturbing a transaction in flight', () => {
    const { timers, recovery } = setup();
    const surviving = createFakePlayer('a', true);
    const added = createFakePlayer('b', true);

    recovery.begin([surviving], 'add');
    recovery.track(added, 'new-player');

    expect(recovery.pendingIds().sort()).toEqual(['a', 'b']);

    // The new player's schedule starts later — it is expected to autoplay.
    timers.advance(0);
    expect(surviving.plays).toBe(1);
    expect(added.plays).toBe(0);

    timers.advance(1500);
    expect(added.plays).toBe(1);
  });

  /*
   * Regression: a stream added mid-transaction used to lose its autoplay check.
   * READY for the new player fires while syncStreamGrid is still running, so
   * track() lands BEFORE the begin() for the same transaction — and begin()
   * cancelling everything took the new card's only check with it.
   */
  it('does not cancel a new-player watch when a transaction begins', () => {
    const { timers, recovery, events } = setup();
    const added = createFakePlayer('added', true);
    const surviving = createFakePlayer('surviving', true);

    recovery.track(added, 'new-player');
    recovery.begin([surviving], 'add');

    expect(recovery.pendingIds().sort()).toEqual(['added', 'surviving']);
    expect(events.some((entry) => entry.event === 'cancel')).toBe(false);

    // The new card keeps its own later schedule rather than the transaction's.
    timers.advance(0);
    expect(added.plays).toBe(0);
    expect(surviving.plays).toBe(1);

    timers.advance(1500);
    expect(added.plays).toBe(1);
  });

  it('keeps a new-player schedule even if the same id is also a transaction target', () => {
    const { timers, recovery } = setup();
    const player = createFakePlayer('a', true);

    recovery.track(player, 'new-player');
    recovery.begin([player], 'add');

    timers.advance(0);
    expect(player.plays).toBe(0);

    timers.advance(1500);
    expect(player.plays).toBe(1);
  });

  it('cancel() clears everything in flight', () => {
    const { timers, recovery } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    recovery.cancel('teardown');

    expect(recovery.pendingIds()).toEqual([]);
    timers.advance(FULL_RUN_MS);
    expect(player.plays).toBe(0);
  });

  it('begin() with no targets is a no-op', () => {
    const { timers, recovery } = setup();
    recovery.begin([], 'add');
    timers.advance(FULL_RUN_MS);
    expect(recovery.pendingIds()).toEqual([]);
  });

  it('ignores confirmations for ids it is not tracking', () => {
    const { recovery } = setup();
    expect(() => recovery.confirmPlaying('nope')).not.toThrow();
    expect(() => recovery.markBlocked('nope')).not.toThrow();
  });

  /*
   * Release-hardening coverage below: each test pins one specific safety
   * property from the audit rather than general behavior already covered
   * above.
   */

  it('removal mid-recovery: a target that goes ineligible partway through never gets played again', () => {
    const { timers, recovery } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    timers.advance(0);
    expect(player.plays).toBe(1);

    // The card was removed from the DOM between passes — isEligible() now
    // reflects that (cardForStream returns null in the real target).
    player.eligible = false;
    timers.advance(FULL_RUN_MS + 60_000);

    expect(player.plays).toBe(1);
    expect(recovery.pendingIds()).toEqual([]);
  });

  it('a second mutation supersedes the first before its next scheduled play() can fire', () => {
    const { timers, recovery } = setup();
    const first = createFakePlayer('a', true);

    recovery.begin([first], 'add');
    timers.advance(0);
    expect(first.plays).toBe(1);

    // Second add/remove happens before the 750ms retry would have fired.
    timers.advance(400);
    const second = createFakePlayer('b', true);
    recovery.begin([second], 'remove');

    // The rest of the first target's schedule must never run.
    timers.advance(FULL_RUN_MS + 60_000);
    expect(first.plays).toBe(1);
  });

  it('a PLAYING event arriving after the run was already cancelled is a no-op', () => {
    const { timers, recovery } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    recovery.cancel('teardown');

    expect(() => recovery.confirmPlaying('a')).not.toThrow();
    expect(recovery.pendingIds()).toEqual([]);

    timers.advance(FULL_RUN_MS);
    expect(player.plays).toBe(0);
  });

  it('a deliberately paused stream, simply absent from the snapshot, is never touched', () => {
    const { timers, recovery } = setup();
    // The real caller builds this list from a pre-mutation "confirmed playing"
    // snapshot — a stream the user had already paused is never in it.
    const deliberatelyPaused = createFakePlayer('paused-by-user', true);
    const survivor = createFakePlayer('survivor', true);

    recovery.begin([survivor], 'add'); // deliberatelyPaused omitted entirely
    timers.advance(FULL_RUN_MS + 60_000);

    expect(deliberatelyPaused.plays).toBe(0);
    expect(survivor.plays).toBeGreaterThan(0);
  });

  it('a target that goes offline mid-run stops without further play() calls', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.begin([player], 'add');
    timers.advance(0);
    expect(player.plays).toBe(1);

    // OFFLINE flips isEligible() false in the real target (twitchPlayback
    // reads 'offline') — reloading a channel that's off the air does nothing.
    player.eligible = false;
    timers.advance(750);

    expect(player.plays).toBe(1);
    const skip = events.find((entry) => entry.event === 'skip');
    expect(skip?.detail.reason).toBe('ineligible');
    timers.advance(FULL_RUN_MS + 60_000);
    expect(player.plays).toBe(1);
  });

  it('PLAYBACK_BLOCKED during a new-player run stops it without retrying play()', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.track(player, 'new-player');
    timers.advance(1500);
    expect(player.plays).toBe(1);

    recovery.markBlocked('a');
    timers.advance(60_000);

    expect(player.plays).toBe(1);
    expect(events.some((entry) => entry.event === 'blocked')).toBe(true);
    expect(recovery.pendingIds()).toEqual([]);
  });

  it('a new-player run is bounded and exhausts with no further calls', () => {
    const { timers, recovery, events } = setup();
    const player = createFakePlayer('a', true);

    recovery.track(player, 'new-player');
    timers.advance(60_000);

    expect(player.plays).toBe(3); // NEW_PLAYER_RETRY_OFFSETS_MS.length
    expect(recovery.pendingIds()).toEqual([]);
    const exhausted = events.find((entry) => entry.event === 'exhausted');
    expect(exhausted?.detail.reason).toBe('still-paused');

    timers.advance(60_000);
    expect(player.plays).toBe(3); // still bounded, no further calls
  });

  it('a transaction run and a new-player run for different ids proceed fully independently', () => {
    const { timers, recovery } = setup();
    const surviving = createFakePlayer('surviving', true);
    const added = createFakePlayer('added', true);

    recovery.begin([surviving], 'add');
    recovery.track(added, 'new-player');

    timers.advance(60_000);

    expect(surviving.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
    expect(added.plays).toBe(3);
    expect(recovery.pendingIds()).toEqual([]);
  });

  /*
   * hover() backs the headers-hidden toolbar-transition recovery (open and
   * close). It reuses the coordinator's own bounded schedule and safety
   * rules — these tests pin the one new property it needs: it must never
   * disturb a transaction or new-player run for the same id, only ever
   * supersede a previous hover run.
   */
  describe('hover()', () => {
    it('starts a bounded run using the default multi-pass schedule', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.hover(player, 'toolbar-hover');
      timers.advance(0);
      expect(player.plays).toBe(1);

      timers.advance(750);
      expect(player.plays).toBe(2);
      timers.advance(750);
      expect(player.plays).toBe(3);
      timers.advance(1500);
      expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);

      timers.advance(CONFIRM_TAIL_MS);
      expect(recovery.pendingIds()).toEqual([]);
      const exhausted = events.find((entry) => entry.event === 'exhausted');
      expect(exhausted?.detail.reason).toBe('still-paused');
    });

    it('a later toolbar transition on the same card supersedes the earlier hover run', () => {
      const { timers, recovery } = setup();
      const player = createFakePlayer('a', true);

      recovery.hover(player, 'toolbar-open');
      timers.advance(0);
      expect(player.plays).toBe(1); // open run's immediate pass

      // Close transition fires before the open run's next scheduled retry —
      // same id, so start() replaces the run outright (clearing its pending
      // timeout) rather than layering a second one alongside it.
      timers.advance(400);
      recovery.hover(player, 'toolbar-close');

      // Run well past both a full new run AND what the superseded run's own
      // remaining passes would have added, if it had wrongly kept running.
      timers.advance(FULL_RUN_MS + 5000);

      // 1 from the superseded open run's single completed pass, plus exactly
      // one full run's worth from the close run — never a second full run's
      // worth layered on top, which is what an uncancelled old run would add.
      expect(player.plays).toBe(1 + RECOVERY_RETRY_OFFSETS_MS.length);
      expect(recovery.pendingIds()).toEqual([]);
    });

    it('does not cancel an in-flight transaction run for the same id', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.begin([player], 'add');
      timers.advance(0);
      expect(player.plays).toBe(1);

      // A toolbar transition happens to fire for the same card mid-transaction.
      recovery.hover(player, 'toolbar-hover');
      expect(events.some((entry) => entry.event === 'cancel')).toBe(false);

      // The transaction run's own schedule keeps running untouched.
      timers.advance(FULL_RUN_MS);
      expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
    });

    it('does not cancel an in-flight new-player run for the same id', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.track(player, 'new-player');
      recovery.hover(player, 'toolbar-hover');

      expect(events.some((entry) => entry.event === 'cancel')).toBe(false);

      timers.advance(60_000);
      expect(player.plays).toBe(3); // NEW_PLAYER_RETRY_OFFSETS_MS.length, untouched
    });

    it('hover runs for separate cards do not cancel each other', () => {
      const { timers, recovery } = setup();
      const first = createFakePlayer('a', true);
      const second = createFakePlayer('b', true);

      recovery.hover(first, 'toolbar-hover');
      recovery.hover(second, 'toolbar-hover');

      timers.advance(60_000);
      expect(first.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
      expect(second.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
    });

    it('never restarts a player that was never paused', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', false);

      recovery.hover(player, 'toolbar-hover');
      timers.advance(FULL_RUN_MS + 5000);

      expect(player.plays).toBe(0);
      const success = events.find((entry) => entry.event === 'success');
      expect(success?.detail.reason).toBe('never-paused');
    });

    it('a card removed or its player replaced mid-run receives no further play()', () => {
      const { timers, recovery } = setup();
      const player = createFakePlayer('a', true);

      recovery.hover(player, 'toolbar-hover');
      timers.advance(0);
      expect(player.plays).toBe(1);

      player.eligible = false; // card removed / player instance replaced
      timers.advance(FULL_RUN_MS + 60_000);

      expect(player.plays).toBe(1);
      expect(recovery.pendingIds()).toEqual([]);
    });

    it('an offline target is skipped without a play() call', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);
      player.eligible = false; // offline in the real target's isEligible()

      recovery.hover(player, 'toolbar-hover');
      timers.advance(FULL_RUN_MS + 60_000);

      expect(player.plays).toBe(0);
      const skip = events.find((entry) => entry.event === 'skip');
      expect(skip?.detail.reason).toBe('ineligible');
    });

    it('stops on PLAYBACK_BLOCKED rather than retrying play()', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.hover(player, 'toolbar-hover');
      timers.advance(0);
      expect(player.plays).toBe(1);

      recovery.markBlocked('a');
      timers.advance(FULL_RUN_MS);

      expect(player.plays).toBe(1);
      expect(events.some((entry) => entry.event === 'blocked')).toBe(true);
      expect(recovery.pendingIds()).toEqual([]);
    });

    it('every hover run terminates — bounded, no infinite retry', () => {
      const { timers, recovery } = setup();
      const player = createFakePlayer('a', true);

      recovery.hover(player, 'toolbar-hover');
      timers.advance(FULL_RUN_MS + 120_000);

      expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
      expect(recovery.pendingIds()).toEqual([]);
    });
  });

  /*
   * focusExit() covers the regression where exiting focus mode left every
   * non-focused stream paused: freezeFocusHiddenPlayers pauses them on entry,
   * and the bare play() resumeFocusHiddenPlayers issues on exit races the
   * same async post-resize Twitch pause that begin()/hover() already exist to
   * catch — with nothing rechecking it, streams sat paused until the next
   * watchdog tick. These tests pin the one property that matters for that
   * fix: a stale toolbar-hover run must never survive to block it, while an
   * in-flight transaction or new-player run always does.
   */
  describe('focusExit()', () => {
    it('starts bounded runs for every target using the default multi-pass schedule', () => {
      const { timers, recovery } = setup();
      const first = createFakePlayer('a', true);
      const second = createFakePlayer('b', true);

      recovery.focusExit([first, second], 'focus-exit');
      timers.advance(FULL_RUN_MS);

      expect(first.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
      expect(second.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
      expect(recovery.pendingIds()).toEqual([]);
    });

    it('begins recovery immediately on call, not after a long delay', () => {
      const { timers, recovery } = setup();
      const player = createFakePlayer('a', true);

      recovery.focusExit([player], 'focus-exit');
      // Pass 0 is offset 0ms — no need to advance the clock at all for the
      // first attempt, unlike the 15-20s the watchdog/nudge fallback needed.
      timers.advance(0);

      expect(player.plays).toBe(1);
    });

    it('supersedes a stale toolbar-hover run for the same id', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.hover(player, 'toolbar-hover');
      timers.advance(0);
      expect(player.plays).toBe(1); // the stale hover run's own immediate pass

      recovery.focusExit([player], 'focus-exit');
      timers.advance(FULL_RUN_MS);

      // 1 from the superseded hover run, plus exactly one full run's worth
      // from focus-exit — never blocked, never layered into a second run on
      // top of a hover run left running.
      expect(player.plays).toBe(1 + RECOVERY_RETRY_OFFSETS_MS.length);
      expect(recovery.pendingIds()).toEqual([]);
      expect(events.filter((entry) => entry.event === 'track' && entry.detail.cause === 'focus-exit')).toHaveLength(1);
    });

    it('does not disturb an in-flight transaction run for the same id', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.begin([player], 'add');
      timers.advance(0);
      expect(player.plays).toBe(1);

      recovery.focusExit([player], 'focus-exit');
      expect(events.some((entry) => entry.event === 'cancel')).toBe(false);

      // The transaction run's own schedule keeps running untouched.
      timers.advance(FULL_RUN_MS);
      expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
    });

    it('does not disturb an in-flight new-player run for the same id', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.track(player, 'new-player');
      recovery.focusExit([player], 'focus-exit');

      expect(events.some((entry) => entry.event === 'cancel')).toBe(false);

      timers.advance(60_000);
      expect(player.plays).toBe(3); // NEW_PLAYER_RETRY_OFFSETS_MS.length, untouched
    });

    it('a stream not in the target list (paused before focus entry) is never touched', () => {
      const { recovery, timers } = setup();
      const untouched = createFakePlayer('paused-before-entry', true);

      // Only players confirmed playing before entry are ever passed in —
      // this one simply never appears in the call.
      recovery.focusExit([], 'focus-exit');
      timers.advance(FULL_RUN_MS);

      expect(untouched.plays).toBe(0);
    });

    it('a target that goes ineligible mid-run (engaged, removed, or refocused) receives no further play()', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.focusExit([player], 'focus-exit');
      timers.advance(0);
      expect(player.plays).toBe(1);

      player.eligible = false;
      timers.advance(FULL_RUN_MS + 60_000);

      expect(player.plays).toBe(1);
      expect(events.some((entry) => entry.event === 'skip' && entry.detail.reason === 'ineligible')).toBe(
        true,
      );
    });

    it('separate players recover independently', () => {
      const { timers, recovery } = setup();
      const first = createFakePlayer('a', true);
      const second = createFakePlayer('b', false); // was never actually paused

      recovery.focusExit([first, second], 'focus-exit');
      timers.advance(FULL_RUN_MS);

      expect(first.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
      expect(second.plays).toBe(0);
    });

    it('every focus-exit run terminates — bounded, no infinite retry', () => {
      const { timers, recovery } = setup();
      const player = createFakePlayer('a', true);

      recovery.focusExit([player], 'focus-exit');
      timers.advance(FULL_RUN_MS + 120_000);

      expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
      expect(recovery.pendingIds()).toEqual([]);
    });

    it('focusExit() with an empty target list is a no-op', () => {
      const { recovery } = setup();
      recovery.focusExit([], 'focus-exit');
      expect(recovery.pendingIds()).toEqual([]);
    });
  });

  /**
   * overlay() backs the add-stream suggestions dropdown and share/watch-party
   * menu — absolutely-positioned toolbar overlays that can cover the grid
   * without resizing it. Unlike focusExit's one-shot call on mode exit, this
   * fires on every open/close edge (once per keystroke that opens the
   * dropdown for the first time, and again on close) — so the property that
   * matters most here is that a second overlay() call for the same id
   * restarts cleanly rather than layering a second run on top.
   */
  describe('overlay()', () => {
    it('starts a bounded run using the default multi-pass schedule', () => {
      const { timers, recovery } = setup();
      const player = createFakePlayer('a', true);

      recovery.overlay([player], 'overlay');
      timers.advance(FULL_RUN_MS);

      expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
      expect(recovery.pendingIds()).toEqual([]);
    });

    it('a second overlay() call for the same id supersedes the first (the reopen/keystroke case)', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.overlay([player], 'overlay');
      timers.advance(0);
      expect(player.plays).toBe(1);

      recovery.overlay([player], 'overlay');
      timers.advance(FULL_RUN_MS);

      // 1 from the first call's immediate pass, plus one full fresh run —
      // never blocked, never left running twice.
      expect(player.plays).toBe(1 + RECOVERY_RETRY_OFFSETS_MS.length);
      expect(recovery.pendingIds()).toEqual([]);
      expect(events.filter((entry) => entry.event === 'track' && entry.detail.cause === 'overlay')).toHaveLength(2);
    });

    it('does not disturb an in-flight transaction run for the same id', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.begin([player], 'add');
      timers.advance(0);
      expect(player.plays).toBe(1);

      recovery.overlay([player], 'overlay');
      expect(events.some((entry) => entry.event === 'cancel')).toBe(false);

      timers.advance(FULL_RUN_MS);
      expect(player.plays).toBe(RECOVERY_RETRY_OFFSETS_MS.length);
    });

    it('does not disturb an in-flight new-player run for the same id', () => {
      const { timers, recovery, events } = setup();
      const player = createFakePlayer('a', true);

      recovery.track(player, 'new-player');
      recovery.overlay([player], 'overlay');

      expect(events.some((entry) => entry.event === 'cancel')).toBe(false);

      timers.advance(60_000);
      expect(player.plays).toBe(3); // NEW_PLAYER_RETRY_OFFSETS_MS.length, untouched
    });

    it('supersedes a stale toolbar-hover run for the same id', () => {
      const { timers, recovery } = setup();
      const player = createFakePlayer('a', true);

      recovery.hover(player, 'toolbar-hover');
      timers.advance(0);
      expect(player.plays).toBe(1);

      recovery.overlay([player], 'overlay');
      timers.advance(FULL_RUN_MS);

      expect(player.plays).toBe(1 + RECOVERY_RETRY_OFFSETS_MS.length);
      expect(recovery.pendingIds()).toEqual([]);
    });

    it('overlay() with an empty target list is a no-op', () => {
      const { recovery } = setup();
      recovery.overlay([], 'overlay');
      expect(recovery.pendingIds()).toEqual([]);
    });
  });
});
