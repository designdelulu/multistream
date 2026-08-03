/**
 * Shared YouTube stats polling scheduler — one interval for the whole
 * application, never one per card. Same shape and same cadence as
 * createTwitchStatusScheduler (kept as its own module for the reasons
 * documented in youtubeStatusCoordinator.ts). DOM/store-agnostic and fully
 * injectable (timers, clock, visibility/online checks) so it's
 * unit-testable on a virtual clock.
 *
 * This module never imports anything player/iframe-related. It only ever
 * decides *when* to call the injected `run` callback — what that callback
 * does (batched stats fetch + meta update) lives entirely outside this file.
 */

/** Same cadence as Twitch's own poll — see TWITCH_STATUS_POLL_INTERVAL_MS. */
export const YOUTUBE_STATS_POLL_INTERVAL_MS = 3 * 60 * 1000;

export type YouTubeStatsSchedulerReason = 'periodic' | 'visibility-resume';
export type YouTubeStatsSchedulerRunOutcome = 'ok' | 'skipped-inflight' | 'skipped-empty';

export function createYouTubeStatusScheduler(deps: {
  intervalMs: number;
  hasYouTubeCards: () => boolean;
  isHidden: () => boolean;
  isOnline: () => boolean;
  run: (reason: YouTubeStatsSchedulerReason) => Promise<YouTubeStatsSchedulerRunOutcome>;
  now: () => number;
  setInterval: (handler: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
}) {
  let handle: number | null = null;
  let lastRunAt: number | null = null;

  function tick(): void {
    if (deps.isHidden() || !deps.isOnline() || !deps.hasYouTubeCards()) return;
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

  /** Refresh once, only if the previous check is older than the normal interval — never a burst. */
  function notifyVisible(): void {
    if (deps.isHidden() || !deps.isOnline() || !deps.hasYouTubeCards()) return;
    if (lastRunAt !== null && deps.now() - lastRunAt < deps.intervalMs) return;
    void deps.run('visibility-resume').then((outcome) => {
      if (outcome === 'ok') lastRunAt = deps.now();
    });
  }

  return { start, stop, isRunning, notifyVisible };
}

export type YouTubeStatusScheduler = ReturnType<typeof createYouTubeStatusScheduler>;
