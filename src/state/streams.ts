import {
  buildPathFromStreams,
  parseStreamInput,
  streamsFromPathname,
  streamsFromSearch,
} from '../platforms';
import type { StreamRef } from '../types';

type Listener = () => void;

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
  let streams = dedupeStreams(loadFromUrl());
  const listeners = new Set<Listener>();

  syncUrl(streams);

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function setStreams(next: StreamRef[]): void {
    streams = dedupeStreams(next);
    syncUrl(streams);
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
