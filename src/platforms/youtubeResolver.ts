/**
 * Client for the server-side YouTube channel/live resolver
 * (public/api/youtube-resolve.php). Only handle/username/channelId lookups
 * ever call this — direct video URLs are parsed locally in youtube.ts and
 * never reach the network. See docs/PLAYBACK_STABILITY.md-style reasoning:
 * this module has no retry/recovery logic of its own — one request per
 * call, caller decides if/when to retry (manual reload only).
 */

export type YouTubeResolveMode = 'handle' | 'username' | 'channelId';

export interface YouTubeLiveResult {
  status: 'live';
  videoId: string;
  title?: string;
  channelId: string;
  channelTitle?: string;
  /** From a best-effort liveStreamingDetails follow-up — absent if that call failed, live but not yet reporting a count, or genuinely unavailable. */
  viewerCount?: number | null;
  startedAt?: string | null;
}

export interface YouTubeOfflineResult {
  status: 'offline';
  channelId?: string;
}

export type YouTubeErrorCode =
  | 'invalid_input'
  | 'channel_not_found'
  | 'quota_exceeded'
  | 'api_error'
  | 'config_missing'
  | 'resolver_unreachable'
  | 'network_error';

export interface YouTubeErrorResult {
  status: 'error';
  code: YouTubeErrorCode;
  message: string;
}

export type YouTubeResolveResult = YouTubeLiveResult | YouTubeOfflineResult | YouTubeErrorResult;

const RESOLVER_ENDPOINT = '/api/youtube-resolve.php';

function isResolveResult(value: unknown): value is YouTubeResolveResult {
  if (!value || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  return status === 'live' || status === 'offline' || status === 'error';
}

/**
 * Resolve a channel/handle/username to its currently-live video, if any.
 * Always resolves (never throws) except when `signal` aborts — callers that
 * pass an AbortController and abort it (e.g. the card was removed while this
 * was in flight) get a rejected promise with an AbortError, by design, so
 * they can tell "cancelled" apart from "resolved to an error".
 */
export async function resolveYouTubeChannelLive(
  mode: YouTubeResolveMode,
  value: string,
  signal?: AbortSignal,
): Promise<YouTubeResolveResult> {
  let response: Response;
  try {
    const params = new URLSearchParams({ mode, value });
    response = await fetch(`${RESOLVER_ENDPOINT}?${params.toString()}`, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return {
      status: 'error',
      code: 'resolver_unreachable',
      message: "Couldn't reach the stream lookup service.",
    };
  }

  if (!response.ok) {
    return {
      status: 'error',
      code: 'resolver_unreachable',
      message: "Couldn't reach the stream lookup service.",
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      status: 'error',
      code: 'resolver_unreachable',
      message: "Couldn't reach the stream lookup service.",
    };
  }

  if (!isResolveResult(data)) {
    return {
      status: 'error',
      code: 'resolver_unreachable',
      message: "Couldn't reach the stream lookup service.",
    };
  }

  return data;
}
