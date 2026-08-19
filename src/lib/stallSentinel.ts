/**
 * Always-on stall detector for api-mode Twitch embeds.
 *
 * Why this exists: every recovery path in playbackRecovery.ts is *triggered*
 * — add/remove, reorder, headers, view-mode, chat, focus-exit, story-preview,
 * overlay. A pause from a cause none of those anticipated (an unrelated
 * resize, a browser/OS-level suspend, anything not yet identified) has no
 * trigger to run under, and previously sat until the 90s watchdog
 * (main.ts's WATCHDOG_INTERVAL_MS) or a lucky mouse movement. This module
 * polls continuously instead, so an unexplained stall gets the same bounded
 * play()-only recovery as a triggered one, in seconds rather than up to 90s.
 *
 * It is not a replacement for the watchdog: it never escalates past play()
 * (no setChannel(), no remount), so a player broken in a way play() cannot
 * fix is still the watchdog's job, on the watchdog's own schedule.
 *
 * Three invariants, mirroring playbackRecovery.ts's own (see that file's
 * module doc comment) — this module would defeat their purpose otherwise:
 *
 * 1. **Only acts on a transition it observed itself.** A card is only ever
 *    a candidate for action once this sentinel has read isPaused() === false
 *    for it at least once. A stream that was already paused when the
 *    sentinel started — or when a card is first added — is never a target
 *    for its first flip; it can only become one after being seen playing.
 * 2. **Acts only on a positive paused reading**, the same false/true/null
 *    convention as RecoveryTarget.isPaused() — null (unreadable) never
 *    counts as a transition in either direction.
 * 3. **Never overrides a real user pause.** If the card's `engagedAt()`
 *    (the parent-side click-into-iframe signal — see
 *    StreamGrid.ts's bindPlaybackRecovery) is at or after the last tick this
 *    id was confirmed playing, the pause is the user's, not a stall, and is
 *    left alone.
 *
 * On top of that: a per-id cooldown keeps a genuinely dead stream from being
 * re-triggered every single tick, and a stampede guard backs off entirely
 * when a large share of the currently-playing set flips in the same tick —
 * that pattern is bandwidth/system-wide, not a handful of individually stuck
 * players, and is what the layout circuit breaker and 90s watchdog already
 * exist to handle.
 */

export interface StallCandidate {
  readonly id: string;
  /** true = paused, false = playing, null = unreadable (the read threw). */
  isPaused(): boolean | null;
  /** Epoch ms of the last user engagement with this card, or 0 if none. */
  engagedAt(): number;
}

