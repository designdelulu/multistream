/**
 * Client for the server-side Kick channel live-status/metadata resolver
 * (public/api/kick-status.php). Always batched — one POST per call, covering
 * every channel the caller passes in, never one request per card.
 *
 * Same advisory contract as twitchStatus.ts: never throws (except when
 * `signal` aborts), and any transport-level failure (network error, non-OK
 * response, malformed JSON) resolves to a Map where every requested channel
 * maps to `status: 'unavailable'`. Kick playback never depends on any of
 * this — the embed is a plain iframe that mounts regardless.
 *
 * `not_configured` is Kick-specific and deliberately distinct from
 * `unavailable`: it means the server has no Kick app credentials installed
 * yet, which is a setup state rather than a failure. Callers render it the
 * same way they render "no metadata" — no dot, no meta text — but it stays
 * separable in logs so a real outage is never mistaken for a missing config.
 */

export type KickStatusValue =
  | 'live'
  | 'offline'
  | 'not_found'
  | 'unavailable'
  | 'not_configured'
  | 'invalid_input';

interface KickStatusResultBase {
  input: string;
  normalized: string;
}

export interface KickLiveResult extends KickStatusResultBase {
  status: 'live';
  displayName?: string;
  title?: string;
  category?: string;
  viewerCount?: number;
  startedAt?: string;
  avatarUrl?: string;
}

export interface KickOfflineResult extends KickStatusResultBase {
  status: 'offline';
  displayName?: string;
  avatarUrl?: string;
}

export interface KickNotFoundResult extends KickStatusResultBase {
  status: 'not_found';
}

export interface KickUnavailableResult extends KickStatusResultBase {
  status: 'unavailable';
}

export interface KickNotConfiguredResult extends KickStatusResultBase {
  status: 'not_configured';
}

export interface KickInvalidInputResult extends KickStatusResultBase {
  status: 'invalid_input';
}

export type KickStatusResult =
  | KickLiveResult
  | KickOfflineResult
  | KickNotFoundResult
  | KickUnavailableResult
  | KickNotConfiguredResult
  | KickInvalidInputResult;

const STATUS_ENDPOINT = '/api/kick-status.php';
const STATUS_VALUES: readonly KickStatusValue[] = [
  'live',
  'offline',
  'not_found',
  'unavailable',
  'not_configured',
  'invalid_input',
];

function isKickStatusResult(value: unknown): value is KickStatusResult {
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

function unavailableMap(channels: string[]): Map<string, KickStatusResult> {
  const map = new Map<string, KickStatusResult>();
  for (const channel of channels) {
    map.set(channel, { status: 'unavailable', input: channel, normalized: channel });
  }
  return map;
}

/**
 * Checks live status + metadata for a batch of Kick slugs in one request.
 * Resolved Map is keyed by each result's normalized slug (which for the
 * already-lowercased slugs this app always passes in is the same string).
 */
export async function checkKickStatus(
  channels: string[],
  signal?: AbortSignal,
): Promise<Map<string, KickStatusResult>> {
  if (channels.length === 0) return new Map();

  let response: Response;
  try {
    response = await fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'kick', channels }),
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
    (data as { platform?: unknown }).platform !== 'kick' ||
    !Array.isArray((data as { results?: unknown }).results)
  ) {
    return unavailableMap(channels);
  }

  const results = (data as { results: unknown[] }).results;
  const map = new Map<string, KickStatusResult>();
  for (const entry of results) {
    if (!isKickStatusResult(entry)) continue;
    map.set(entry.normalized, entry);
  }
  return map;
}
