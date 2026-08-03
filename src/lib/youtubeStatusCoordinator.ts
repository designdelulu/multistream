import type { YouTubeStatsResult } from '../platforms/youtubeStats';

/**
 * Diagnostics-only tag for why a refresh ran. Never changes behavior or
 * touches player/iframe state — see the module doc below.
 */
export type YouTubeStatsRefreshReason = 'initial-restore' | 'manual' | 'periodic' | 'visibility-resume';

export type YouTubeStatsRefreshOutcome = 'ok' | 'skipped-inflight' | 'skipped-empty';

export type YouTubeStatsRefreshResult =
  | { outcome: 'ok'; results: Map<string, YouTubeStatsResult> }
  | { outcome: 'skipped-inflight' | 'skipped-empty' };

/**
 * Coordinates the "refresh every YouTube card's stats" flow so only one
 * batched request is ever in flight at a time — the exact same shape as
 * createTwitchStatusCoordinator, kept as its own small module (rather than a
 * shared generic) because this codebase already keeps each platform's status
 * plumbing in its own file (twitch.ts/kick.ts/youtube.ts follow the same
 * pattern) and duplicating ~50 lines here is cheaper than risking a
 * regression in the already-shipped Twitch polling path.
 *
 * This coordinator only ever calls the injected `checkStats` (the batched
 * YouTube stats client) and the injected `onResult` (DOM meta updates). It
 * has no knowledge of, and no dependency on, players, iframes, or embed
 * lifecycle — nothing here can affect playback.
 */
export function createYouTubeStatusCoordinator(deps: {
  checkStats: (videoIds: string[]) => Promise<Map<string, YouTubeStatsResult>>;
  onResult: (results: Map<string, YouTubeStatsResult>, reason: YouTubeStatsRefreshReason) => void;
}) {
  let inFlight = false;
  let sequence = 0;
  let lastCheckAt: number | null = null;

  function normalizeIds(videoIds: string[]): string[] {
    const seen = new Set<string>();
    for (const raw of videoIds) {
      const normalized = raw.trim();
      if (normalized) seen.add(normalized);
    }
    return [...seen];
  }

  async function refresh(
    videoIds: string[],
    reason: YouTubeStatsRefreshReason,
  ): Promise<YouTubeStatsRefreshResult> {
    if (inFlight) return { outcome: 'skipped-inflight' };

    const wanted = normalizeIds(videoIds);
    if (wanted.length === 0) return { outcome: 'skipped-empty' };

    inFlight = true;
    const mySequence = ++sequence;

    try {
      const results = await deps.checkStats(wanted);
      // Defense in depth: the `inFlight` gate above already makes concurrent
      // coordinator requests impossible, so this can never actually fire
      // today. Kept anyway so a future relaxation of that gate can't silently
      // let a stale response overwrite a newer one.
      if (mySequence !== sequence) return { outcome: 'skipped-inflight' };
      lastCheckAt = Date.now();
      deps.onResult(results, reason);
      return { outcome: 'ok', results };
    } finally {
      inFlight = false;
    }
  }

  return {
    refresh,
    isInFlight: () => inFlight,
    getLastCheckAt: () => lastCheckAt,
  };
}

export type YouTubeStatusCoordinator = ReturnType<typeof createYouTubeStatusCoordinator>;
