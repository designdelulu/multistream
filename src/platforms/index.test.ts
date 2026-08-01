import { describe, expect, it } from 'vitest';
import {
  buildPathFromStreams,
  deserializeStream,
  getAdapter,
  parseStreamInput,
  serializeStream,
  streamsFromPathname,
  streamsFromSearch,
} from './index';

describe('getAdapter', () => {
  it('returns the twitch adapter', () => {
    expect(getAdapter('twitch').id).toBe('twitch');
  });

  it('returns the kick adapter', () => {
    expect(getAdapter('kick').id).toBe('kick');
  });

  it('returns the youtube adapter', () => {
    expect(getAdapter('youtube').id).toBe('youtube');
  });
});

describe('parseStreamInput', () => {
  it('resolves a plain username to twitch (adapter precedence)', () => {
    expect(parseStreamInput('shroud')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('resolves an explicit kick prefix to kick', () => {
    expect(parseStreamInput('k:trainwreckstv')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('returns null for empty input', () => {
    expect(parseStreamInput('   ')).toBeNull();
  });

  it('returns null when no adapter matches', () => {
    expect(parseStreamInput('https://vimeo.com/12345')).toBeNull();
  });

  it('resolves a youtube watch URL', () => {
    expect(parseStreamInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      platform: 'youtube',
      channel: 'video:dQw4w9WgXcQ',
    });
  });

  it('does not let youtube claim a bare username Twitch already owns', () => {
    expect(parseStreamInput('shroud')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });
});

describe('serializeStream', () => {
  it('uses the t: prefix for twitch', () => {
    expect(serializeStream({ platform: 'twitch', channel: 'shroud' })).toBe('t:shroud');
  });

  it('uses the k: prefix for kick', () => {
    expect(serializeStream({ platform: 'kick', channel: 'trainwreckstv' })).toBe(
      'k:trainwreckstv',
    );
  });

  it('uses the y: prefix for youtube, with the composite token verbatim', () => {
    expect(serializeStream({ platform: 'youtube', channel: 'handle:pewdiepie' })).toBe(
      'y:handle:pewdiepie',
    );
    expect(serializeStream({ platform: 'youtube', channel: 'video:dQw4w9WgXcQ' })).toBe(
      'y:video:dQw4w9WgXcQ',
    );
  });
});

describe('deserializeStream', () => {
  it('parses the short t: form', () => {
    expect(deserializeStream('t:shroud')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('parses the short k: form', () => {
    expect(deserializeStream('k:trainwreckstv')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('is case-insensitive on the prefix and channel', () => {
    expect(deserializeStream('T:ShRouD')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('parses the legacy twitch: form', () => {
    expect(deserializeStream('twitch:shroud')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('parses the legacy kick: form', () => {
    expect(deserializeStream('kick:trainwreckstv')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('URL-decodes the token before matching', () => {
    expect(deserializeStream('t%3Ashroud')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('returns null for garbage input', () => {
    expect(deserializeStream('not-a-stream')).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(deserializeStream('')).toBeNull();
  });

  it('parses a y: video token', () => {
    expect(deserializeStream('y:video:dQw4w9WgXcQ')).toEqual({
      platform: 'youtube',
      channel: 'video:dQw4w9WgXcQ',
    });
  });

  it('parses a y: handle token', () => {
    expect(deserializeStream('y:handle:pewdiepie')).toEqual({
      platform: 'youtube',
      channel: 'handle:pewdiepie',
    });
  });

  it('returns null for a y: token with a malformed inner payload', () => {
    expect(deserializeStream('y:not-a-real-token')).toBeNull();
  });

  it('round-trips serializeStream -> deserializeStream for youtube', () => {
    const ref = { platform: 'youtube' as const, channel: 'channelid:UC-lHJZR3Gqxm24_Vd_AJ5Yw' };
    expect(deserializeStream(serializeStream(ref))).toEqual(ref);
  });
});

describe('streamsFromPathname', () => {
  it('parses multiple segments', () => {
    expect(streamsFromPathname('/t:shroud/k:trainwreckstv')).toEqual([
      { platform: 'twitch', channel: 'shroud' },
      { platform: 'kick', channel: 'trainwreckstv' },
    ]);
  });

  it('filters out invalid segments', () => {
    expect(streamsFromPathname('/t:shroud/not-a-stream/k:trainwreckstv')).toEqual([
      { platform: 'twitch', channel: 'shroud' },
      { platform: 'kick', channel: 'trainwreckstv' },
    ]);
  });

  it('returns an empty array for the root path', () => {
    expect(streamsFromPathname('/')).toEqual([]);
  });

  it('parses a mixed twitch/kick/youtube path unaffected by the new adapter', () => {
    expect(streamsFromPathname('/t:shroud/k:trainwreckstv/y:handle:pewdiepie')).toEqual([
      { platform: 'twitch', channel: 'shroud' },
      { platform: 'kick', channel: 'trainwreckstv' },
      { platform: 'youtube', channel: 'handle:pewdiepie' },
    ]);
  });

  it('still parses an old twitch/kick-only path exactly as before (backward compat)', () => {
    expect(streamsFromPathname('/t:shroud/k:trainwreckstv')).toEqual([
      { platform: 'twitch', channel: 'shroud' },
      { platform: 'kick', channel: 'trainwreckstv' },
    ]);
  });
});

describe('streamsFromSearch', () => {
  it('parses a comma-separated streams param', () => {
    expect(streamsFromSearch('?streams=t:shroud,k:trainwreckstv')).toEqual([
      { platform: 'twitch', channel: 'shroud' },
      { platform: 'kick', channel: 'trainwreckstv' },
    ]);
  });

  it('returns an empty array when the param is missing', () => {
    expect(streamsFromSearch('')).toEqual([]);
  });

  it('filters out invalid tokens', () => {
    expect(streamsFromSearch('?streams=t:shroud,garbage')).toEqual([
      { platform: 'twitch', channel: 'shroud' },
    ]);
  });

  it('parses a mixed twitch/kick/youtube query param', () => {
    expect(streamsFromSearch('?streams=t:shroud,k:trainwreckstv,y:handle:pewdiepie')).toEqual([
      { platform: 'twitch', channel: 'shroud' },
      { platform: 'kick', channel: 'trainwreckstv' },
      { platform: 'youtube', channel: 'handle:pewdiepie' },
    ]);
  });
});

describe('buildPathFromStreams', () => {
  it('returns / for an empty list', () => {
    expect(buildPathFromStreams([])).toBe('/');
  });

  it('joins multiple streams with slashes', () => {
    expect(
      buildPathFromStreams([
        { platform: 'twitch', channel: 'shroud' },
        { platform: 'kick', channel: 'trainwreckstv' },
      ]),
    ).toBe('/t:shroud/k:trainwreckstv');
  });

  it('includes youtube streams in the path', () => {
    expect(
      buildPathFromStreams([
        { platform: 'twitch', channel: 'shroud' },
        { platform: 'youtube', channel: 'video:dQw4w9WgXcQ' },
      ]),
    ).toBe('/t:shroud/y:video:dQw4w9WgXcQ');
  });
});
