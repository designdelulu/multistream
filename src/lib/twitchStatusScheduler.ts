/**
 * Shared Twitch status polling scheduler — one interval for the whole
 * application, never one per card. DOM/store-agnostic and fully injectable
 * (timers, clock, visibility/online checks) so it's unit-testable on a
 * virtual clock, same style as src/lib/playbackRecovery.ts's RecoveryTimers.
 *
 * This module never imports anything player/iframe-related. It only ever
 * decides *when* to call the injected `run` callback — what that callback
 * does (batched status fetch + pill update) lives entirely outside this file.
 */

/** Named constant so the cadence can be tuned in one place. */
export const TWITCH_STATUS_POLL_INTERVAL_MS = 3 * 60 * 1000;

export type TwitchStatusSchedulerReason = 'periodic' | 'visibility-resume';
export type TwitchStatusSchedulerRunOutcome = 'ok' | 'skipped-inflight' | 'skipped-empty';

export function createTwitchStatusScheduler(deps: {
  intervalMs: number;
  hasTwitchCards: () => boolean;
  isHidden: () => boolean;
  isOnline: () => boolean;
  run: (reason: TwitchStatusSchedulerReason) => Promise<TwitchStatusSchedulerRunOutcome>;
  now: () => number;
  setInterval: (handler: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
}) {
  let handle: number | null = null;
  let lastRunAt: number | null = null;

  function tick(): void {
    if (deps.isHidden() || !deps.isOnline() || !deps.hasTwitchCards()) return;
    void deps.run('periodic').then((outcome) => {
      if (outcome === 'ok') lastRunAt = deps.now();
    });
  }

  function start(): void {
    if (handle !== null) return;
    handle = deps.setInterval(tick, deps.intervalMs);
  }

  function stop(): void {
    if (handle === null) return;
    deps.clearInterval(handle);
    handle = null;
  }

  function isRunning(): boolean {
    return handle !== null;
  }

  /** Restarts the interval clock so a tick doesn't fire moments later. Only call after a *successful* manual refresh. */
  function notifyManualRefresh(): void {
    lastRunAt = deps.now();
    if (handle === null) return;
    stop();
    start();
  }

  /** Refresh once, only if the previous check is older than the normal interval — never a burst. */
  function notifyVisible(): void {
    if (deps.isHidden() || !deps.isOnline() || !deps.hasTwitchCards()) return;
    if (lastRunAt !== null && deps.now() - lastRunAt < deps.intervalMs) return;
    void deps.run('visibility-resume').then((outcome) => {
      if (outcome === 'ok') lastRunAt = deps.now();
    });
  }

  return { start, stop, isRunning, notifyManualRefresh, notifyVisible };
}

export type TwitchStatusScheduler = ReturnType<typeof createTwitchStatusScheduler>;
