import {
  buildPathFromStreams,
  parseStreamInput,
  streamsFromPathname,
  streamsFromSearch,
} from '../platforms';
import type { Platform, StreamRef } from '../types';

type Listener = () => void;

const STORAGE_KEY = 'multistream:streams';

function createId(platform: string, channel: string): string {
  return `${platform}:${channel}`;
}

/**
 * Every restore path (URL path/query, localStorage) only ever carries
 * platform+channel — never the raw input string a user originally typed —
 * so a YouTube Shorts link loses its portrait hint on reload. That's a
 * deliberate, documented limitation (see StreamOrientation's doc comment in
 * types.ts): only a fresh addStream() call in the current session (which
 * still has the raw input) can detect it. TikTok doesn't have this problem —
 * every TikTok stream is LIVE and LIVE is always portrait, so orientation is
 * derivable from platform alone on every path, restore included.
 */
function toStreamRefs(items: Omit<StreamRef, 'id' | 'muted' | 'orientation'>[]): StreamRef[] {
  return items.map((item) => ({
    ...item,
    id: createId(item.platform, item.channel),
    muted: true,
    orientation: item.platform === 'tiktok' ? 'portrait' : 'landscape',
  }));
}

/** youtube.com/shorts/... and youtu.be-shorts links are always 9:16 by convention. */
const YOUTUBE_SHORTS_RE = /youtube\.com\/shorts\//i;

function detectOrientation(platform: Platform, rawInput: string): StreamRef['orientation'] {
  if (platform === 'tiktok') return 'portrait'; // TikTok LIVE is always portrait.
  return YOUTUBE_SHORTS_RE.test(rawInput) ? 'portrait' : 'landscape';
}

function loadFromStorage(): Omit<StreamRef, 'id' | 'muted' | 'orientation'>[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { platform: Platform; channel: string } =>
        Boolean(
          item &&
            typeof item === 'object' &&
            ((item as { platform?: string }).platform === 'twitch' ||
              (item as { platform?: string }).platform === 'kick' ||
              (item as { platform?: string }).platform === 'youtube' ||
              (item as { platform?: string }).platform === 'tiktok') &&
            typeof (item as { channel?: string }).channel === 'string',
        ),
    );
  } catch {
    return [];
  }
}

function persistStreams(streams: StreamRef[]): void {
  try {
    if (streams.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(streams.map(({ platform, channel }) => ({ platform, channel }))),
    );
  } catch {
    // Ignore storage failures.
  }
}

function loadInitialStreams(): StreamRef[] {
  const fromUrl = loadFromUrl();
  if (fromUrl.length > 0) return fromUrl;
  return toStreamRefs(loadFromStorage());
}

function loadFromUrl(): StreamRef[] {
  const fromPath = toStreamRefs(streamsFromPathname(window.location.pathname));
  if (fromPath.length > 0) return fromPath;

  return toStreamRefs(streamsFromSearch(window.location.search));
}

/**
 * Classify a store update from the previous id list to the next.
 * Reorder is a real grid mutation (cards move, Twitch can pause) and must
 * not be collapsed into "nothing changed" just because the id *set* is the
 * same — see main.ts renderStreams / beginAddRemoveRecovery.
 */
export function detectStreamListChange(
  previous: readonly string[],
  next: readonly string[],
): 'add' | 'remove' | 'reorder' | null {
  const previousSet = new Set(previous);
  const added = next.filter((id) => !previousSet.has(id)).length;
  const nextSet = new Set(next);
  const removed = previous.filter((id) => !nextSet.has(id)).length;

  if (added > 0 || removed > 0) return added >= removed ? 'add' : 'remove';
  if (previous.some((id, index) => id !== next[index])) return 'reorder';
  return null;
}

function dedupeStreams(streams: StreamRef[]): StreamRef[] {
  const seen = new Set<string>();
  return streams.filter((stream) => {
    if (seen.has(stream.id)) return false;
    seen.add(stream.id);
    return true;
  });
}

function syncUrl(streams: StreamRef[]): void {
  const next = buildPathFromStreams(streams);
  window.history.replaceState(null, '', next);
}

export function createStreamStore() {
  let streams = dedupeStreams(loadInitialStreams());
  const listeners = new Set<Listener>();

  syncUrl(streams);
  persistStreams(streams);

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function setStreams(next: StreamRef[]): void {
    streams = dedupeStreams(next);
    syncUrl(streams);
    persistStreams(streams);
    notify();
  }

  return {
    getStreams(): StreamRef[] {
      return streams;
    },

    addStream(input: string): boolean {
      const parsed = parseStreamInput(input);
      if (!parsed) return false;

      const id = createId(parsed.platform, parsed.channel);
      if (streams.some((stream) => stream.id === id)) {
        return false;
      }

      const nextStream: StreamRef = {
        ...parsed,
        id,
        muted: true,
        orientation: detectOrientation(parsed.platform, input),
      };
      // Portrait insertion only: a newly added 9:16 stream starts at index 0
      // so landscape cards dense-pack around it. After that, store/reorder
      // order is the sole placement source — no CSS order:-1, no re-sort.
      setStreams(
        nextStream.orientation === 'portrait' ? [nextStream, ...streams] : [...streams, nextStream],
      );
      return true;
    },

    removeStream(id: string): void {
      setStreams(streams.filter((stream) => stream.id !== id));
    },

    /**
     * Undo for removeStream: re-adds an already-known StreamRef (not a raw
     * URL/username) at its previous approximate index, clamped to the
     * current length in case other streams were added/removed meanwhile.
     * This is "recreate the stream normally" (a fresh player mounts for it
     * the same way any other stream addition mounts one) — it just skips
     * parseStreamInput/detectOrientation since the caller already has the
     * exact StreamRef that was removed, not a raw string to reparse.
     */
    insertStream(stream: StreamRef, index: number): void {
      if (streams.some((existing) => existing.id === stream.id)) return;
      const next = streams.slice();
      const clampedIndex = Math.max(0, Math.min(index, next.length));
      next.splice(clampedIndex, 0, stream);
      setStreams(next);
    },

    clearStreams(): void {
      setStreams([]);
    },

    reorderStreams(ids: string[]): void {
      const byId = new Map(streams.map((stream) => [stream.id, stream]));
      const next: StreamRef[] = [];
      for (const id of ids) {
        const stream = byId.get(id);
        if (stream) {
          next.push(stream);
          byId.delete(id);
        }
      }
      for (const stream of byId.values()) {
        next.push(stream);
      }
      setStreams(next);
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type StreamStore = ReturnType<typeof createStreamStore>;
