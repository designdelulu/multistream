import type { StreamRef } from '../types';
import type { StreamStore } from './streams';

const STORAGE_KEY = 'multistream:chat-visible';

type Listener = () => void;

function loadVisiblePreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function persistVisiblePreference(visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? '1' : '0');
  } catch {
    // Ignore storage failures.
  }
}

function twitchStreams(store: StreamStore): StreamRef[] {
  return store.getStreams().filter((stream) => stream.platform === 'twitch');
}

export function createChatStore(streamStore: StreamStore) {
  let visible = loadVisiblePreference();
  let selectedId: string | null = null;
  const listeners = new Set<Listener>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function syncSelection(): void {
    const streams = twitchStreams(streamStore);
    if (streams.length === 0) {
      selectedId = null;
      return;
    }
    if (!selectedId || !streams.some((stream) => stream.id === selectedId)) {
      selectedId = streams[0].id;
    }
  }

  function setVisible(next: boolean, options?: { persist?: boolean }): void {
    visible = next;
    if (options?.persist !== false) {
      persistVisiblePreference(next);
    }
    notify();
  }

  streamStore.subscribe(() => {
    syncSelection();
    notify();
  });

  syncSelection();

  return {
    isVisible(): boolean {
      return visible;
    },

    setVisible(next: boolean, options?: { persist?: boolean }): void {
      setVisible(next, options);
    },

    toggleVisible(): void {
      setVisible(!visible);
    },

    hasChatSupport(): boolean {
      return twitchStreams(streamStore).length > 0;
    },

    hasAnyStreams(): boolean {
      return streamStore.getStreams().length > 0;
    },

    getTwitchStreams(): StreamRef[] {
      return twitchStreams(streamStore);
    },

    getSelectedId(): string | null {
      return selectedId;
    },

    setSelectedId(id: string): void {
      if (!twitchStreams(streamStore).some((stream) => stream.id === id)) {
        return;
      }
      selectedId = id;
      notify();
    },

    getSelectedStream(): StreamRef | null {
      syncSelection();
      if (!selectedId) return null;
      return twitchStreams(streamStore).find((stream) => stream.id === selectedId) ?? null;
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
