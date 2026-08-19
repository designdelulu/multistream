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
 * ---
 *
 * **The reason this file is more paranoid than it looks like it needs to be.**
 *
 * `isPaused()` is not a reliable one-shot answer. Twitch reports paused
 * during transient non-play states too — a mid-stream rebuffer, a source or
 * quality switch, an ad transition — and the difference between those and a
 * real stall is not visible in any single reading (the same limitation
 * snapshotPlayingTwitchPlayers documents in StreamGrid.ts). Acting on one
 * `true` means calling play() on a player that was merely buffering, which
 * re-seeks it to the live edge: a visible restart with Twitch's own loading
 * overlay sitting on top of a stream that would have recovered by itself.
 *
 * Every other recovery path in this app is either triggered by a real user
 * action or confirms before acting — the 90s watchdog re-reads after
 * STALL_CONFIRM_DELAY_MS and only runs every 90s. A 5s always-on poll gets
 * roughly 18x more chances to be wrong, so it needs a correspondingly
 * stronger gate, not the same one.
 *
 * Hence two independent confirmations, either of which alone is enough to
 * veto action:
 *
 * - **Progress**: a playing player's `position()` advances between ticks; a
 *   genuinely paused one's is frozen. This is ground truth about whether
 *   frames are moving, which `isPaused()` does not give us, and it overrides
 *   a `true` reading outright.
 * - **Persistence**: a stall must be confirmed on STALL_SENTINEL_CONFIRM_TICKS
 *   consecutive polls before anything happens. Buffering and ad transitions
 *   resolve inside that window; a real stall does not.
 *
 * ---
 *
 * Three invariants, mirroring playbackRecovery.ts's own (see that file's
 * module doc comment) — this module would defeat their purpose otherwise:
 *
 * 1. **Only acts on a stream it observed playing itself.** A card becomes a
 *    candidate for action only after this sentinel has confirmed it playing
 *    at least once. A stream already paused when the sentinel started — or
 *    when a card is first added — can never be started by it.
 * 2. **Acts only on a positive paused reading**, the same false/true/null
 *    convention as RecoveryTarget.isPaused() — null (unreadable) is not
 *    evidence in either direction and neither advances nor resets a streak.
 * 3. **Never overrides a real user pause.** If the card's `engagedAt()`
 *    (the parent-side click-into-iframe signal — see StreamGrid.ts's
 *    bindPlaybackRecovery) is at or after the last tick this id was confirmed
 *    playing, the pause is the user's, not a stall, and is left alone.
 *
 * On top of that: a per-id cooldown keeps a genuinely dead stream from being
 * re-triggered every tick, and a stampede guard backs off entirely when a
 * large share of the managed set stalls together — that pattern is
 * bandwidth/system-wide, not a handful of individually stuck players, and is
 * what the layout circuit breaker and 90s watchdog already exist to handle.
 */

export interface StallCandidate {
  readonly id: string;
  /** true = paused, false = playing, null = unreadable (the read threw). */
  isPaused(): boolean | null;
  /** Epoch ms of the last user engagement with this card, or 0 if none. */
  engagedAt(): number;
  /**
   * Current playback position in seconds (Twitch's getCurrentTime), or null
   * if unreadable. Optional: without it the sentinel still works, just with
   * persistence as its only confirmation instead of two.
   */
  position?(): number | null;
}

