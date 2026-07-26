export { twitchAdapter } from './twitch';
export { kickAdapter } from './kick';

import { kickAdapter } from './kick';
import { twitchAdapter } from './twitch';
import type { Platform, PlatformAdapter, StreamRef } from '../types';

const adapters: PlatformAdapter[] = [twitchAdapter, kickAdapter];

export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = adapters.find((item) => item.id === platform);
  if (!adapter) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return adapter;
}

export function parseStreamInput(input: string): Omit<StreamRef, 'id' | 'muted'> | null {
  const value = input.trim();
  if (!value) return null;

  for (const adapter of adapters) {
    const parsed = adapter.parseInput(value);
    if (parsed) return parsed;
  }

  return null;
}

export function serializeStream(ref: Pick<StreamRef, 'platform' | 'channel'>): string {
  const prefix = ref.platform === 'twitch' ? 't' : 'k';
  return `${prefix}:${ref.channel}`;
}

export function deserializeStream(token: string): Omit<StreamRef, 'id' | 'muted'> | null {
  const value = decodeURIComponent(token.trim());
  if (!value) return null;

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

export function streamsFromPathname(pathname: string): Omit<StreamRef, 'id' | 'muted'>[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => deserializeStream(segment))
    .filter((item): item is Omit<StreamRef, 'id' | 'muted'> => item !== null);
}

export function streamsFromSearch(search: string): Omit<StreamRef, 'id' | 'muted'>[] {
  const raw = new URLSearchParams(search).get('streams');
  if (!raw) return [];

  return raw
    .split(',')
    .map((token) => deserializeStream(token))
    .filter((item): item is Omit<StreamRef, 'id' | 'muted'> => item !== null);
}

export function buildPathFromStreams(streams: Pick<StreamRef, 'platform' | 'channel'>[]): string {
  if (streams.length === 0) return '/';
  return `/${streams.map((stream) => serializeStream(stream)).join('/')}`;
}
