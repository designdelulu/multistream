import type { PlatformAdapter } from '../types';

/**
 * Experimental TikTok LIVE support — NOT an official TikTok integration.
 *
 * This adapter resolves a public TikTok LIVE URL by calling an external
 * resolver (see resolveTikTokLive below) that hits the same unauthenticated
 * endpoint TikTok's own web client and Streamlink's `tiktok` plugin use
 * (`api-live/user/room`) — not a documented TikTok API. See
 * docs/TIKTOK-LIVE-PROTOTYPE-REPORT.md for the full research writeup and
 * risk discussion, and docs/TIKTOK.md for why there is still no *official*
 * TikTok LIVE embed to build against instead.
 *
 * Structurally different from every other adapter here: Twitch/Kick/YouTube
 * all build a synchronous iframe `src` via buildEmbedUrl. TikTok has no
 * iframe at all — playback is a plain `<video>` element fed by mpegts.js
 * after an async resolve step. buildEmbedUrl exists only to satisfy
 * PlatformAdapter; it is never called for TikTok (see the platform === 'tiktok'
 * branches in components/StreamGrid.ts, which mount TikTok before any
 * adapter.buildEmbedUrl call would be reached).
 *
 * Input support is intentionally narrower than "any username-like string":
 * only full tiktok.com URLs are accepted, not a bare `@handle` or bare
 * `handle`. Reason — parseStreamInput (platforms/index.ts) tries adapters in
 * order and Twitch already claims almost any bare alphanumeric string
 * (including one with a leading `@`, which twitchAdapter strips) as a
 * channel name. Twitch's bare-username fallback is a documented existing
 * invariant other adapters aren't allowed to break — so a bare handle typed
 * for TikTok would silently resolve as a Twitch channel instead, never
 * reaching this adapter. A full tiktok.com URL has an unambiguous host, so
 * it's the only input form that can be accepted safely without touching
 * Twitch's existing priority.
 */

const TIKTOK_HOST_RE = /^(?:www\.)?tiktok\.com$/i;
const TIKTOK_HANDLE_RE = /^[a-zA-Z0-9_.]{1,64}$/;

/**
 * Returns the creator handle for a LIVE-eligible TikTok URL, or null.
 * Accepts `tiktok.com/@handle` (profile — treated as "watch this creator's
 * live") and `tiktok.com/@handle/live`. Explicitly rejects everything else
 * under the domain, most importantly `/video/{id}` — a published-video URL
 * must never be misclassified as a LIVE stream.
 */
function parseTikTokLiveUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.startsWith('http') ? value : `https://${value}`);
  } catch {
    return null;
  }

  if (!TIKTOK_HOST_RE.test(url.hostname)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (!first || !first.startsWith('@')) return null;

  const handle = first.slice(1);
  if (!TIKTOK_HANDLE_RE.test(handle)) return null;

  if (segments.length === 1) return handle; // profile URL — .../@handle
  if (segments.length === 2 && segments[1].toLowerCase() === 'live') return handle; // .../@handle/live

  return null; // /video/{id}, /photo/{id}, or anything else — not a LIVE URL
}

export const tiktokAdapter: PlatformAdapter = {
  id: 'tiktok',
  label: 'TikTok',

  parseInput(input: string) {
    const value = input.trim();
    if (!value) return null;
    // Cheap pre-filter before the URL parse — also documents that bare
    // handles are deliberately out of scope (see module doc comment).
    if (!/tiktok\.com/i.test(value)) return null;

    const handle = parseTikTokLiveUrl(value);
    if (!handle) return null;

    return { platform: 'tiktok', channel: handle.toLowerCase() };
  },

  // Intentionally unused for TikTok — see module doc comment. Returns an
  // inert value rather than throwing, so a future generic call site fails
  // safe (a broken-looking blank tile) rather than crashing card creation
  // for every other stream on the grid.
  buildEmbedUrl() {
    return 'about:blank';
  },

  displayName(ref) {
    return ref.channel;
  },
};

// ---------------------------------------------------------------------------
// Resolver client
// ---------------------------------------------------------------------------

/**
 * Not deployed anywhere yet (see docs/TIKTOK-LIVE-PROTOTYPE-REPORT.md §12).
 * Empty by default so a build with no resolver configured fails clearly
 * ('not_configured' state) instead of attempting a network call to nowhere.
 * Set VITE_TIKTOK_RESOLVER_URL in a local .env.local (gitignored) for local
 * dev/testing against dev/tiktok-resolver/resolver.mjs or an equivalent
 * locally-run instance.
 */
export const TIKTOK_RESOLVER_URL: string =
  (import.meta.env.VITE_TIKTOK_RESOLVER_URL as string | undefined)?.trim() || '';

export type TikTokResolveState =
  | 'live'
  | 'offline'
  | 'invalid_creator'
  | 'no_stream_data'
  | 'no_playable_streams'
  | 'provider_error'
  | 'network_error'
  | 'upstream_http_error'
  | 'resolver_http_error'
  | 'not_configured';

export interface TikTokQuality {
  id: string;
  protocol: string;
  url: string;
}

export interface TikTokResolveResult {
  live: boolean;
  state: TikTokResolveState;
  username: string;
  title?: string | null;
  qualities: TikTokQuality[];
  expiresAt: string | null;
  error?: string;
}

/** User-facing text for every non-live state — never lumps distinct causes into a single "offline" message. */
export function describeTikTokState(state: TikTokResolveState): string {
  switch (state) {
    case 'offline':
      return 'This creator is not live right now.';
    case 'invalid_creator':
      return "This TikTok creator couldn't be found.";
    case 'no_stream_data':
    case 'no_playable_streams':
      return 'TikTok is not exposing a playable stream for this creator right now.';
    case 'provider_error':
      return 'TikTok returned an unexpected response.';
    case 'network_error':
    case 'upstream_http_error':
    case 'resolver_http_error':
      return "Couldn't reach the TikTok resolver.";
    case 'not_configured':
      return 'Experimental TikTok LIVE support has no resolver configured.';
    default:
      return 'TikTok LIVE is unavailable right now.';
  }
}

/**
 * Calls the resolver's POST /resolve — see
 * dev/tiktok-resolver/resolver.mjs for the reference
 * implementation this expects to be running. Never throws for a reachable-
 * but-unsuccessful resolve (offline, invalid creator, etc.) — those come
 * back as a normal { live: false, state } result. Only network-level
 * failures (resolver unreachable, non-JSON response) are caught and mapped
 * to a result too, so callers never need a try/catch of their own.
 */
export async function resolveTikTokLive(
  username: string,
  signal?: AbortSignal,
): Promise<TikTokResolveResult> {
  if (!TIKTOK_RESOLVER_URL) {
    return { live: false, state: 'not_configured', username, qualities: [], expiresAt: null };
  }

  let res: Response;
  try {
    res = await fetch(`${TIKTOK_RESOLVER_URL.replace(/\/$/, '')}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://www.tiktok.com/@${username}/live` }),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return {
      live: false,
      state: 'network_error',
      username,
      qualities: [],
      expiresAt: null,
      error: String(err),
    };
  }

  if (!res.ok) {
    return {
      live: false,
      state: 'resolver_http_error',
      username,
      qualities: [],
      expiresAt: null,
      error: `HTTP ${res.status}`,
    };
  }

  try {
    const data = (await res.json()) as TikTokResolveResult;
    return data;
  } catch {
    return {
      live: false,
      state: 'provider_error',
      username,
      qualities: [],
      expiresAt: null,
      error: 'unparseable_resolver_response',
    };
  }
}
