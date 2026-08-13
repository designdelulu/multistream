import { describe, expect, it } from 'vitest';
import { describeTikTokState, TIKTOK_LIVE_ENABLED, tiktokAdapter } from './tiktok';

describe('tiktokAdapter.parseInput', () => {
  it('parses a canonical LIVE URL', () => {
    expect(tiktokAdapter.parseInput('https://www.tiktok.com/@creator/live')).toEqual({
      platform: 'tiktok',
      channel: 'creator',
    });
  });

  it('parses a LIVE URL without www', () => {
    expect(tiktokAdapter.parseInput('https://tiktok.com/@creator/live')).toEqual({
      platform: 'tiktok',
      channel: 'creator',
    });
  });

  it('parses a LIVE URL with query parameters', () => {
    expect(
      tiktokAdapter.parseInput('https://www.tiktok.com/@creator/live?enter_from=explore'),
    ).toEqual({ platform: 'tiktok', channel: 'creator' });
  });

  it('parses a bare profile URL as the creator to watch live', () => {
    expect(tiktokAdapter.parseInput('https://www.tiktok.com/@creator')).toEqual({
      platform: 'tiktok',
      channel: 'creator',
    });
  });

  it('parses a schemeless URL', () => {
    expect(tiktokAdapter.parseInput('tiktok.com/@creator/live')).toEqual({
      platform: 'tiktok',
      channel: 'creator',
    });
  });

  it('lowercases the channel', () => {
    expect(tiktokAdapter.parseInput('https://www.tiktok.com/@CreatorName/live')).toEqual({
      platform: 'tiktok',
      channel: 'creatorname',
    });
  });

  it('accepts dots and underscores in the handle', () => {
    expect(tiktokAdapter.parseInput('https://www.tiktok.com/@creator.name_1/live')).toEqual({
      platform: 'tiktok',
      channel: 'creator.name_1',
    });
  });

  it('rejects a bare @handle (ambiguous with Twitch — see module doc comment)', () => {
    expect(tiktokAdapter.parseInput('@creator')).toBeNull();
  });

  it('rejects a bare handle with no domain (ambiguous with Twitch)', () => {
    expect(tiktokAdapter.parseInput('creator')).toBeNull();
  });

  it('rejects a regular TikTok video URL — must not be misclassified as LIVE', () => {
    expect(
      tiktokAdapter.parseInput('https://www.tiktok.com/@creator/video/7123456789012345678'),
    ).toBeNull();
  });

  it('rejects a photo post URL', () => {
    expect(tiktokAdapter.parseInput('https://www.tiktok.com/@creator/photo/7123456789012345678')).toBeNull();
  });

  it('rejects a malformed TikTok URL', () => {
    expect(tiktokAdapter.parseInput('https://www.tiktok.com/')).toBeNull();
  });

  it('rejects a TikTok URL missing the @ handle', () => {
    expect(tiktokAdapter.parseInput('https://www.tiktok.com/creator/live')).toBeNull();
  });

  it('rejects an unsupported TikTok URL type (discover page)', () => {
    expect(tiktokAdapter.parseInput('https://www.tiktok.com/discover/dance')).toBeNull();
  });

  it('rejects a non-TikTok URL', () => {
    expect(tiktokAdapter.parseInput('https://www.twitch.tv/@creator/live')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(tiktokAdapter.parseInput('')).toBeNull();
    expect(tiktokAdapter.parseInput('   ')).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(tiktokAdapter.parseInput('not a url $$$')).toBeNull();
  });
});

describe('tiktokAdapter.displayName', () => {
  it('returns the channel as-is', () => {
    expect(tiktokAdapter.displayName({ channel: 'creator' })).toBe('creator');
  });
});

describe('tiktokAdapter.buildEmbedUrl', () => {
  it('returns an inert value — never used for real TikTok rendering', () => {
    expect(
      tiktokAdapter.buildEmbedUrl(
        { platform: 'tiktok', channel: 'creator' },
        { muted: true, parent: 'multistream.cc' },
      ),
    ).toBe('about:blank');
  });
});

describe('describeTikTokState', () => {
  it('gives distinct text for offline vs invalid creator (never lumped together)', () => {
    expect(describeTikTokState('offline')).not.toBe(describeTikTokState('invalid_creator'));
  });

  it('gives distinct text for resolver-unreachable vs not-configured', () => {
    expect(describeTikTokState('network_error')).not.toBe(describeTikTokState('not_configured'));
  });

  it('gives distinct text for invalid-input vs rate-limited', () => {
    expect(describeTikTokState('invalid_input')).not.toBe(describeTikTokState('rate_limited'));
  });

  it('never mentions implementation details (endpoint, FLV, resolver) in any message', () => {
    const states: Parameters<typeof describeTikTokState>[0][] = [
      'live',
      'offline',
      'invalid_creator',
      'no_stream_data',
      'no_playable_streams',
      'provider_error',
      'network_error',
      'upstream_http_error',
      'resolver_http_error',
      'not_configured',
      'invalid_input',
      'rate_limited',
    ];
    for (const state of states) {
      const text = describeTikTokState(state).toLowerCase();
      expect(text).not.toContain('flv');
      expect(text).not.toContain('api-live');
      expect(text).not.toContain('resolver');
    }
  });
});

describe('TIKTOK_LIVE_ENABLED', () => {
  it('is a boolean kill switch, currently enabled', () => {
    expect(typeof TIKTOK_LIVE_ENABLED).toBe('boolean');
    expect(TIKTOK_LIVE_ENABLED).toBe(true);
  });
});
