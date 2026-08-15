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
    // Official Kick embed API (help.kick.com, re-verified 2026-08-15): query
    // params only — muted, autoplay, allowfullscreen. No JS player object,
    // no documented postMessage mute/volume protocol. Changing muted after
    // mount requires reassigning iframe src (a full reload). Prefer muted
    // embeds in the grid. Focus mode may remount unmuted after a user click.
    // Do not cache-bust — remounts make Kick likelier to restore a remembered
    // unmuted volume when muted=true is ignored.
    const autoplay = opts.autoplay ?? true;
    const params = new URLSearchParams({
      muted: opts.muted ? 'true' : 'false',
      autoplay: autoplay ? 'true' : 'false',
      playsinline: 'true',
    });
    if (opts.parent) {
      params.set('parent', opts.parent);
    }
    return `https://player.kick.com/${encodeURIComponent(ref.channel)}?${params.toString()}`;
  },

  displayName(ref) {
    return ref.channel;
  },
};
