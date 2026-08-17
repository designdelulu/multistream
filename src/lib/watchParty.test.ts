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
  viewFingerprint,
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

  it('carries per-stream orientation in the payload (host Shorts stay portrait for viewers)', () => {
    const streams: StreamRef[] = [
      { id: 'youtube:video:abc', platform: 'youtube', channel: 'video:abc', muted: true, orientation: 'portrait' },
      { id: 'twitch:a', platform: 'twitch', channel: 'a', muted: true, orientation: 'landscape' },
    ];
    expect(streamsToWatchPartyPayload(streams)).toEqual([
      { platform: 'youtube', channel: 'video:abc', orientation: 'portrait' },
      { platform: 'twitch', channel: 'a', orientation: 'landscape' },
    ]);
  });

  it('an orientation-only change still changes the lineup fingerprint (so it gets pushed)', () => {
    const landscape = [
      { platform: 'youtube' as const, channel: 'video:abc', orientation: 'landscape' as const },
    ];
    const portrait = [
      { platform: 'youtube' as const, channel: 'video:abc', orientation: 'portrait' as const },
    ];
    expect(lineupFingerprint(landscape)).not.toBe(lineupFingerprint(portrait));
  });

  it('round-trips orientation through session parsing and rejects invalid values', () => {
    const session = parseWatchPartySession({
      id: 'abcdefghij',
      status: 'active',
      streams: [{ platform: 'youtube', channel: 'video:abc', orientation: 'portrait' }],
      updatedAt: 100,
      createdAt: 90,
    });
    expect(session?.streams[0].orientation).toBe('portrait');

    expect(
      parseWatchPartySession({
        id: 'abcdefghij',
        status: 'active',
        streams: [{ platform: 'youtube', channel: 'video:abc', orientation: 'square' }],
        updatedAt: 100,
        createdAt: 90,
      }),
    ).toBeNull();

    // Pre-orientation room files (no orientation key at all) still parse.
    expect(
      parseWatchPartySession({
        id: 'abcdefghij',
        status: 'active',
        streams: [{ platform: 'twitch', channel: 'shroud' }],
        updatedAt: 100,
        createdAt: 90,
      }),
    ).not.toBeNull();
  });

  it('fingerprints the host view so a view-only change is a real change', () => {
    expect(viewFingerprint(null)).toBe('');
    expect(viewFingerprint(undefined)).toBe('');
    expect(viewFingerprint({ mode: 'grid', primary: null })).toBe('grid::');
    expect(viewFingerprint({ mode: 'theater', primary: 'twitch:a' })).not.toBe(
      viewFingerprint({ mode: 'focus', primary: 'twitch:a' }),
    );
    expect(viewFingerprint({ mode: 'theater', primary: 'twitch:a' })).not.toBe(
      viewFingerprint({ mode: 'theater', primary: 'twitch:b' }),
    );
    expect(viewFingerprint({ mode: 'theater', primary: 'twitch:a' })).not.toBe(
      viewFingerprint({ mode: 'grid', primary: null }),
    );
    expect(viewFingerprint({ mode: 'theater', primary: 'twitch:a', chatVisible: true })).not.toBe(
      viewFingerprint({ mode: 'theater', primary: 'twitch:a', chatVisible: false }),
    );
  });

  it('round-trips the host view through session parsing', () => {
    const session = parseWatchPartySession({
      id: 'abcdefghij',
      status: 'active',
      streams: [{ platform: 'twitch', channel: 'shroud' }],
      updatedAt: 100,
      createdAt: 90,
      view: { mode: 'theater', primary: 'twitch:shroud', chatVisible: false },
    });
    expect(session?.view).toEqual({
      mode: 'theater',
      primary: 'twitch:shroud',
      chatVisible: false,
    });
  });

  it('rejects a session whose view is malformed, but parses pre-view room files', () => {
    const base = {
      id: 'abcdefghij',
      status: 'active',
      streams: [{ platform: 'twitch', channel: 'shroud' }],
      updatedAt: 100,
      createdAt: 90,
    };
    expect(
      parseWatchPartySession({ ...base, view: { mode: 'spotlight', primary: null } }),
    ).toBeNull();
    expect(parseWatchPartySession({ ...base, view: { mode: 'grid', primary: 42 } })).toBeNull();
    expect(
      parseWatchPartySession({
        ...base,
        view: { mode: 'grid', primary: null, chatVisible: 'yes' },
      }),
    ).toBeNull();
    expect(parseWatchPartySession({ ...base, view: 'theater' })).toBeNull();
    // No view key at all (older room files): viewers keep their local view.
    const legacy = parseWatchPartySession(base);
    expect(legacy).not.toBeNull();
    expect(legacy?.view).toBeUndefined();
  });
});
