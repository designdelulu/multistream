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

function toStreamRefs(items: Omit<StreamRef, 'id' | 'muted'>[]): StreamRef[] {
  return items.map((item) => ({
    ...item,
    id: createId(item.platform, item.channel),
    muted: true,
  }));
}

function loadFromStorage(): Omit<StreamRef, 'id' | 'muted'>[] {
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
              (item as { platform?: string }).platform === 'youtube') &&
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

      setStreams([
        ...streams,
        {
          ...parsed,
          id,
          muted: true,
        },
      ]);
      return true;
    },

    removeStream(id: string): void {
      setStreams(streams.filter((stream) => stream.id !== id));
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
