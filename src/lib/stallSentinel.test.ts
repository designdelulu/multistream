import { describe, expect, it } from 'vitest';
import {
  STALL_SENTINEL_POLL_MS,
  createStallSentinel,
  type StallCandidate,
  type StallSentinelEvent,
  type StallSentinelTimers,
} from './stallSentinel';

/**
 * Same virtual-clock approach as playbackRecovery.test.ts: these tests pin
 * the sentinel's decision logic (what counts as an unexplained stall, and
 * what must never trigger one) against a fake candidate on a fake interval
 * timer. They say nothing about whether Twitch actually resumes.
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
}

function setup(options?: { cooldownMs?: number; stampedeRatio?: number }) {
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
    cooldownMs: options?.cooldownMs,
    stampedeRatio: options?.stampedeRatio,
    log: (event, detail) => events.push({ event, detail }),
  });

  return {
    timers,
    sentinel,
    candidates,
    pending,
    stalled,
    events,
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
    const { sentinel, add, stalled, timers } = setup();
    add('a', true); // already paused on the very first tick this sentinel sees it

    sentinel.start();
    timers.advanceTicks(5);

    expect(stalled).toEqual([]);
  });

  it('triggers exactly once on a genuine playing -> paused transition', () => {
    const { sentinel, add, stalled, timers, advance } = setup();
    const card = add('a', false);

    sentinel.start();
    timers.advanceTicks(1); // observes playing, latches it

    card.paused = true;
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1); // observes the flip

    expect(stalled).toEqual(['a']);
  });

  it('a stream that was never confirmed playing (paused on the very first tick) is never started', () => {
    const { sentinel, add, stalled, timers, advance } = setup();
    add('a', true);

    sentinel.start();
    for (let i = 0; i < 5; i += 1) {
      advance(STALL_SENTINEL_POLL_MS);
      timers.advanceTicks(1);
    }

    expect(stalled).toEqual([]);
  });

  it('paused -> paused inside the cooldown window triggers nothing further', () => {
    const { sentinel, add, stalled, timers, advance } = setup();
    const card = add('a', false);

    sentinel.start();
    timers.advanceTicks(1);
    card.paused = true;
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);
    expect(stalled).toEqual(['a']);

    // Still paused, well inside the cooldown — must not re-trigger.
    card.paused = false; // briefly read as playing so the latch can flip again
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);
    card.paused = true;
    advance(1000); // still << STALL_SENTINEL_COOLDOWN_MS
    timers.advanceTicks(1);

    expect(stalled).toEqual(['a']);
  });

  it('re-triggers for the same id once the cooldown has elapsed', () => {
    const { sentinel, add, stalled, timers, advance } = setup({ cooldownMs: 1000 });
    const card = add('a', false);

    sentinel.start();
    timers.advanceTicks(1);
    card.paused = true;
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);
    expect(stalled).toEqual(['a']);

    card.paused = false;
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);
    card.paused = true;
    advance(2000); // > cooldownMs
    timers.advanceTicks(1);

    expect(stalled).toEqual(['a', 'a']);
  });

  it('a null (unreadable) reading is never treated as a transition in either direction', () => {
    const { sentinel, add, stalled, timers, advance } = setup();
    const card = add('a', false);

    sentinel.start();
    timers.advanceTicks(1); // latched playing

    card.paused = null; // isPaused() threw
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);
    expect(stalled).toEqual([]);

    // The playing latch must still be intact after the null read —
    // paused=true now must still read as a genuine transition.
    card.paused = true;
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);
    expect(stalled).toEqual(['a']);
  });

  it('never disturbs an id a recovery run is already pending for', () => {
    const { sentinel, add, pending, stalled, timers, advance } = setup();
    const card = add('a', false);

    sentinel.start();
    timers.advanceTicks(1);
    card.paused = true;
    pending.add('a');
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);

    expect(stalled).toEqual([]);
  });

  it('a pause whose engagedAt() is at or after the last confirmed-playing tick is left alone (user-paused)', () => {
    const { sentinel, add, stalled, timers, advance } = setup();
    const card = add('a', false);

    sentinel.start();
    timers.advanceTicks(1); // confirmed playing at t=0

    advance(STALL_SENTINEL_POLL_MS);
    card.paused = true;
    card.engaged = STALL_SENTINEL_POLL_MS; // user clicked in right as/after it paused
    timers.advanceTicks(1);

    expect(stalled).toEqual([]);
  });

  it('a stale engagement from before the last confirmed-playing tick does not suppress a later genuine stall', () => {
    const { sentinel, add, stalled, timers, advance } = setup();
    const card = add('a', false);
    card.engaged = -1000; // engaged once, long before any of this

    sentinel.start();
    timers.advanceTicks(1); // confirmed playing after the old engagement
    card.paused = true;
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);

    expect(stalled).toEqual(['a']);
  });

  it('the stampede guard suppresses action when most of the playing set flips at once', () => {
    const { sentinel, add, stalled, timers, advance } = setup({ stampedeRatio: 0.5 });
    const a = add('a', false);
    const b = add('b', false);
    const c = add('c', false);

    sentinel.start();
    timers.advanceTicks(1); // all three latched playing

    a.paused = true;
    b.paused = true;
    c.paused = true;
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);

    expect(stalled).toEqual([]);
  });

  it('does not suppress a single genuine stall when the rest of the set stays healthy', () => {
    const { sentinel, add, stalled, timers, advance } = setup({ stampedeRatio: 0.5 });
    const a = add('a', false);
    add('b', false);
    add('c', false);

    sentinel.start();
    timers.advanceTicks(1);

    a.paused = true; // only one of three flips
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1);

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

    sentinel.start();
    timers.advanceTicks(1); // confirmed playing at t=0

    quiet = true;
    card.paused = true;
    now += STALL_SENTINEL_POLL_MS;
    timers.advanceTicks(1); // gated — must not forget the playing latch

    quiet = false;
    now += STALL_SENTINEL_POLL_MS;
    timers.advanceTicks(1); // resumes with the old latch intact — flip still detected

    expect(stalled).toEqual(['a']);
  });

  it('drops bookkeeping for ids no longer offered by listCandidates (removed cards)', () => {
    const { sentinel, add, candidates, stalled, timers, advance } = setup();
    add('a', false);

    sentinel.start();
    timers.advanceTicks(1);
    candidates.delete('a');
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1); // no candidates at all — must not throw, nothing stalls

    expect(stalled).toEqual([]);
  });

  it('stop() prevents any further ticks', () => {
    const { sentinel, add, stalled, timers, advance } = setup();
    const card = add('a', false);

    sentinel.start();
    timers.advanceTicks(1);
    sentinel.stop();

    card.paused = true;
    advance(STALL_SENTINEL_POLL_MS);
    timers.advanceTicks(1); // no-op: interval was cleared

    expect(stalled).toEqual([]);
  });
});
