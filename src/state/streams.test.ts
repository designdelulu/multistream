import { beforeEach, describe, expect, it } from 'vitest';
import { createStreamStore } from './streams';

/**
 * No jsdom/happy-dom in this project (platforms/*.test.ts avoid the DOM
 * entirely) — createStreamStore only touches window.location,
 * window.history.replaceState, and localStorage, so a small hand-rolled
 * stub covers it without adding a new test-tooling dependency.
 */
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

let locationStub: { pathname: string; search: string; hostname: string };

beforeEach(() => {
  locationStub = { pathname: '/', search: '', hostname: 'multistream.cc' };
  (globalThis as { window?: unknown }).window = {
    location: locationStub,
    history: { replaceState: () => {} },
  };
  (globalThis as { localStorage?: unknown }).localStorage = createLocalStorageStub();
});

describe('createStreamStore — youtube support', () => {
  it('adds a youtube channel-handle stream', () => {
    const store = createStreamStore();
    const added = store.addStream('y:handle:pewdiepie');
    expect(added).toBe(true);
    expect(store.getStreams()).toEqual([
      { id: 'youtube:handle:pewdiepie', platform: 'youtube', channel: 'handle:pewdiepie', muted: true, orientation: 'landscape' },
    ]);
  });

  it('adds a youtube direct video stream', () => {
    const store = createStreamStore();
    store.addStream('https://youtu.be/dQw4w9WgXcQ');
    expect(store.getStreams()).toEqual([
      { id: 'youtube:video:dQw4w9WgXcQ', platform: 'youtube', channel: 'video:dQw4w9WgXcQ', muted: true, orientation: 'landscape' },
    ]);
  });

  it('dedupes the same youtube channel added twice', () => {
    const store = createStreamStore();
    store.addStream('y:handle:pewdiepie');
    const secondAdd = store.addStream('y:handle:pewdiepie');
    expect(secondAdd).toBe(false);
    expect(store.getStreams()).toHaveLength(1);
  });

  it('lets twitch/kick/youtube coexist and dedupe independently', () => {
    const store = createStreamStore();
    store.addStream('shroud');
    store.addStream('k:trainwreckstv');
    store.addStream('y:handle:pewdiepie');
    expect(store.getStreams().map((s) => s.platform)).toEqual(['twitch', 'kick', 'youtube']);
  });

  it('restores a youtube-inclusive localStorage payload', () => {
    localStorage.setItem(
      'multistream:streams',
      JSON.stringify([
        { platform: 'twitch', channel: 'shroud' },
        { platform: 'youtube', channel: 'handle:pewdiepie' },
      ]),
    );
    const store = createStreamStore();
    expect(store.getStreams()).toEqual([
      { id: 'twitch:shroud', platform: 'twitch', channel: 'shroud', muted: true, orientation: 'landscape' },
      { id: 'youtube:handle:pewdiepie', platform: 'youtube', channel: 'handle:pewdiepie', muted: true, orientation: 'landscape' },
    ]);
  });

  it('restores an old twitch/kick-only localStorage payload unchanged (backward compat)', () => {
    localStorage.setItem(
      'multistream:streams',
      JSON.stringify([
        { platform: 'twitch', channel: 'shroud' },
        { platform: 'kick', channel: 'trainwreckstv' },
      ]),
    );
    const store = createStreamStore();
    expect(store.getStreams()).toEqual([
      { id: 'twitch:shroud', platform: 'twitch', channel: 'shroud', muted: true, orientation: 'landscape' },
      { id: 'kick:trainwreckstv', platform: 'kick', channel: 'trainwreckstv', muted: true, orientation: 'landscape' },
    ]);
  });

  it('restores a youtube stream from the URL path', () => {
    locationStub.pathname = '/t:shroud/y:video:dQw4w9WgXcQ';
    const store = createStreamStore();
    expect(store.getStreams()).toEqual([
      { id: 'twitch:shroud', platform: 'twitch', channel: 'shroud', muted: true, orientation: 'landscape' },
      { id: 'youtube:video:dQw4w9WgXcQ', platform: 'youtube', channel: 'video:dQw4w9WgXcQ', muted: true, orientation: 'landscape' },
    ]);
  });

  it('ignores a malformed youtube entry in storage rather than crashing restore', () => {
    localStorage.setItem(
      'multistream:streams',
      JSON.stringify([
        { platform: 'youtube', channel: 'handle:pewdiepie' },
        { platform: 'unknown-platform', channel: 'whatever' },
      ]),
    );
    const store = createStreamStore();
    expect(store.getStreams()).toEqual([
      { id: 'youtube:handle:pewdiepie', platform: 'youtube', channel: 'handle:pewdiepie', muted: true, orientation: 'landscape' },
    ]);
  });

  it('removes a youtube stream by id', () => {
    const store = createStreamStore();
    store.addStream('y:handle:pewdiepie');
    const [stream] = store.getStreams();
    store.removeStream(stream.id);
    expect(store.getStreams()).toEqual([]);
  });
});

describe('createStreamStore — orientation detection is synchronous (no post-mount race)', () => {
  /**
   * Regression coverage for a hypothesized "orientation flips after mount"
   * race: a YouTube Short is landscape at insert time and only later
   * reclassifies as portrait, causing a second re-render. detectOrientation
   * is a plain synchronous regex check (see streams.ts) with nothing async
   * in addStream's path — this asserts the orientation is already correct
   * on the very same getStreams() read that follows addStream(), with no
   * await, no timer flush, and no store subscription round trip needed.
   */
  it('a youtube.com/shorts/ URL is portrait immediately, in the same tick as addStream', () => {
    const store = createStreamStore();
    const added = store.addStream('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    expect(added).toBe(true);
    expect(store.getStreams()).toEqual([
      {
        id: 'youtube:video:dQw4w9WgXcQ',
        platform: 'youtube',
        channel: 'video:dQw4w9WgXcQ',
        muted: true,
        orientation: 'portrait',
      },
    ]);
  });

  it('a youtu.be shorts-style link and a plain long-form link resolve to different orientations, both immediately', () => {
    const store = createStreamStore();
    store.addStream('https://www.youtube.com/shorts/jNQXAC9IVRw');
    store.addStream('https://youtu.be/dQw4w9WgXcQ');
    const [short, longForm] = store.getStreams();
    expect(short.orientation).toBe('portrait');
    expect(longForm.orientation).toBe('landscape');
  });

  it('non-youtube platforms are always landscape regardless of input shape', () => {
    const store = createStreamStore();
    store.addStream('shroud');
    store.addStream('k:trainwreckstv');
    expect(store.getStreams().every((s) => s.orientation === 'landscape')).toBe(true);
  });
});
