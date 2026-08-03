/**
 * Client for the server-side YouTube stats resolver (mode=stats on
 * public/api/youtube-resolve.php) — the periodic "viewer count + live
 * duration" refresh for videoIds already known to the frontend. Always
 * batched: one GET per call covering every videoId the caller passes in,
 * never one request per card. videos.list costs a flat 1 quota unit no
 * matter how many ids are packed into the request, so this never repeats
 * the 100-unit `search` call the initial channel resolve makes.
 *
 * Advisory only: never throws (except when `signal` aborts), and any
 * transport-level failure resolves to an empty Map — same convention as
 * checkTwitchStatus, so callers never need a separate "endpoint totally
 * unreachable" branch.
 */

export type YouTubeStatsValue = 'live' | 'ended' | 'not_found';

export interface YouTubeStatsResult {
  videoId: string;
  status: YouTubeStatsValue;
  viewerCount?: number | null;
  startedAt?: string | null;
  title?: string | null;
}

const STATS_ENDPOINT = '/api/youtube-resolve.php';
const STATS_VALUES: readonly YouTubeStatsValue[] = ['live', 'ended', 'not_found'];

function isYouTubeStatsResult(value: unknown): value is YouTubeStatsResult {
  if (!value || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  const videoId = (value as { videoId?: unknown }).videoId;
  return (
    typeof videoId === 'string' && typeof status === 'string' && (STATS_VALUES as string[]).includes(status)
  );
}

/**
 * Checks live status/viewer count/start time for a batch of YouTube
 * videoIds in one request. Resolved Map is keyed by videoId.
 */
export async function checkYouTubeStats(
  videoIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, YouTubeStatsResult>> {
  if (videoIds.length === 0) return new Map();

  let response: Response;
  try {
    const params = new URLSearchParams({ mode: 'stats', ids: videoIds.join(',') });
    response = await fetch(`${STATS_ENDPOINT}?${params.toString()}`, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return new Map();
  }

  if (!response.ok) {
    return new Map();
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return new Map();
  }

  if (
    !data ||
    typeof data !== 'object' ||
    (data as { status?: unknown }).status !== 'ok' ||
    !Array.isArray((data as { results?: unknown }).results)
  ) {
    return new Map();
  }

  const results = (data as { results: unknown[] }).results;
  const map = new Map<string, YouTubeStatsResult>();
  for (const entry of results) {
    if (!isYouTubeStatsResult(entry)) continue;
    map.set(entry.videoId, entry);
  }
  return map;
}
