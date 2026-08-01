import type { PlatformAdapter } from '../types';

/**
 * A YouTube stream's identity is encoded entirely in StreamRef.channel as a
 * compact, self-describing token — the same philosophy Twitch/Kick already
 * use (their `channel` field *is* the whole identity). No extra field on
 * StreamRef, no duplicated state: everything else (video ID, handle,
 * resolution type) is derived from the token on demand via parseYouTubeToken.
 *
 *   video:{videoId}      — direct video/Shorts/live/youtu.be URL, resolved locally
 *   handle:{handle}       — @handle or /@handle URL (stored without the @)
 *   user:{username}       — legacy /user/name or /c/name URL (forUsername)
 *   channelid:{UC...}     — /channel/UC... URL, or explicit y:channelid: prefix
 *
 * Only `handle`/`user`/`channelid` tokens require a network call (the PHP
 * resolver, see platforms/youtubeResolver.ts) — and only at mount time, not
 * at parse time. `video` tokens never touch the network.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HANDLE_RE = /^[A-Za-z0-9._-]{1,100}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{10,40}$/;

const YOUTUBE_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
];

export type YouTubeParsedToken =
  | { resolutionType: 'video'; videoId: string }
  | { resolutionType: 'channel'; kind: 'handle'; handle: string }
  | { resolutionType: 'channel'; kind: 'username'; username: string }
  | { resolutionType: 'channel'; kind: 'channelId'; channelId: string };

function videoToken(videoId: string): string | null {
  if (!VIDEO_ID_RE.test(videoId)) return null;
  return `video:${videoId}`;
}

function handleToken(raw: string): string | null {
  const handle = raw.replace(/^@/, '').toLowerCase();
  if (!HANDLE_RE.test(handle)) return null;
  return `handle:${handle}`;
}

function userToken(raw: string): string | null {
  const username = raw.toLowerCase();
  if (!USERNAME_RE.test(username)) return null;
  return `user:${username}`;
}

function channelIdToken(raw: string): string | null {
  if (!CHANNEL_ID_RE.test(raw)) return null;
  return `channelid:${raw}`;
}

/** Decompose a YouTube StreamRef.channel token back into its structured shape. */
export function parseYouTubeToken(channel: string): YouTubeParsedToken | null {
  const match = channel.match(/^(video|handle|user|channelid):(.+)$/);
  if (!match) return null;
  const [, kind, value] = match;

  switch (kind) {
    case 'video':
      return VIDEO_ID_RE.test(value) ? { resolutionType: 'video', videoId: value } : null;
    case 'handle':
      return HANDLE_RE.test(value) ? { resolutionType: 'channel', kind: 'handle', handle: value } : null;
    case 'user':
      return USERNAME_RE.test(value)
        ? { resolutionType: 'channel', kind: 'username', username: value }
        : null;
    case 'channelid':
      return CHANNEL_ID_RE.test(value)
        ? { resolutionType: 'channel', kind: 'channelId', channelId: value }
        : null;
    default:
      return null;
  }
}

function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase();
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

function parseFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.startsWith('http') ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = hostnameOf(url);

  if (host === 'youtu.be') {
    const [videoId] = pathSegments(url);
    return videoId ? videoToken(videoId) : null;
  }

  if (!YOUTUBE_HOSTS.includes(host)) return null;

  const segments = pathSegments(url);
  const [first, second] = segments;

  if (url.pathname === '/watch' || first === 'watch') {
    const v = url.searchParams.get('v');
    return v ? videoToken(v) : null;
  }

  if (!first) return null;

  if (first === 'live' || first === 'shorts' || first === 'embed') {
    return second ? videoToken(second) : null;
  }

  if (first.startsWith('@')) {
    return handleToken(first);
  }

  if (first === 'channel') {
    return second ? channelIdToken(second) : null;
  }

  if (first === 'c' || first === 'user') {
    return second ? userToken(second) : null;
  }

  return null;
}

/** Explicit `y:`/`yt:`/`youtube:` prefix — canonical grammar `y:{subtype}:{value}`. */
function parseFromExplicitPrefix(value: string): string | null {
  const match = value.match(/^(?:youtube|yt|y):(.+)$/i);
  if (!match) return null;
  const rest = match[1];

  const subtype = rest.match(/^(video|handle|user|channelid):(.+)$/i);
  if (subtype) {
    const kind = subtype[1].toLowerCase();
    const val = subtype[2];
    if (kind === 'video') return videoToken(val);
    if (kind === 'handle') return handleToken(val);
    if (kind === 'user') return userToken(val);
    if (kind === 'channelid') return channelIdToken(val);
    return null;
  }

  // No subtype given (e.g. the toolbar's dropdown never emits this shape,
  // but a hand-typed `y:somename` should still resolve) — default to handle.
  return handleToken(rest);
}

/** Local-only parsing — never calls the network. Returns a composite token or null. */
export function parseYouTubeInput(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const explicit = parseFromExplicitPrefix(value);
  if (explicit) return explicit;

  if (/^https?:\/\//i.test(value) || value.includes('.')) {
    return parseFromUrl(value);
  }

  return null;
}

export const youtubeAdapter: PlatformAdapter = {
  id: 'youtube',
  label: 'YouTube',

  parseInput(input: string) {
    const token = parseYouTubeInput(input);
    if (!token) return null;
    return { platform: 'youtube', channel: token };
  },

  buildEmbedUrl(ref, opts) {
    const parsed = parseYouTubeToken(ref.channel);
    if (!parsed || parsed.resolutionType !== 'video') {
      // Channel-type refs are resolved and mounted directly by StreamGrid via
      // the YouTube IFrame Player API — they never reach this generic path.
      return '';
    }

    const params = new URLSearchParams({
      autoplay: opts.autoplay === true ? '1' : '0',
      mute: opts.muted ? '1' : '0',
      playsinline: '1',
      modestbranding: '1',
      rel: '0',
      enablejsapi: '1',
    });
    if (opts.origin) {
      params.set('origin', opts.origin);
    }
    return `https://www.youtube.com/embed/${encodeURIComponent(parsed.videoId)}?${params.toString()}`;
  },

  displayName(ref) {
    const parsed = parseYouTubeToken(ref.channel);
    if (!parsed) return ref.channel;
    if (parsed.resolutionType === 'video') return parsed.videoId;
    if (parsed.kind === 'handle') return `@${parsed.handle}`;
    if (parsed.kind === 'username') return parsed.username;
    return parsed.channelId;
  },
};
