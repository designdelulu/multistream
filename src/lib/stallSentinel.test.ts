import { describe, expect, it } from 'vitest';
import {
  STALL_SENTINEL_CONFIRM_TICKS,
  STALL_SENTINEL_POLL_MS,
  STALL_SENTINEL_PROGRESS_EPSILON_S,
  createStallSentinel,
  type StallCandidate,
  type StallSentinelEvent,
  type StallSentinelTimers,
} from './stallSentinel';

/**
 * Same virtual-clock approach as playbackRecovery.test.ts: these tests pin
 * the sentinel's decision logic (what counts as a confirmed stall, and what
 * must never become one) against a fake candidate on a fake interval timer.
 * They say nothing about whether Twitch actually resumes.
 */
function createFakeTimers(): StallSentinelTimers & { advanceTicks(n: number): void } {
  let handler: (() => void) | null = null;
  let nextHandle = 1;
  let activeHandle = 0;

  return {
    setInterval(fn) {
      handler = fn;
      activeHandle = nextHandle++;
      return activeHandle;
    },
    clearInterval(handle) {
      if (handle === activeHandle) {
        handler = null;
        activeHandle = 0;
      }
    },
    advanceTicks(n) {
      for (let i = 0; i < n; i += 1) {
        handler?.();
      }
    },
  };
}

class FakeCandidate implements StallCandidate {
  paused: boolean | null;
  engaged = 0;
  /** Frozen by default: a test opts into progress explicitly, never by accident. */
  pos: number | null = 0;
  constructor(
    public readonly id: string,
    paused: boolean | null = false,
  ) {
    this.paused = paused;
  }
  isPaused(): boolean | null {
    return this.paused;
  }
  engagedAt(): number {
    return this.engaged;
  }
  position(): number | null {
    return this.pos;
  }
}

function setup(options?: { cooldownMs?: number; stampedeRatio?: number; confirmTicks?: number }) {
  const timers = createFakeTimers();
  // Starts nonzero: engagedAt() defaults to 0 for "never engaged" (see
  // FakeCandidate), and that must compare as strictly before any real
  // confirmed-playing timestamp — starting the virtual clock at 0 would
  // make the very first tick's lastPlayingAt collide with that default.
  let now = 1000;
  const candidates = new Map<string, FakeCandidate>();
  const pending = new Set<string>();
  const stalled: string[] = [];
  const events: { event: StallSentinelEvent; detail: Record<string, unknown> }[] = [];

  const sentinel = createStallSentinel({
    timers,
    now: () => now,
    listCandidates: () => [...candidates.values()],
    isPending: (id) => pending.has(id),
    onStall: (id) => stalled.push(id),
    confirmTicks: options?.confirmTicks,
    cooldownMs: options?.cooldownMs,
    stampedeRatio: options?.stampedeRatio,
    log: (event, detail) => events.push({ event, detail }),
  });

  /** One poll: move the clock a full interval, then fire the tick. */
  function poll(n = 1): void {
    for (let i = 0; i < n; i += 1) {
      now += STALL_SENTINEL_POLL_MS;
      timers.advanceTicks(1);
    }
  }

  return {
    timers,
    sentinel,
    candidates,
    pending,
    stalled,
    events,
    poll,
    advance(ms: number) {
      now += ms;
    },
    add(id: string, paused: boolean | null = false) {
      const candidate = new FakeCandidate(id, paused);
      candidates.set(id, candidate);
      return candidate;
    },
  };
}

