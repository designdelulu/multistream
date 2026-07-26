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
  return `${ref.platform}:${ref.channel}`;
}

export function deserializeStream(token: string): Omit<StreamRef, 'id' | 'muted'> | null {
  const match = token.trim().match(/^(twitch|kick):([a-zA-Z0-9_-]+)$/i);
  if (!match) return null;

  const platform = match[1].toLowerCase() as Platform;
  const channel = match[2].toLowerCase();
  return { platform, channel };
}

export function buildEmbedUrl(
  ref: Pick<StreamRef, 'platform' | 'channel'>,
  muted: boolean,
): string {
  const adapter = getAdapter(ref.platform);
  return adapter.buildEmbedUrl(ref, {
    muted,
    parent: window.location.hostname,
  });
}
