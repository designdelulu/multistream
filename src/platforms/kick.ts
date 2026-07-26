import type { PlatformAdapter } from '../types';

export const kickAdapter: PlatformAdapter = {
  id: 'kick',
  label: 'Kick',

  parseInput(input: string) {
    const value = input.trim().replace(/^@/, '');
    if (!value) return null;

    const explicit = value.match(/^(?:kick|k):([a-zA-Z0-9_-]+)$/i);
    if (explicit) {
      return { platform: 'kick', channel: explicit[1].toLowerCase() };
    }

    const kickHosts = ['kick.com', 'www.kick.com'];

    if (/^https?:\/\//i.test(value) || value.includes('.')) {
      try {
        const url = new URL(value.startsWith('http') ? value : `https://${value}`);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (!kickHosts.some((h) => host === h.replace(/^www\./, ''))) {
          return null;
        }
        const segment = url.pathname.split('/').filter(Boolean)[0];
        if (!segment) return null;
        return { platform: 'kick', channel: segment.toLowerCase() };
      } catch {
        return null;
      }
    }

    return null;
  },

  buildEmbedUrl(ref, opts) {
    // Official Kick embed params only: muted + autoplay.
    const params = new URLSearchParams({
      muted: String(opts.muted),
      autoplay: 'true',
    });
    return `https://player.kick.com/${encodeURIComponent(ref.channel)}?${params.toString()}`;
  },

  displayName(ref) {
    return ref.channel;
  },
};
