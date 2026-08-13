export { twitchAdapter } from './twitch';
export { kickAdapter } from './kick';
export { youtubeAdapter } from './youtube';
export { tiktokAdapter } from './tiktok';

import { kickAdapter } from './kick';
import { TIKTOK_LIVE_ENABLED, tiktokAdapter } from './tiktok';
import { twitchAdapter } from './twitch';
import { parseYouTubeToken, youtubeAdapter } from './youtube';
import type { Platform, PlatformAdapter, StreamRef } from '../types';

// Order matters for bare, unprefixed input: Twitch claims plain usernames
// first (existing behavior), Kick only via prefix/URL, YouTube appended last
// and only ever matches an explicit y:/yt:/youtube: prefix or a full URL —
// it has no bare-username fallback, so this order change cannot alter what
// Twitch or Kick already claimed. TikTok appended last too, and only ever
// matches a full tiktok.com URL (see tiktok.ts's module doc comment for why
// it deliberately has no bare-handle fallback) — same non-interference
// guarantee as YouTube's.
const adapters: PlatformAdapter[] = [twitchAdapter, kickAdapter, youtubeAdapter, tiktokAdapter];

export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = adapters.find((item) => item.id === platform);
  if (!adapter) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return adapter;
}

export function parseStreamInput(input: string): Omit<StreamRef, 'id' | 'muted' | 'orientation'> | null {
  const value = input.trim();
  if (!value) return null;

  for (const adapter of adapters) {
    const parsed = adapter.parseInput(value);
    if (parsed) return parsed;
  }

  return null;
}

function prefixForPlatform(platform: Platform): string {
  if (platform === 'twitch') return 't';
  if (platform === 'kick') return 'k';
  if (platform === 'tiktok') return 'tt';
  return 'y';
}

export function serializeStream(ref: Pick<StreamRef, 'platform' | 'channel'>): string {
  return `${prefixForPlatform(ref.platform)}:${ref.channel}`;
}

export function deserializeStream(token: string): Omit<StreamRef, 'id' | 'muted' | 'orientation'> | null {
  const value = decodeURIComponent(token.trim());
  if (!value) return null;

  // YouTube's payload is itself a compound `{subtype}:{value}` token, so it
  // needs its own branch rather than the twitch/kick single-segment regex.
  const youtube = value.match(/^y:(.+)$/i);
  if (youtube) {
    const parsed = parseYouTubeToken(youtube[1]);
    if (!parsed) return null;
    return { platform: 'youtube', channel: youtube[1] };
  }

  // Own two-letter prefix (not [tk]) — TikTok handles may contain '.', which
  // the twitch/kick short-form regex below doesn't allow, and 'tt' can't
  // collide with the single-letter t/k prefixes.
  const tiktok = value.match(/^tt:([a-zA-Z0-9_.]{1,64})$/i);
  if (tiktok && TIKTOK_LIVE_ENABLED) {
    return { platform: 'tiktok', channel: tiktok[1].toLowerCase() };
  }

  const short = value.match(/^([tk]):([a-zA-Z0-9_-]+)$/i);
  if (short) {
    const platform: Platform = short[1].toLowerCase() === 't' ? 'twitch' : 'kick';
    return { platform, channel: short[2].toLowerCase() };
  }

  const legacy = value.match(/^(twitch|kick):([a-zA-Z0-9_-]+)$/i);
  if (legacy) {
    const platform = legacy[1].toLowerCase() as Platform;
    return { platform, channel: legacy[2].toLowerCase() };
  }

  return null;
}

export function buildEmbedUrl(
  ref: Pick<StreamRef, 'platform' | 'channel'>,
  muted: boolean,
  options?: { autoplay?: boolean },
): string {
  const adapter = getAdapter(ref.platform);
  return adapter.buildEmbedUrl(ref, {
    muted,
    parent: window.location.hostname,
    autoplay: options?.autoplay,
    origin: window.location.origin,
  });
}

export function buildChatEmbedUrl(ref: Pick<StreamRef, 'platform' | 'channel'>): string | null {
  const adapter = getAdapter(ref.platform);
  if (!adapter.buildChatEmbedUrl) return null;
  return adapter.buildChatEmbedUrl(ref, {
    muted: true,
    parent: window.location.hostname,
  });
}

export function streamsFromPathname(pathname: string): Omit<StreamRef, 'id' | 'muted' | 'orientation'>[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => deserializeStream(segment))
    .filter((item): item is Omit<StreamRef, 'id' | 'muted' | 'orientation'> => item !== null);
}

export function streamsFromSearch(search: string): Omit<StreamRef, 'id' | 'muted' | 'orientation'>[] {
  const raw = new URLSearchParams(search).get('streams');
  if (!raw) return [];

  return raw
    .split(',')
    .map((token) => deserializeStream(token))
    .filter((item): item is Omit<StreamRef, 'id' | 'muted' | 'orientation'> => item !== null);
}

export function buildPathFromStreams(streams: Pick<StreamRef, 'platform' | 'channel'>[]): string {
  if (streams.length === 0) return '/';
  return `/${streams.map((stream) => serializeStream(stream)).join('/')}`;
}
