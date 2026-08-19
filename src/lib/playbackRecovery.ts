/**
 * Bounded playback recovery for add/remove transactions.
 *
 * Why this exists: adding or removing a stream resizes every surviving player
 * (updateGridLayout rewrites --player-width/--player-height for the whole
 * grid). Twitch reacts to that resize by pausing some embeds — asynchronously,
 * hundreds of milliseconds after the layout has already settled. Nothing was
 * checking api-mode players afterwards, so a paused card sat there until the
 * user happened to hover it (the toolbar's transitionend check) or the 90s
 * watchdog came round.
 *
 * Three properties this module is built around, each a direct response to a
 * past failure in this codebase:
 *
 * 1. **Only ever acts on a player that was observed playing beforehand.** The
 *    caller supplies the target list; a stream that was already stopped is not
 *    in it and can never be started by this code. `180f12e` shipped a detector
 *    that classified healthy streams as stuck and rebuilt all of them on a
 *    loop — the structural fix is that "should be playing" is an observation
 *    taken before the mutation, not a predicate evaluated afterwards.
 * 2. **Bounded.** A run is a fixed list of passes and then it is over. There
 *    is no rescheduling-on-failure path, so no run can outlive its transaction.
 * 3. **Acts only on a positive paused reading.** `isPaused()` returning true is
 *    the only thing that triggers play(). An exception (`null`) means unknown,
 *    never "confirmed playing" and never "confirmed paused".
 *
 * Timing is per-target and independent, so a slow player cannot delay another,
 * and a newly-added card can be tracked on its own schedule while a
 * transaction run for the surviving cards is still in flight.
 */

/** One player the caller believes should be playing right now. */
export interface RecoveryTarget {
  readonly id: string;
  /**
   * true = paused, false = playing, null = unreadable (the call threw).
   *
   * Twitch counts buffering and seeking as playing, so `false` is a weak
   * "fine" and `true` is a strong "genuinely stopped" — which is why `true` is
   * the only value that triggers an action.
   */
  isPaused(): boolean | null;
  /**
   * Whether acting on this target is still appropriate: card still mounted,
   * not frozen, not focused, and not being driven by the user. Re-checked
   * before every pass, because all of those can change mid-run.
   */
  isEligible(): boolean;
  play(): void;
  /**
   * Optional last resort after the bounded play() schedule is exhausted
   * still-paused/unreadable. StreamGrid uses this to invoke the same
   * per-card reload the manual Refresh button uses. Absent in tests that
   * only care about play() scheduling.
   */
  escalate?: () => void;
}