describe('createStallSentinel', () => {
  it('never triggers for a stream never observed playing', () => {
    const { sentinel, add, stalled, poll } = setup();
    add('a', true); // already paused on the very first tick this sentinel sees it

    sentinel.start();
    poll(6);

    expect(stalled).toEqual([]);
  });

  it('requires CONFIRM_TICKS consecutive paused polls before acting', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll(); // confirmed playing

    card.paused = true;
    for (let i = 1; i < STALL_SENTINEL_CONFIRM_TICKS; i += 1) {
      poll();
      expect(stalled).toEqual([]); // still confirming — nothing touched yet
    }

    poll(); // the confirming tick
    expect(stalled).toEqual(['a']);
  });

  it('a pause that resolves before the threshold never triggers (the rebuffer case)', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll();

    // Paused for one poll short of the threshold, then playing again — this
    // is what a mid-stream rebuffer or ad transition looks like, and is the
    // exact false positive that made an always-on single-read poll unusable.
    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS - 1);
    card.paused = false;
    poll();

    expect(stalled).toEqual([]);
  });

  it('a resolved pause resets the streak, so a later stall needs the full threshold again', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll();

    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS - 1);
    card.paused = false;
    poll(); // streak reset

    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS - 1);
    expect(stalled).toEqual([]); // one short again — the reset really happened

    poll();
    expect(stalled).toEqual(['a']);
  });

  it('advancing position vetoes a paused reading outright (progress is ground truth)', () => {
    const { sentinel, add, stalled, events, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll();

    // isPaused() lies for far longer than the confirm window, but frames keep
    // moving — the player is alive and must never be touched.
    card.paused = true;
    for (let i = 0; i < STALL_SENTINEL_CONFIRM_TICKS * 3; i += 1) {
      card.pos = (card.pos ?? 0) + 5;
      poll();
    }

    expect(stalled).toEqual([]);
    expect(events.some((e) => e.event === 'progress-veto')).toBe(true);
  });

  it('progress mid-streak resets an in-progress confirmation', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll();

    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS - 1);

    card.pos = (card.pos ?? 0) + 5; // one frame of real progress
    poll();
    expect(stalled).toEqual([]);

    // Position frozen again from here — the streak must start over.
    poll(STALL_SENTINEL_CONFIRM_TICKS - 1);
    expect(stalled).toEqual([]);
    poll();
    expect(stalled).toEqual(['a']);
  });

  it('a position advance below the epsilon is not progress', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll();

    card.paused = true;
    for (let i = 0; i < STALL_SENTINEL_CONFIRM_TICKS; i += 1) {
      card.pos = (card.pos ?? 0) + STALL_SENTINEL_PROGRESS_EPSILON_S / 2; // float jitter, not playback
      poll();
    }

    expect(stalled).toEqual(['a']);
  });

  it('works with no position() at all, on persistence alone', () => {
    const timers = createFakeTimers();
    let now = 1000;
    const stalled: string[] = [];
    // Deliberately omits position() — the optional half of the contract.
    const card: StallCandidate & { paused: boolean } = {
      id: 'a',
      paused: false,
      isPaused() {
        return this.paused;
      },
      engagedAt: () => 0,
    };

    const sentinel = createStallSentinel({
      timers,
      now: () => now,
      listCandidates: () => [card],
      isPending: () => false,
      onStall: (id) => stalled.push(id),
    });

    sentinel.start();
    now += STALL_SENTINEL_POLL_MS;
    timers.advanceTicks(1);

    card.paused = true;
    for (let i = 0; i < STALL_SENTINEL_CONFIRM_TICKS; i += 1) {
      now += STALL_SENTINEL_POLL_MS;
      timers.advanceTicks(1);
    }

    expect(stalled).toEqual(['a']);
  });

  it('a confirmed stall inside the cooldown window triggers nothing further', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll();
    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS);
    expect(stalled).toEqual(['a']);

    // Recovers, stalls again, fully re-confirmed — but still inside cooldown.
    card.paused = false;
    poll();
    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS);

    expect(stalled).toEqual(['a']);
  });

  it('re-triggers for the same id once the cooldown has elapsed', () => {
    const { sentinel, add, stalled, poll, advance } = setup({ cooldownMs: 1000 });
    const card = add('a', false);

    sentinel.start();
    poll();
    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS);
    expect(stalled).toEqual(['a']);

    card.paused = false;
    poll();
    card.paused = true;
    advance(2000); // > cooldownMs
    poll(STALL_SENTINEL_CONFIRM_TICKS);

    expect(stalled).toEqual(['a', 'a']);
  });

  it('a null (unreadable) reading neither advances nor resets the streak', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll(); // confirmed playing

    card.paused = null; // isPaused() threw
    poll(10);
    expect(stalled).toEqual([]); // null alone can never confirm a stall

    // The playing latch survived, and a real stall from here still needs the
    // full threshold — the nulls contributed nothing in either direction.
    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS - 1);
    expect(stalled).toEqual([]);
    poll();
    expect(stalled).toEqual(['a']);
  });

  it('never disturbs an id a recovery run is already pending for', () => {
    const { sentinel, add, pending, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll();
    card.paused = true;
    pending.add('a');
    poll(STALL_SENTINEL_CONFIRM_TICKS);

    expect(stalled).toEqual([]);
  });

  it('a pause whose engagedAt() is at or after the last confirmed-playing tick is left alone (user-paused)', () => {
    const { sentinel, add, stalled, poll, advance } = setup();
    const card = add('a', false);

    sentinel.start();
    poll(); // confirmed playing

    advance(1);
    card.paused = true;
    card.engaged = Date.now() + 1e12; // unambiguously after any confirmed-playing tick
    poll(STALL_SENTINEL_CONFIRM_TICKS * 2);

    expect(stalled).toEqual([]);
  });

  it('a stale engagement from before the last confirmed-playing tick does not suppress a later stall', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);
    card.engaged = -1000; // engaged once, long before any of this

    sentinel.start();
    poll(); // confirmed playing after the old engagement
    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS);

    expect(stalled).toEqual(['a']);
  });

  it('the stampede guard suppresses action when most of the managed set stalls together', () => {
    const { sentinel, add, stalled, poll } = setup({ stampedeRatio: 0.5 });
    const a = add('a', false);
    const b = add('b', false);
    const c = add('c', false);

    sentinel.start();
    poll(); // all three confirmed playing

    a.paused = true;
    b.paused = true;
    c.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS);

    expect(stalled).toEqual([]);
  });

  it('does not suppress a single stall when the rest of the set stays healthy', () => {
    const { sentinel, add, stalled, poll } = setup({ stampedeRatio: 0.5 });
    const a = add('a', false);
    add('b', false);
    add('c', false);

    sentinel.start();
    poll();

    a.paused = true; // only one of three
    poll(STALL_SENTINEL_CONFIRM_TICKS);

    expect(stalled).toEqual(['a']);
  });

  it('shouldRun() gate freezes bookkeeping instead of forgetting it', () => {
    const timers = createFakeTimers();
    let now = 1000; // see setup()'s comment on why the virtual clock must not start at 0
    let quiet = false;
    const card = new FakeCandidate('a', false);
    const stalled: string[] = [];

    const sentinel = createStallSentinel({
      timers,
      now: () => now,
      listCandidates: () => [card],
      isPending: () => false,
      onStall: (id) => stalled.push(id),
      shouldRun: () => !quiet,
    });

    const poll = (n = 1): void => {
      for (let i = 0; i < n; i += 1) {
        now += STALL_SENTINEL_POLL_MS;
        timers.advanceTicks(1);
      }
    };

    sentinel.start();
    poll(); // confirmed playing

    quiet = true;
    card.paused = true;
    poll(10); // gated — must neither forget the latch nor accumulate a streak
    expect(stalled).toEqual([]);

    quiet = false;
    poll(STALL_SENTINEL_CONFIRM_TICKS - 1);
    expect(stalled).toEqual([]); // the quiet ticks contributed nothing to the streak

    poll();
    expect(stalled).toEqual(['a']);
  });

  it('drops bookkeeping for ids no longer offered by listCandidates (removed cards)', () => {
    const { sentinel, add, candidates, stalled, poll } = setup();
    add('a', false);

    sentinel.start();
    poll();
    candidates.delete('a');
    poll(); // no candidates at all — must not throw, nothing stalls

    expect(stalled).toEqual([]);
  });

  it('stop() prevents any further ticks', () => {
    const { sentinel, add, stalled, poll } = setup();
    const card = add('a', false);

    sentinel.start();
    poll();
    sentinel.stop();

    card.paused = true;
    poll(STALL_SENTINEL_CONFIRM_TICKS);

    expect(stalled).toEqual([]);
  });
});
