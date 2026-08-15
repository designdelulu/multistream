import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeTikTokState,
  isTikTokShortLink,
  resolveTikTokShareLink,
  TIKTOK_LIVE_ENABLED,
  tiktokAdapter,
  tiktokAvatarEndpoint,
} from './tiktok';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

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
      'timeout',
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

describe('isTikTokShortLink', () => {
  it('recognizes a real vt.tiktok.com share link (captured from an actual LIVE room Share sheet)', () => {
    expect(isTikTokShortLink('https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/')).toBe(true);
  });

  it('recognizes vm.tiktok.com — TikTok\'s other confirmed-owned short-link host', () => {
    expect(isTikTokShortLink('https://vm.tiktok.com/ZMxxxxxxx/')).toBe(true);
  });

  it('recognizes a schemeless short link', () => {
    expect(isTikTokShortLink('vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/')).toBe(true);
  });

  it('is false for the canonical tiktok.com domain — not a short link', () => {
    expect(isTikTokShortLink('https://www.tiktok.com/@creator/live')).toBe(false);
    expect(isTikTokShortLink('https://tiktok.com/@creator/live')).toBe(false);
  });

  it('is false for a non-TikTok shortener', () => {
    expect(isTikTokShortLink('https://bit.ly/abc123')).toBe(false);
    expect(isTikTokShortLink('https://vt.tiktokfake.com/abc/')).toBe(false);
  });

  it('is false for empty/garbage input', () => {
    expect(isTikTokShortLink('')).toBe(false);
    expect(isTikTokShortLink('   ')).toBe(false);
    expect(isTikTokShortLink('not a url $$$')).toBe(false);
  });
});

describe('resolveTikTokShareLink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the raw pasted short link unchanged — resolution happens server-side, not via a client fetch to TikTok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ live: true, state: 'live', username: 'itstaylaig', qualities: [], expiresAt: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveTikTokShareLink('https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ url: 'https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/' });
    expect(result.username).toBe('itstaylaig');
  });

  it('surfaces the resolved username even when the creator is currently offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ live: false, state: 'offline', username: 'itstaylaig', qualities: [], expiresAt: null }),
      ),
    );

    const result = await resolveTikTokShareLink('https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/');
    expect(result.state).toBe('offline');
    expect(result.username).toBe('itstaylaig');
  });

  it('maps a network failure to network_error with an empty username, same shape as resolveTikTokLive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    const result = await resolveTikTokShareLink('https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/');
    expect(result.state).toBe('network_error');
    expect(result.username).toBe('');
  });

  it('maps a non-ok HTTP response to resolver_http_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(null, false, 500)));

    const result = await resolveTikTokShareLink('https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/');
    expect(result.state).toBe('resolver_http_error');
  });
});

describe('tiktokAvatarEndpoint', () => {
  it('returns a same-origin proxy URL for a validated handle', () => {
    expect(tiktokAvatarEndpoint('creator')).toBe('/api/tiktok-avatar.php?u=creator');
    expect(tiktokAvatarEndpoint('user.name_1')).toBe('/api/tiktok-avatar.php?u=user.name_1');
  });
});
