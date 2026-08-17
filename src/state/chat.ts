import type { StreamRef } from '../types';
import type { StreamStore } from './streams';

const STORAGE_KEY = 'multistream:chat-visible';

type Listener = () => void;

const CHAT_PLATFORMS = new Set(['twitch', 'kick']);

/**
 * Fresh session (no stored key) defaults CLOSED — chat only opens once the
 * user explicitly opens it (or a prior session's explicit choice is being
 * restored). Only the literal '1' counts as an explicit "on"; anything else
 * (missing key, null, an old/garbage value) reads as closed. Confirmed live:
 * the previous `!== '0'` check treated a *missing* key the same as an
 * explicit "not off", which opened chat by default for every first-time
 * visitor and for anyone who added their very first stream before ever
 * touching the chat toggle.
 */
function loadVisiblePreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistVisiblePreference(visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? '1' : '0');
  } catch {
    // Ignore storage failures.
  }
}

function chatStreams(store: StreamStore): StreamRef[] {
  return store.getStreams().filter((stream) => CHAT_PLATFORMS.has(stream.platform));
}

function twitchStreams(store: StreamStore): StreamRef[] {
  return store.getStreams().filter((stream) => stream.platform === 'twitch');
}

export function isChatPlatform(platform: string | undefined): boolean {
  return platform === 'twitch' || platform === 'kick';
}

export function createChatStore(streamStore: StreamStore) {
  let visible = loadVisiblePreference();
  let selectedId: string | null = null;
  // Transient, never persisted — locked while a non-chat stream is focused
  // (see main.ts's bindStreamFocus wiring). Twitch and Kick both have a
  // same-origin chat panel; YouTube/TikTok still have nothing to show.
  let toggleAllowed = true;
  const listeners = new Set<Listener>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function syncSelection(): void {
    const streams = chatStreams(streamStore);
    if (streams.length === 0) {
      selectedId = null;
      return;
    }
    if (!selectedId || !streams.some((stream) => stream.id === selectedId)) {
      selectedId = streams[0].id;
    }
  }

  function setVisible(next: boolean, options?: { persist?: boolean }): void {
    if (visible === next) return;
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

    isToggleAllowed(): boolean {
      return toggleAllowed;
    },

    setToggleAllowed(next: boolean): void {
      if (next === toggleAllowed) return;
      toggleAllowed = next;
      notify();
    },

    hasChatSupport(): boolean {
      return chatStreams(streamStore).length > 0;
    },

    hasAnyStreams(): boolean {
      return streamStore.getStreams().length > 0;
    },

    getTwitchStreams(): StreamRef[] {
      return twitchStreams(streamStore);
    },

    getChatStreams(): StreamRef[] {
      return chatStreams(streamStore);
    },

    getSelectedId(): string | null {
      return selectedId;
    },

    setSelectedId(id: string): void {
      if (!chatStreams(streamStore).some((stream) => stream.id === id)) {
        return;
      }
      selectedId = id;
      notify();
    },

    getSelectedStream(): StreamRef | null {
      syncSelection();
      if (!selectedId) return null;
      return chatStreams(streamStore).find((stream) => stream.id === selectedId) ?? null;
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
