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
});