/** Injected so tests can drive runs on a virtual clock. */
export interface RecoveryTimers {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export type RecoveryEvent =
  | 'begin'
  | 'track'
  | 'check'
  | 'play'
  | 'success'
  | 'blocked'
  | 'skip'
  | 'exhausted'
  | 'cancel';

export type RecoveryLog = (event: RecoveryEvent, detail: Record<string, unknown>) => void;

/**
 * Passes are spaced to straddle the window in which Twitch actually pauses
 * after a resize. Pass 0 runs once layout has settled and usually reads
 * healthy — Twitch has not reacted yet. The pause, when it comes, lands
 * somewhere in the next second or two, which is why a single immediate check
 * cannot work and why the tail extends past main.ts's 2000ms quietLayout
 * window (a pause caused by late layout thrash still gets one look).
 */
export const RECOVERY_RETRY_OFFSETS_MS: readonly number[] = [0, 750, 1500, 3000];

/**
 * A newly added card is expected to autoplay on its own, so its first check
 * waits — calling play() on a player that was about to start anyway just makes
 * Twitch flash its loading overlay for nothing.
 */
export const NEW_PLAYER_RETRY_OFFSETS_MS: readonly number[] = [1500, 3000, 5000];

/**
 * Gap after the final play() before the observe-only pass that decides success
 * or exhaustion. Long enough for a play() that worked to have produced a
 * readable playing state.
 */
export const CONFIRM_TAIL_MS = 1000;

export interface PlaybackRecovery {
  /**
   * Start a transaction run: cancels every run in flight (the previous
   * transaction's conclusions are stale the moment the grid changes again),
   * then schedules one independent run per target.
   */
  begin(targets: readonly RecoveryTarget[], cause: string): void;
  /** Start a run for a single target without disturbing runs already in flight. */
  track(target: RecoveryTarget, cause: string, offsets?: readonly number[]): void;
  /**
   * Start a bounded run for one target following a headers-hidden toolbar
   * height transition (open or close). Uses the same default schedule as
   * `begin`. Supersedes only a previous hover run for the same id — an
   * in-flight 'transaction' or 'new-player' run for that id is left alone,
   * since a real grid mutation or a freshly mounted card's own autoplay
   * check both outrank a hover-triggered resize.
   */
  hover(target: RecoveryTarget, cause: string): void;
  /**
   * Start bounded runs for the exact pre-focus set of Twitch players after
   * focus mode exits. Supersedes a stale 'toolbar-hover' (or prior
   * 'focus-exit') run for the same id — a resize caused by leaving focus mode
   * always outranks a leftover hover check — but never disturbs an in-flight
   * 'transaction' or 'new-player' run for that id, the same rule `hover`
   * already enforces in the other direction.
   */
  focusExit(targets: readonly RecoveryTarget[], cause: string): void;
  /**
   * Start bounded runs for the exact set of Twitch players an on-screen
   * overlay (add-stream suggestions, share menu, party menu) is currently
   * covering. Same supersede rule as focusExit: never disturbs an in-flight
   * 'transaction' or 'new-player' run for that id, but does supersede a
   * stale 'toolbar-hover', 'focus-exit', or prior 'overlay' run — the menu
   * can open/close/reopen many times (once per keystroke) while the grid
   * itself never changes, so each edge just restarts the same bounded watch.
   */
  overlay(targets: readonly RecoveryTarget[], cause: string): void;
  /** A real PLAYING event arrived — positive confirmation, stop chasing this id. */
  confirmPlaying(id: string): void;
  /**
   * Browser autoplay policy refused playback (PLAYBACK_BLOCKED). Retrying
   * play() cannot fix that, so the run ends and the caller reports it as its
   * own outcome rather than escalating to a remount.
   */
  markBlocked(id: string): void;
  cancel(reason: string): void;
  /** Ids with a run still in flight. Test/diagnostic surface. */
  pendingIds(): string[];
}

interface Pass {
  readonly at: number;
  /** Action passes may call play(); the final pass only observes. */
  readonly act: boolean;
}

/**
 * 'transaction' runs belong to one add/remove and are invalidated by the next
 * one. 'new-player' runs belong to a single freshly mounted card and are not —
 * that card's "did autoplay take?" question is unrelated to what the grid does
 * next, and the run that answers it is usually started by a READY event that
 * lands mid-transaction. Cancelling those together would mean a stream added
 * during another change silently loses its only autoplay check.
 */
type RunKind = 'transaction' | 'new-player' | 'toolbar-hover' | 'focus-exit' | 'overlay';

interface Run {
  readonly target: RecoveryTarget;
  readonly cause: string;
  readonly kind: RunKind;
  readonly passes: readonly Pass[];
  index: number;
  handle: number;
  plays: number;
}

function buildPasses(offsets: readonly number[], confirmTailMs: number): Pass[] {
  const passes: Pass[] = offsets.map((at) => ({ at, act: true }));
  const last = offsets.length > 0 ? offsets[offsets.length - 1] : 0;
  passes.push({ at: last + confirmTailMs, act: false });
  return passes;
}

export function createPlaybackRecovery(options: {
  timers: RecoveryTimers;
  log?: RecoveryLog;
  offsets?: readonly number[];
  newPlayerOffsets?: readonly number[];
  confirmTailMs?: number;
}): PlaybackRecovery {
  const { timers } = options;
  const log: RecoveryLog = options.log ?? (() => {});
  const defaultOffsets = options.offsets ?? RECOVERY_RETRY_OFFSETS_MS;
  const newPlayerOffsets = options.newPlayerOffsets ?? NEW_PLAYER_RETRY_OFFSETS_MS;
  const confirmTailMs = options.confirmTailMs ?? CONFIRM_TAIL_MS;

  const runs = new Map<string, Run>();

  function stop(id: string): void {
    const run = runs.get(id);
    if (!run) return;
    timers.clearTimeout(run.handle);
    runs.delete(id);
  }

  function finish(id: string, event: RecoveryEvent, detail: Record<string, unknown>): void {
    const run = runs.get(id);
    stop(id);
    log(event, { id, cause: run?.cause, plays: run?.plays ?? 0, ...detail });
    if (
      event === 'exhausted' &&
      (detail.reason === 'still-paused' ||
        detail.reason === 'unreadable' ||
        detail.reason === 'passes-consumed')
    ) {
      run?.target.escalate?.();
    }
  }

  function schedule(run: Run): void {
    const pass = run.passes[run.index];
    const previous = run.index === 0 ? 0 : run.passes[run.index - 1].at;
    run.handle = timers.setTimeout(() => runPass(run.target.id), pass.at - previous);
  }

  function runPass(id: string): void {
    const run = runs.get(id);
    if (!run) return;

    const pass = run.passes[run.index];
    const { target } = run;

    if (!target.isEligible()) {
      finish(id, 'skip', { at: pass.at, reason: 'ineligible' });
      return;
    }

    const paused = target.isPaused();
    log('check', { id, cause: run.cause, at: pass.at, paused, act: pass.act });

    if (paused === false && run.plays > 0) {
      // A play() we issued took hold. Positive confirmation, stop here.
      finish(id, 'success', { at: pass.at, reason: 'play-confirmed' });
      return;
    }

    if (paused === false && !pass.act) {
      finish(id, 'success', { at: pass.at, reason: 'never-paused' });
      return;
    }

    /*
     * Reading healthy on an early pass is NOT a reason to stop watching, and
     * this is the whole point of having a schedule. Twitch pauses on a resize
     * asynchronously, typically after the layout has already settled — so pass
     * 0 nearly always reads healthy, and retiring the target there would mean
     * the later passes never ran for the exact case they exist to catch.
     * Keep watching until the final pass; a check that finds nothing wrong
     * costs one isPaused() call and never touches playback.
     */

    if (!pass.act) {
      // Final, observe-only pass: whatever is true now is the outcome.
      // `paused` is true or null here — false already returned above.
      finish(id, 'exhausted', {
        at: pass.at,
        reason: paused === null ? 'unreadable' : 'still-paused',
      });
      return;
    }

    if (paused === true) {
      run.plays += 1;
      log('play', {
        id,
        cause: run.cause,
        at: pass.at,
        attempt: run.plays,
        reason: 'paused-after-mutation',
      });
      target.play();
    }
    // paused === null is unknown, not paused, and never triggers a play(): a
    // player throwing while genuinely healthy would otherwise get replayed.

    run.index += 1;
    if (run.index >= run.passes.length) {
      finish(id, 'exhausted', { at: pass.at, reason: 'passes-consumed' });
      return;
    }
    schedule(run);
  }

  function start(
    target: RecoveryTarget,
    cause: string,
    kind: RunKind,
    offsets: readonly number[],
  ): void {
    stop(target.id);
    const run: Run = {
      target,
      cause,
      kind,
      passes: buildPasses(offsets, confirmTailMs),
      index: 0,
      handle: 0,
      plays: 0,
    };
    runs.set(target.id, run);
    schedule(run);
  }

  return {
    begin(targets, cause) {
      // A new transaction invalidates what the previous one was still waiting
      // to conclude — the grid it measured no longer exists. New-player runs
      // survive: they are about one card's own autoplay, not about the grid.
      for (const [id, run] of [...runs]) {
        if (run.kind !== 'transaction') continue;
        finish(id, 'cancel', { reason: `superseded-by-${cause}` });
      }
      log('begin', { cause, targets: targets.map((target) => target.id) });
      for (const target of targets) {
        // A card that already has its own new-player watch keeps it rather
        // than being restarted on the transaction's earlier schedule.
        if (runs.get(target.id)?.kind === 'new-player') continue;
        start(target, cause, 'transaction', defaultOffsets);
      }
    },

    track(target, cause, offsets) {
      log('track', { id: target.id, cause });
      start(target, cause, 'new-player', offsets ?? newPlayerOffsets);
    },

    hover(target, cause) {
      // Never disturb a real grid mutation or a fresh card's own autoplay
      // check — only ever supersede a previous hover run for this same id.
      const existing = runs.get(target.id);
      if (existing && existing.kind !== 'toolbar-hover') return;
      log('track', { id: target.id, cause });
      start(target, cause, 'toolbar-hover', defaultOffsets);
    },

    focusExit(targets, cause) {
      // Mirrors hover()'s rule in the other direction: a real grid mutation
      // or a fresh card's own autoplay check is left alone, but a stale
      // toolbar-hover (or leftover focus-exit) run for this same id never
      // gets to suppress the restoration this focus session owes it.
      for (const target of targets) {
        const existing = runs.get(target.id);
        if (existing && (existing.kind === 'transaction' || existing.kind === 'new-player')) {
          continue;
        }
        log('track', { id: target.id, cause });
        start(target, cause, 'focus-exit', defaultOffsets);
      }
    },

    overlay(targets, cause) {
      // Mirrors focusExit()'s rule: a real grid mutation or a fresh card's
      // own autoplay check is left alone, but a stale toolbar-hover,
      // focus-exit, or previous overlay run for this same id never gets to
      // suppress the play() this overlay edge owes it.
      for (const target of targets) {
        const existing = runs.get(target.id);
        if (existing && (existing.kind === 'transaction' || existing.kind === 'new-player')) {
          continue;
        }
        log('track', { id: target.id, cause });
        start(target, cause, 'overlay', defaultOffsets);
      }
    },

    confirmPlaying(id) {
      if (!runs.has(id)) return;
      finish(id, 'success', { reason: 'playing-event' });
    },

    markBlocked(id) {
      if (!runs.has(id)) return;
      finish(id, 'blocked', { reason: 'autoplay-policy' });
    },

    cancel(reason) {
      for (const id of [...runs.keys()]) {
        finish(id, 'cancel', { reason });
      }
    },

    pendingIds() {
      return [...runs.keys()];
    },
  };
}
