import { describe, expect, it } from 'vitest';
import { parseYouTubeInput, parseYouTubeToken, youtubeAdapter } from './youtube';

describe('parseYouTubeInput — direct video URLs (local parsing, no network)', () => {
  it('parses a standard watch URL', () => {
    expect(parseYouTubeInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'video:dQw4w9WgXcQ',
    );
  });

  it('parses a watch URL without scheme', () => {
    expect(parseYouTubeInput('youtube.com/watch?v=dQw4w9WgXcQ')).toBe('video:dQw4w9WgXcQ');
  });

  it('parses a watch URL with extra query params', () => {
    expect(
      parseYouTubeInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc&t=30s'),
    ).toBe('video:dQw4w9WgXcQ');
  });

  it('parses a youtu.be short URL', () => {
    expect(parseYouTubeInput('https://youtu.be/dQw4w9WgXcQ')).toBe('video:dQw4w9WgXcQ');
  });

  it('parses a youtu.be URL with a trailing query param', () => {
    expect(parseYouTubeInput('https://youtu.be/dQw4w9WgXcQ?t=10')).toBe('video:dQw4w9WgXcQ');
  });

  it('parses a /live/ URL', () => {
    expect(parseYouTubeInput('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe(
      'video:dQw4w9WgXcQ',
    );
  });

  it('parses a /shorts/ URL', () => {
    expect(parseYouTubeInput('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'video:dQw4w9WgXcQ',
    );
  });

  it('parses an /embed/ URL', () => {
    expect(parseYouTubeInput('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
      'video:dQw4w9WgXcQ',
    );
  });

  it('parses an m.youtube.com URL', () => {
    expect(parseYouTubeInput('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'video:dQw4w9WgXcQ',
    );
  });
});

describe('parseYouTubeInput — channel URLs (local parsing, resolved later over the network)', () => {
  it('parses a /@handle URL', () => {
    expect(parseYouTubeInput('https://www.youtube.com/@pewdiepie')).toBe('handle:pewdiepie');
  });

  it('lowercases and strips @ from a /@handle URL', () => {
    expect(parseYouTubeInput('https://www.youtube.com/@PewDiePie')).toBe('handle:pewdiepie');
  });

  it('parses a /channel/UC... URL', () => {
    expect(parseYouTubeInput('https://www.youtube.com/channel/UC-lHJZR3Gqxm24_Vd_AJ5Yw')).toBe(
      'channelid:UC-lHJZR3Gqxm24_Vd_AJ5Yw',
    );
  });

  it('parses a legacy /user/ URL', () => {
    expect(parseYouTubeInput('https://www.youtube.com/user/PewDiePie')).toBe('user:pewdiepie');
  });

  it('parses a /c/ custom URL as a username-kind lookup', () => {
    expect(parseYouTubeInput('https://www.youtube.com/c/PewDiePie')).toBe('user:pewdiepie');
  });
});

describe('parseYouTubeInput — explicit y:/yt:/youtube: prefix', () => {
  it('parses an explicit handle prefix (from the toolbar dropdown)', () => {
    expect(parseYouTubeInput('y:handle:pewdiepie')).toBe('handle:pewdiepie');
  });

  it('parses "plain @handle" via the explicit-prefix + subtype grammar', () => {
    expect(parseYouTubeInput('y:handle:@pewdiepie')).toBe('handle:pewdiepie');
  });

  it('parses "handle without @" the same way', () => {
    expect(parseYouTubeInput('y:handle:pewdiepie')).toBe('handle:pewdiepie');
  });

  it('parses an explicit channelId prefix', () => {
    expect(parseYouTubeInput('y:channelid:UC-lHJZR3Gqxm24_Vd_AJ5Yw')).toBe(
      'channelid:UC-lHJZR3Gqxm24_Vd_AJ5Yw',
    );
  });

  it('parses an explicit video prefix', () => {
    expect(parseYouTubeInput('y:video:dQw4w9WgXcQ')).toBe('video:dQw4w9WgXcQ');
  });

  it('accepts the yt: alias', () => {
    expect(parseYouTubeInput('yt:handle:pewdiepie')).toBe('handle:pewdiepie');
  });

  it('accepts the youtube: alias', () => {
    expect(parseYouTubeInput('youtube:handle:pewdiepie')).toBe('handle:pewdiepie');
  });

  it('defaults a subtype-less explicit prefix to handle', () => {
    expect(parseYouTubeInput('y:pewdiepie')).toBe('handle:pewdiepie');
  });
});

describe('parseYouTubeInput — invalid input fails safely', () => {
  it('returns null for empty input', () => {
    expect(parseYouTubeInput('   ')).toBeNull();
  });

  it('returns null for a bare unprefixed username (no default claim — Twitch owns that)', () => {
    expect(parseYouTubeInput('pewdiepie')).toBeNull();
  });

  it('returns null for a non-YouTube host', () => {
    expect(parseYouTubeInput('https://twitch.tv/shroud')).toBeNull();
  });

  it('returns null for a malformed video id', () => {
    expect(parseYouTubeInput('https://youtu.be/short')).toBeNull();
  });

  it('returns null for an invalid explicit channelId', () => {
    expect(parseYouTubeInput('y:channelid:not-a-channel-id')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseYouTubeInput('not a url at all !!')).toBeNull();
  });
});

describe('parseYouTubeToken — decompose round-trip', () => {
  it('decomposes a video token', () => {
    expect(parseYouTubeToken('video:dQw4w9WgXcQ')).toEqual({
      resolutionType: 'video',
      videoId: 'dQw4w9WgXcQ',
    });
  });

  it('decomposes a handle token', () => {
    expect(parseYouTubeToken('handle:pewdiepie')).toEqual({
      resolutionType: 'channel',
      kind: 'handle',
      handle: 'pewdiepie',
    });
  });

  it('decomposes a username token', () => {
    expect(parseYouTubeToken('user:pewdiepie')).toEqual({
      resolutionType: 'channel',
      kind: 'username',
      username: 'pewdiepie',
    });
  });

  it('decomposes a channelId token', () => {
    expect(parseYouTubeToken('channelid:UC-lHJZR3Gqxm24_Vd_AJ5Yw')).toEqual({
      resolutionType: 'channel',
      kind: 'channelId',
      channelId: 'UC-lHJZR3Gqxm24_Vd_AJ5Yw',
    });
  });

  it('returns null for a malformed token', () => {
    expect(parseYouTubeToken('garbage')).toBeNull();
  });
});

describe('youtubeAdapter', () => {
  it('parseInput returns a youtube StreamRef shape', () => {
    expect(youtubeAdapter.parseInput('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      platform: 'youtube',
      channel: 'video:dQw4w9WgXcQ',
    });
  });

  it('parseInput returns null for unrecognized input', () => {
    expect(youtubeAdapter.parseInput('nonsense')).toBeNull();
  });

  it('buildEmbedUrl builds an embed URL for a video token', () => {
    const url = youtubeAdapter.buildEmbedUrl(
      { platform: 'youtube', channel: 'video:dQw4w9WgXcQ' },
      { muted: true, parent: 'multistream.cc', autoplay: true },
    );
    expect(url).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ?');
    expect(url).toContain('autoplay=1');
    expect(url).toContain('mute=1');
  });

  it('buildEmbedUrl returns empty string for a channel-type token (resolved elsewhere)', () => {
    const url = youtubeAdapter.buildEmbedUrl(
      { platform: 'youtube', channel: 'handle:pewdiepie' },
      { muted: true, parent: 'multistream.cc' },
    );
    expect(url).toBe('');
  });

  it('displayName decodes each token kind', () => {
    expect(youtubeAdapter.displayName({ channel: 'video:dQw4w9WgXcQ' })).toBe('dQw4w9WgXcQ');
    expect(youtubeAdapter.displayName({ channel: 'handle:pewdiepie' })).toBe('@pewdiepie');
    expect(youtubeAdapter.displayName({ channel: 'user:pewdiepie' })).toBe('pewdiepie');
    expect(youtubeAdapter.displayName({ channel: 'channelid:UC-lHJZR3Gqxm24_Vd_AJ5Yw' })).toBe(
      'UC-lHJZR3Gqxm24_Vd_AJ5Yw',
    );
  });

  it('label is YouTube', () => {
    expect(youtubeAdapter.label).toBe('YouTube');
  });
});