/** Injected so tests can drive ticks on a virtual clock without a real timer. */
export interface StallSentinelTimers {
  setInterval(handler: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

export type StallSentinelEvent =
  | 'stall'
  | 'user-paused'
  | 'stampede-skip'
  | 'cooldown-skip'
  | 'pending-skip'
  | 'progress-veto';

export type StallSentinelLog = (event: StallSentinelEvent, detail: Record<string, unknown>) => void;

/** How often the sentinel reads every candidate. */
export const STALL_SENTINEL_POLL_MS = 5000;

/**
 * Consecutive paused polls required before a stall is acted on. At the
 * default poll rate this is ~15s of uninterrupted, position-frozen pause —
 * long enough that ordinary rebuffering and ad transitions have resolved on
 * their own, short enough to stay far ahead of the 90s watchdog.
 */
export const STALL_SENTINEL_CONFIRM_TICKS = 3;

/**
 * Minimum position advance (seconds of media time) counted as real progress.
 * Guards against float jitter in getCurrentTime; a genuinely playing stream
 * advances by roughly the poll interval, orders of magnitude above this.
 */
export const STALL_SENTINEL_PROGRESS_EPSILON_S = 0.1;

/**
 * Minimum gap between two sentinel-triggered recoveries for the same id.
 * Deliberately longer than the confirm window: if the first bounded play()
 * did not take, a second one seconds later will not either, and the watchdog
 * owns the heavier escalation anyway.
 */
export const STALL_SENTINEL_COOLDOWN_MS = 60_000;

/**
 * If at least this share of the managed set (every id ever confirmed playing,
 * given at least STALL_SENTINEL_STAMPEDE_MIN of them) has a stall confirmed
 * on the same tick, treat it as systemic and act on none of them — the
 * circuit breaker and 90s watchdog own that case, not a per-card play().
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
  /** Called for exactly one id per confirmed, unexplained stall that clears every gate. */
  onStall(id: string): void;
  /**
   * Checked first, before listCandidates() is even called. Returning false
   * skips the tick entirely — including bookkeeping — so a background tab or
   * an active quiet-layout window (see main.ts's suppressLayout) simply
   * freezes every id's state rather than forgetting it: the next real tick
   * picks up exactly where the last one left off, instead of needing to
   * observe every card playing again from scratch. A frozen streak is also
   * why a quiet window can never itself push an id over the threshold.
   */
  shouldRun?(): boolean;
  pollMs?: number;
  confirmTicks?: number;
  cooldownMs?: number;
  stampedeRatio?: number;
  log?: StallSentinelLog;
}): StallSentinel {
  const { timers } = options;
  const pollMs = options.pollMs ?? STALL_SENTINEL_POLL_MS;
  const confirmTicks = options.confirmTicks ?? STALL_SENTINEL_CONFIRM_TICKS;
  const cooldownMs = options.cooldownMs ?? STALL_SENTINEL_COOLDOWN_MS;
  const stampedeRatio = options.stampedeRatio ?? STALL_SENTINEL_STAMPEDE_RATIO;
  const log: StallSentinelLog = options.log ?? (() => {});

  /** Ids this sentinel has confirmed playing at least once. Invariant 1. */
  const everPlaying = new Set<string>();
  /** Last tick (epoch ms) each id was confirmed playing. */
  const lastPlayingAt = new Map<string, number>();
  /** Consecutive polls each id has read paused, with no progress, since last confirmed playing. */
  const pausedStreak = new Map<string, number>();
  /** Last playback position (seconds) read for each id. */
  const lastPosition = new Map<string, number>();
  /** Last tick (epoch ms) this id was actually handed to onStall(). */
  const lastActionAt = new Map<string, number>();

  let handle = 0;

  function forget(id: string): void {
    everPlaying.delete(id);
    lastPlayingAt.delete(id);
    pausedStreak.delete(id);
    lastPosition.delete(id);
    lastActionAt.delete(id);
  }

  /** Confirmed alive: reset the streak and re-arm invariant 1 for this id. */
  function markPlaying(id: string, at: number): void {
    everPlaying.add(id);
    lastPlayingAt.set(id, at);
    pausedStreak.delete(id);
  }

  function tick(): void {
    if (options.shouldRun && !options.shouldRun()) return;

    const at = options.now();
    const candidates = options.listCandidates();
    const seen = new Set<string>();

    let managedCount = 0;
    const confirmedIds: string[] = [];

    for (const candidate of candidates) {
      const id = candidate.id;
      seen.add(id);

      // Stampede denominator: every id this sentinel has ever confirmed
      // playing, whether or not it is mid-stall right now. Counting only the
      // currently-healthy ones would shrink the denominator as a systemic
      // outage progressed — by the tick a simultaneous stall was confirmed,
      // every affected id would have been excluded from its own comparison
      // and the guard could never fire on the case it exists for.
      if (everPlaying.has(id)) managedCount += 1;

      const position = candidate.position?.() ?? null;
      const previousPosition = lastPosition.get(id);
      const advanced =
        position !== null &&
        previousPosition !== undefined &&
        position - previousPosition > STALL_SENTINEL_PROGRESS_EPSILON_S;
      if (position !== null) lastPosition.set(id, position);

      const paused = candidate.isPaused();

      if (advanced) {
        // Frames are moving. Whatever isPaused() claims, this player is alive
        // — the buffering/ad-transition false positive this whole module
        // exists to avoid.
        if (paused === true) log('progress-veto', { id, at, position, previousPosition });
        markPlaying(id, at);
        continue;
      }

      if (paused === null) continue; // unreadable — not evidence either way, streak untouched

      if (paused === false) {
        markPlaying(id, at);
        continue;
      }

      // paused === true, and position did not advance.
      if (!everPlaying.has(id)) continue; // never observed playing — invariant 1

      const engagedAt = candidate.engagedAt();
      const since = lastPlayingAt.get(id) ?? 0;
      if (engagedAt >= since) {
        // The parent-side click-into-iframe signal landed after the last
        // confirmed-playing read: this pause is the user's, not a stall.
        // Does not advance the streak, so it can never accumulate into one.
        log('user-paused', { id, at, engagedAt, since });
        continue;
      }

      const streak = (pausedStreak.get(id) ?? 0) + 1;
      pausedStreak.set(id, streak);
      if (streak >= confirmTicks) confirmedIds.push(id);
    }

    // Drop bookkeeping for ids no longer offered — cards that were removed,
    // rebuilt, or fell out of the eligible set. Prevents unbounded growth and
    // stale cooldowns outliving the card they belonged to. Swept across every
    // map rather than just everPlaying: a card can be read (and so recorded
    // in lastPosition) without ever being confirmed playing.
    const tracked = new Set([
      ...everPlaying,
      ...lastPlayingAt.keys(),
      ...pausedStreak.keys(),
      ...lastPosition.keys(),
      ...lastActionAt.keys(),
    ]);
    for (const id of tracked) {
      if (!seen.has(id)) forget(id);
    }

    if (confirmedIds.length === 0) return;

    if (
      managedCount >= STALL_SENTINEL_STAMPEDE_MIN &&
      confirmedIds.length / managedCount >= stampedeRatio
    ) {
      log('stampede-skip', { confirmed: confirmedIds, managedCount });
      return;
    }

    for (const id of confirmedIds) {
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
      log('stall', { id, at, streak: pausedStreak.get(id) });
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
