import { afterEach, describe, expect, it } from 'vitest';
import { createChatStore, isChatPlatform } from './chat';
import type { StreamRef } from '../types';
import type { StreamStore } from './streams';

function fakeStore(streams: StreamRef[]): StreamStore {
  return {
    getStreams: () => streams,
    subscribe: () => () => undefined,
  } as unknown as StreamStore;
}

function twitch(channel: string): StreamRef {
  return { id: `twitch:${channel}`, platform: 'twitch', channel, muted: true, orientation: 'landscape' };
}

function kick(channel: string): StreamRef {
  return { id: `kick:${channel}`, platform: 'kick', channel, muted: true, orientation: 'landscape' };
}

function youtube(channel: string): StreamRef {
  return { id: `youtube:${channel}`, platform: 'youtube', channel, muted: true, orientation: 'landscape' };
}

describe('createChatStore', () => {
  it('includes Kick streams in the chat selector alongside Twitch', () => {
    const store = createChatStore(fakeStore([twitch('luhliv1'), kick('deenthegreat'), youtube('mychannel')]));
    expect(store.hasChatSupport()).toBe(true);
    expect(store.getChatStreams().map((stream) => stream.id)).toEqual([
      'twitch:luhliv1',
      'kick:deenthegreat',
    ]);
    expect(store.getTwitchStreams()).toHaveLength(1);
    expect(store.getSelectedId()).toBe('twitch:luhliv1');
    store.setSelectedId('kick:deenthegreat');
    expect(store.getSelectedStream()?.platform).toBe('kick');
  });

  it('can select a Kick-only lineup', () => {
    const store = createChatStore(fakeStore([kick('deenthegreat')]));
    expect(store.hasChatSupport()).toBe(true);
    expect(store.getSelectedId()).toBe('kick:deenthegreat');
  });

  it('does not treat YouTube as a chat platform', () => {
    const store = createChatStore(fakeStore([youtube('mychannel')]));
    expect(store.hasChatSupport()).toBe(false);
    expect(isChatPlatform('youtube')).toBe(false);
    expect(isChatPlatform('kick')).toBe(true);
    expect(isChatPlatform('twitch')).toBe(true);
  });

  it('setVisible does not notify when visibility is already that value', () => {
    localStorage.removeItem('multistream:chat-visible');
    const store = createChatStore(fakeStore([twitch('luhliv1')]));
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.setVisible(true);
    const afterOpen = calls;
    expect(afterOpen).toBeGreaterThan(0);
    store.setVisible(true);
    expect(calls).toBe(afterOpen);
    store.setVisible(false);
    expect(calls).toBe(afterOpen + 1);
    store.setVisible(false);
    expect(calls).toBe(afterOpen + 1);
  });
});

describe('chat visibility restore by device', () => {
  const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)';
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

  function stubNavigator(userAgent: string, platform: string, maxTouchPoints: number): () => void {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent, platform, maxTouchPoints },
      configurable: true,
    });
    return () => {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete (globalThis as { navigator?: unknown }).navigator;
    };
  }

  afterEach(() => {
    localStorage.removeItem('multistream:chat-visible');
  });

  it('restores an explicitly-opened chat on desktop', () => {
    localStorage.setItem('multistream:chat-visible', '1');
    const restore = stubNavigator(MAC_UA, 'MacIntel', 0);
    try {
      expect(createChatStore(fakeStore([twitch('luhliv1')])).isVisible()).toBe(true);
    } finally {
      restore();
    }
  });

  it('never starts open on iPad, even with an explicit stored preference', () => {
    // The sidebar costs ~32vw there — the difference between a workable grid
    // and tiles too small for Twitch to autoplay in. Reported live: chat
    // appeared by itself on first load.
    localStorage.setItem('multistream:chat-visible', '1');
    const restore = stubNavigator(IPAD_UA, 'iPad', 5);
    try {
      expect(createChatStore(fakeStore([twitch('luhliv1')])).isVisible()).toBe(false);
    } finally {
      restore();
    }
  });

  it('leaves the stored desktop preference untouched — the iPad rule is read-side only', () => {
    localStorage.setItem('multistream:chat-visible', '1');
    const restore = stubNavigator(IPAD_UA, 'iPad', 5);
    try {
      createChatStore(fakeStore([twitch('luhliv1')]));
    } finally {
      restore();
    }
    expect(localStorage.getItem('multistream:chat-visible')).toBe('1');
  });

  it('still opens on iPad when the user asks during the session', () => {
    const restore = stubNavigator(IPAD_UA, 'iPad', 5);
    try {
      const store = createChatStore(fakeStore([twitch('luhliv1')]));
      store.toggleVisible();
      expect(store.isVisible()).toBe(true);
    } finally {
      restore();
    }
  });
});
