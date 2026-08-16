import { describe, expect, it, beforeEach } from 'vitest';
import {
  WATCH_PARTY_HOST_STORAGE_KEY,
  WATCH_PARTY_POLL_INTERVAL_MS,
  clearHostRecord,
  hostRecordForRoom,
  lineupFingerprint,
  loadHostRecord,
  parseWatchPartySession,
  saveHostRecord,
  streamsToWatchPartyPayload,
  watchPartyIdFromPath,
  watchPartyPath,
  watchPartyUrl,
} from './watchParty';
import type { StreamRef } from '../types';

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = createLocalStorageStub();
});

describe('watchPartyIdFromPath', () => {
  it('extracts a 10-character room id from /w/ROOM', () => {
    expect(watchPartyIdFromPath('/w/abcdefghij')).toBe('abcdefghij');
    expect(watchPartyIdFromPath('/w/ABCDEFGHIJ/')).toBe('abcdefghij');
  });

  it('does not claim static stream path URLs', () => {
    expect(watchPartyIdFromPath('/t:shroud')).toBeNull();
    expect(watchPartyIdFromPath('/t:shroud/k:trainwreckstv')).toBeNull();
    expect(watchPartyIdFromPath('/w/t:shroud')).toBeNull();
    expect(watchPartyIdFromPath('/')).toBeNull();
    expect(watchPartyIdFromPath('/w/short')).toBeNull();
  });
});

describe('watch party helpers', () => {
  it('builds the viewer path and URL', () => {
    expect(watchPartyPath('abcdefghij')).toBe('/w/abcdefghij');
    expect(watchPartyUrl('https://multistream.cc', 'abcdefghij')).toBe(
      'https://multistream.cc/w/abcdefghij',
    );
  });

  it('fingerprints lineup order so a reorder is a real change', () => {
    const a: StreamRef[] = [
      { id: 'twitch:a', platform: 'twitch', channel: 'a', muted: true, orientation: 'landscape' },
      { id: 'kick:b', platform: 'kick', channel: 'b', muted: true, orientation: 'landscape' },
    ];
    const b = [a[1], a[0]];
    expect(lineupFingerprint(streamsToWatchPartyPayload(a))).not.toBe(
      lineupFingerprint(streamsToWatchPartyPayload(b)),
    );
  });

  it('stores host authority per room in localStorage', () => {
    saveHostRecord({ roomId: 'abcdefghij', hostToken: 'a'.repeat(64) });
    expect(loadHostRecord()).toEqual({ roomId: 'abcdefghij', hostToken: 'a'.repeat(64) });
    expect(hostRecordForRoom('abcdefghij')?.hostToken).toHaveLength(64);
    expect(hostRecordForRoom('zzzzzzzzzz')).toBeNull();
    clearHostRecord();
    expect(loadHostRecord()).toBeNull();
    expect(WATCH_PARTY_HOST_STORAGE_KEY).toBe('multistream:live-party');
  });

  it('rejects a session payload that omits streams or uses an unknown platform', () => {
    expect(parseWatchPartySession({ id: 'abcdefghij', status: 'active' })).toBeNull();
    expect(
      parseWatchPartySession({
        id: 'abcdefghij',
        status: 'active',
        streams: [{ platform: 'vimeo', channel: 'x' }],
        updatedAt: 1,
        createdAt: 1,
      }),
    ).toBeNull();
  });

  it('accepts a valid public session snapshot', () => {
    const session = parseWatchPartySession({
      id: 'abcdefghij',
      status: 'active',
      streams: [{ platform: 'twitch', channel: 'shroud' }],
      updatedAt: 100,
      createdAt: 90,
    });
    expect(session).toEqual({
      id: 'abcdefghij',
      status: 'active',
      streams: [{ platform: 'twitch', channel: 'shroud' }],
      updatedAt: 100,
      createdAt: 90,
    });
  });

  it('uses a 2 second viewer poll interval', () => {
    expect(WATCH_PARTY_POLL_INTERVAL_MS).toBe(2000);
  });
});
