/**
 * Client for the server-side Twitch channel existence/live-status resolver
 * (public/api/twitch-status.php). Always batched — one POST per call,
 * covering every channel the caller passes in, never one request per card.
 *
 * This is advisory only: never throws (except when `signal` aborts), and
 * any transport-level failure (network error, non-OK response, malformed
 * JSON) resolves to a Map where every requested channel maps to
 * `status: 'unavailable'` — so callers never need a separate "endpoint
 * totally unreachable" branch from "server returned some unavailable
 * entries". No retry/backoff logic here — same convention as
 * youtubeResolver.ts, the caller decides if/when to retry.
 */

export type TwitchStatusValue = 'live' | 'offline' | 'not_found' | 'unavailable' | 'invalid_input';

interface TwitchStatusResultBase {
  input: string;
  normalized: string;
}

export interface TwitchLiveResult extends TwitchStatusResultBase {
  status: 'live';
  displayName?: string;
  title?: string;
  category?: string;
  viewerCount?: number;
  startedAt?: string;
  thumbnailUrl?: string;
}

export interface TwitchOfflineResult extends TwitchStatusResultBase {
  status: 'offline';
  displayName?: string;
}

export interface TwitchNotFoundResult extends TwitchStatusResultBase {
  status: 'not_found';
}

export interface TwitchUnavailableResult extends TwitchStatusResultBase {
  status: 'unavailable';
}

export interface TwitchInvalidInputResult extends TwitchStatusResultBase {
  status: 'invalid_input';
}

export type TwitchStatusResult =
  | TwitchLiveResult
  | TwitchOfflineResult
  | TwitchNotFoundResult
  | TwitchUnavailableResult
  | TwitchInvalidInputResult;

const STATUS_ENDPOINT = '/api/twitch-status.php';
const STATUS_VALUES: readonly TwitchStatusValue[] = [
  'live',
  'offline',
  'not_found',
  'unavailable',
  'invalid_input',
];

function isTwitchStatusResult(value: unknown): value is TwitchStatusResult {
  if (!value || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  const input = (value as { input?: unknown }).input;
  const normalized = (value as { normalized?: unknown }).normalized;
  return (
    typeof status === 'string' &&
    (STATUS_VALUES as string[]).includes(status) &&
    typeof input === 'string' &&
    typeof normalized === 'string'
  );
}

function unavailableMap(channels: string[]): Map<string, TwitchStatusResult> {
  const map = new Map<string, TwitchStatusResult>();
  for (const channel of channels) {
    map.set(channel, { status: 'unavailable', input: channel, normalized: channel });
  }
  return map;
}

/**
 * Checks existence/live-status for a batch of Twitch logins in one request.
 * Resolved Map is keyed by each result's normalized login (which for the
 * already-lowercased logins this app always passes in is the same string).
 */
export async function checkTwitchStatus(
  channels: string[],
  signal?: AbortSignal,
): Promise<Map<string, TwitchStatusResult>> {
  if (channels.length === 0) return new Map();

  let response: Response;
  try {
    response = await fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'twitch', channels }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return unavailableMap(channels);
  }

  if (!response.ok) {
    return unavailableMap(channels);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return unavailableMap(channels);
  }

  if (
    !data ||
    typeof data !== 'object' ||
    (data as { platform?: unknown }).platform !== 'twitch' ||
    !Array.isArray((data as { results?: unknown }).results)
  ) {
    return unavailableMap(channels);
  }

  const results = (data as { results: unknown[] }).results;
  const map = new Map<string, TwitchStatusResult>();
  for (const entry of results) {
    if (!isTwitchStatusResult(entry)) continue;
    map.set(entry.normalized, entry);
  }
  return map;
}
