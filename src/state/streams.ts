import {
  deserializeStream,
  parseStreamInput,
  serializeStream,
} from '../platforms';
import type { StreamRef } from '../types';

const STORAGE_KEY = 'multistream:streams';
const DEFAULT_STREAMS = ['twitch:shroud', 'kick:xqc'];

type Listener = () => void;

function createId(platform: string, channel: string): string {
  return `${platform}:${channel}`;
}

function loadFromQuery(): StreamRef[] {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('streams');
  if (!raw) return [];

  return raw
    .split(',')
    .map((token) => deserializeStream(token))
    .filter((item): item is Omit<StreamRef, 'id' | 'muted'> => item !== null)
    .map((item) => ({
      ...item,
      id: createId(item.platform, item.channel),
      muted: true,
    }));
}

function loadFromStorage(): StreamRef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as StreamRef[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        (item.platform === 'twitch' || item.platform === 'kick') &&
        typeof item.channel === 'string' &&
        typeof item.muted === 'boolean',
    );
  } catch {
    return [];
  }
}

function defaultStreams(): StreamRef[] {
  return DEFAULT_STREAMS.map((token) => {
    const parsed = deserializeStream(token);
    if (!parsed) {
      throw new Error(`Invalid default stream token: ${token}`);
    }
    return {
      ...parsed,
      id: createId(parsed.platform, parsed.channel),
      muted: true,
    };
  });
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
  const params = new URLSearchParams(window.location.search);
  if (streams.length === 0) {
    params.delete('streams');
  } else {
    params.set('streams', streams.map((s) => serializeStream(s)).join(','));
  }

  const query = params.toString();
  const next = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState(null, '', next);
}

function persistStreams(streams: StreamRef[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(streams));
}

export function createStreamStore() {
  const fromQuery = loadFromQuery();
  const fromStorage = loadFromStorage();
  const initial =
    fromQuery.length > 0 ? fromQuery : fromStorage.length > 0 ? fromStorage : defaultStreams();

  let streams = dedupeStreams(initial);
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

    toggleMute(id: string): void {
      setStreams(
        streams.map((stream) =>
          stream.id === id ? { ...stream, muted: !stream.muted } : stream,
        ),
      );
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type StreamStore = ReturnType<typeof createStreamStore>;