/** Injected so tests can drive ticks on a virtual clock without a real timer. */
export interface StallSentinelTimers {
  setInterval(handler: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

export type StallSentinelEvent = 'stall' | 'user-paused' | 'stampede-skip' | 'cooldown-skip' | 'pending-skip';

export type StallSentinelLog = (event: StallSentinelEvent, detail: Record<string, unknown>) => void;

/** How often the sentinel reads every candidate's isPaused(). */
export const STALL_SENTINEL_POLL_MS = 5000;

/** Minimum gap between two sentinel-triggered recoveries for the same id. */
export const STALL_SENTINEL_COOLDOWN_MS = 20_000;

/**
 * If at least this share of the previously-playing set flips to paused in
 * the same tick (with at least STALL_SENTINEL_STAMPEDE_MIN of them playing
 * beforehand), treat it as systemic and act on none of them — the circuit
 * breaker and 90s watchdog own that case, not a per-card play() nudge.
 */
export const STALL_SENTINEL_STAMPEDE_RATIO = 0.5;
export const STALL_SENTINEL_STAMPEDE_MIN = 2;

export interface StallSentinel {
  start(): void;
  stop(): void;
  /** Test-only: run one tick synchronously, bypassing the timer. */
  tick(): void;
}

export function createStallSentinel(options: {
  timers: StallSentinelTimers;
  now(): number;
  /** Candidates to read this tick. Caller filters to whatever it considers eligible for automatic action. */
  listCandidates(): readonly StallCandidate[];
  /** True if a recovery run (any kind) is already tracking this id — never pile on top of it. */
  isPending(id: string): boolean;
  /** Called for exactly one id per unexplained playing->paused transition that clears every gate. */
  onStall(id: string): void;
  /**
   * Checked first, before listCandidates() is even called. Returning false
   * skips the tick entirely — including bookkeeping — so a background tab or
   * an active quiet-layout window (see main.ts's suppressLayout) simply
   * freezes every id's latch rather than forgetting it: the next real tick
   * picks up exactly where the last one left off, instead of needing to
   * observe every card playing again from scratch.
   */
  shouldRun?(): boolean;
  pollMs?: number;
  cooldownMs?: number;
  stampedeRatio?: number;
  log?: StallSentinelLog;
}): StallSentinel {
  const { timers } = options;
  const pollMs = options.pollMs ?? STALL_SENTINEL_POLL_MS;
  const cooldownMs = options.cooldownMs ?? STALL_SENTINEL_COOLDOWN_MS;
  const stampedeRatio = options.stampedeRatio ?? STALL_SENTINEL_STAMPEDE_RATIO;
  const log: StallSentinelLog = options.log ?? (() => {});

  /** Last tick (epoch ms) each id was confirmed playing (isPaused() === false). */
  const lastPlayingAt = new Map<string, number>();
  /** Latch: was this id confirmed playing as of the previous tick? */
  const wasPlaying = new Map<string, boolean>();
  /** Last tick (epoch ms) this id was actually handed to onStall(). */
  const lastActionAt = new Map<string, number>();

  let handle = 0;

  function forget(id: string): void {
    lastPlayingAt.delete(id);
    wasPlaying.delete(id);
    lastActionAt.delete(id);
  }

  function tick(): void {
    if (options.shouldRun && !options.shouldRun()) return;

    const at = options.now();
    const candidates = options.listCandidates();
    const seen = new Set<string>();

    let playingBeforeCount = 0;
    const flippedIds: string[] = [];

    for (const candidate of candidates) {
      seen.add(candidate.id);
      const previouslyPlaying = wasPlaying.get(candidate.id) === true;
      if (previouslyPlaying) playingBeforeCount += 1;

      const paused = candidate.isPaused();
      if (paused === null) continue; // unreadable — latch unchanged, never a transition either way

      if (paused === false) {
        wasPlaying.set(candidate.id, true);
        lastPlayingAt.set(candidate.id, at);
        continue;
      }

      // paused === true
      wasPlaying.set(candidate.id, false);
      if (!previouslyPlaying) continue; // never seen playing (or already known paused) — not a transition

      const engagedAt = candidate.engagedAt();
      const since = lastPlayingAt.get(candidate.id) ?? 0;
      if (engagedAt >= since) {
        // The parent-side click-into-iframe signal landed after the last
        // confirmed-playing read: this pause is the user's, not a stall.
        log('user-paused', { id: candidate.id, at, engagedAt, since });
        continue;
      }

      flippedIds.push(candidate.id);
    }

    // Drop bookkeeping for ids no longer offered — cards that were removed,
    // rebuilt, or fell out of the eligible set. Prevents unbounded growth
    // and stale cooldowns outliving the card they belonged to.
    for (const id of [...wasPlaying.keys()]) {
      if (!seen.has(id)) forget(id);
    }

    if (flippedIds.length === 0) return;

    if (
      playingBeforeCount >= STALL_SENTINEL_STAMPEDE_MIN &&
      flippedIds.length / playingBeforeCount >= stampedeRatio
    ) {
      log('stampede-skip', { flipped: flippedIds, playingBeforeCount });
      return;
    }

    for (const id of flippedIds) {
      if (options.isPending(id)) {
        log('pending-skip', { id, at });
        continue;
      }
      // -Infinity, not 0: an id that has never been acted on before must
      // never be mistaken for one that was "just" acted on at t=0 — that
      // collision would silently swallow the very first action for any id
      // whose first stall lands within cooldownMs of sentinel startup.
      const last = lastActionAt.get(id) ?? -Infinity;
      if (at - last < cooldownMs) {
        log('cooldown-skip', { id, at, last });
        continue;
      }
      lastActionAt.set(id, at);
      log('stall', { id, at });
      options.onStall(id);
    }
  }

  return {
    start() {
      if (handle) return;
      handle = timers.setInterval(tick, pollMs);
    },
    stop() {
      if (!handle) return;
      timers.clearInterval(handle);
      handle = 0;
    },
    tick,
  };
}
