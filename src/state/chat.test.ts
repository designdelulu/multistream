import { describe, expect, it } from 'vitest';
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
