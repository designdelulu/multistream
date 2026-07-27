import type { PlatformAdapter } from '../types';

const TWITCH_HOSTS = ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'];

function normalizeInput(raw: string): string {
  return raw.trim().replace(/^@/, '');
}

function parseHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function channelFromPath(pathname: string): string | null {
  const segment = pathname.split('/').filter(Boolean)[0];
  if (!segment) return null;
  return segment.toLowerCase();
}

export const twitchAdapter: PlatformAdapter = {
  id: 'twitch',
  label: 'Twitch',

  parseInput(input: string) {
    const value = normalizeInput(input);
    if (!value) return null;

    const explicit = value.match(/^(?:twitch|t):([a-zA-Z0-9_]+)$/i);
    if (explicit) {
      return { platform: 'twitch', channel: explicit[1].toLowerCase() };
    }

    if (/^https?:\/\//i.test(value) || value.includes('.')) {
      try {
        const url = new URL(value.startsWith('http') ? value : `https://${value}`);
        const host = parseHostname(url);
        if (!TWITCH_HOSTS.some((h) => host === h.replace(/^www\./, ''))) {
          return null;
        }
        const channel = channelFromPath(url.pathname);
        if (!channel || channel === 'videos' || channel === 'directory') return null;
        return { platform: 'twitch', channel };
      } catch {
        return null;
      }
    }

    if (/^[a-zA-Z0-9_]{1,25}$/.test(value)) {
      return { platform: 'twitch', channel: value.toLowerCase() };
    }

    return null;
  },

  buildEmbedUrl(ref, opts) {
    const params = new URLSearchParams({
      channel: ref.channel,
      muted: String(opts.muted),
      // Helps some browsers start muted playback without a click-to-play overlay.
      playsinline: 'true',
    });
    if (opts.autoplay !== false) {
      params.set('autoplay', 'true');
    }
    params.append('parent', opts.parent);
    // Twitch requires an exact parent match; Vite may use localhost or 127.0.0.1.
    if (opts.parent === 'localhost' || opts.parent === '127.0.0.1') {
      params.append('parent', opts.parent === 'localhost' ? '127.0.0.1' : 'localhost');
    } else {
      params.append('parent', '127.0.0.1');
    }
    return `https://player.twitch.tv/?${params.toString()}`;
  },

  buildChatEmbedUrl(ref, opts) {
    const params = new URLSearchParams();
    params.append('parent', opts.parent);
    if (opts.parent !== 'localhost') {
      params.append('parent', '127.0.0.1');
    }
    return `https://www.twitch.tv/embed/${encodeURIComponent(ref.channel)}/chat?${params.toString()}`;
  },

  displayName(ref) {
    return ref.channel;
  },
};
