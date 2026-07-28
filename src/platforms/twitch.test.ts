import { describe, expect, it } from 'vitest';
import { twitchAdapter, twitchParentList } from './twitch';

describe('twitchAdapter.parseInput', () => {
  it('parses a plain username', () => {
    expect(twitchAdapter.parseInput('shroud')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('lowercases the channel', () => {
    expect(twitchAdapter.parseInput('ShRouD')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('strips a leading @', () => {
    expect(twitchAdapter.parseInput('@shroud')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('accepts the t: prefix', () => {
    expect(twitchAdapter.parseInput('t:shroud')).toEqual({ platform: 'twitch', channel: 'shroud' });
  });

  it('accepts the legacy twitch: prefix', () => {
    expect(twitchAdapter.parseInput('twitch:shroud')).toEqual({
      platform: 'twitch',
      channel: 'shroud',
    });
  });

  it('accepts a bare twitch.tv URL', () => {
    expect(twitchAdapter.parseInput('twitch.tv/shroud')).toEqual({
      platform: 'twitch',
      channel: 'shroud',
    });
  });

  it('accepts a full https URL with www', () => {
    expect(twitchAdapter.parseInput('https://www.twitch.tv/shroud')).toEqual({
      platform: 'twitch',
      channel: 'shroud',
    });
  });

  it('accepts the m. mobile subdomain', () => {
    expect(twitchAdapter.parseInput('https://m.twitch.tv/shroud')).toEqual({
      platform: 'twitch',
      channel: 'shroud',
    });
  });

  it('rejects a non-Twitch host', () => {
    expect(twitchAdapter.parseInput('https://kick.com/shroud')).toBeNull();
  });

  it('rejects the /videos path', () => {
    expect(twitchAdapter.parseInput('twitch.tv/videos')).toBeNull();
  });

  it('rejects the /directory path', () => {
    expect(twitchAdapter.parseInput('twitch.tv/directory')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(twitchAdapter.parseInput('')).toBeNull();
  });

  it('rejects a username with invalid characters', () => {
    expect(twitchAdapter.parseInput('bad name!')).toBeNull();
  });

  it('rejects a username over 25 characters', () => {
    expect(twitchAdapter.parseInput('a'.repeat(26))).toBeNull();
  });
});

describe('twitchAdapter.buildEmbedUrl', () => {
  it('includes channel, muted, autoplay, and parent', () => {
    const url = twitchAdapter.buildEmbedUrl(
      { platform: 'twitch', channel: 'shroud' },
      { muted: true, parent: 'multistream.cc' },
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://player.twitch.tv/');
    expect(parsed.searchParams.get('channel')).toBe('shroud');
    expect(parsed.searchParams.get('muted')).toBe('true');
    expect(parsed.searchParams.get('autoplay')).toBe('true');
    expect(parsed.searchParams.getAll('parent')).toEqual(['multistream.cc']);
  });

  it('omits autoplay when explicitly disabled', () => {
    const url = twitchAdapter.buildEmbedUrl(
      { platform: 'twitch', channel: 'shroud' },
      { muted: false, parent: 'multistream.cc', autoplay: false },
    );
    expect(new URL(url).searchParams.has('autoplay')).toBe(false);
  });

  it('sends the dual localhost/127.0.0.1 parent pair in dev', () => {
    const url = twitchAdapter.buildEmbedUrl(
      { platform: 'twitch', channel: 'shroud' },
      { muted: true, parent: 'localhost' },
    );
    expect(new URL(url).searchParams.getAll('parent')).toEqual(['localhost', '127.0.0.1']);
  });
});

describe('twitchAdapter.buildChatEmbedUrl', () => {
  it('builds a chat popout URL with the channel and parent', () => {
    const url = twitchAdapter.buildChatEmbedUrl?.(
      { platform: 'twitch', channel: 'shroud' },
      { muted: true, parent: 'multistream.cc' },
    );
    expect(url).toContain('https://www.twitch.tv/embed/shroud/chat?');
    expect(url).toContain('parent=multistream.cc');
    expect(url).toContain('darkpopout');
  });
});

describe('twitchAdapter.displayName', () => {
  it('returns the channel name', () => {
    expect(twitchAdapter.displayName({ channel: 'shroud' })).toBe('shroud');
  });
});

describe('twitchParentList', () => {
  it('returns just the hostname in production', () => {
    expect(twitchParentList('multistream.cc')).toEqual(['multistream.cc']);
  });

  it('pairs localhost with 127.0.0.1', () => {
    expect(twitchParentList('localhost')).toEqual(['localhost', '127.0.0.1']);
  });

  it('pairs 127.0.0.1 with localhost', () => {
    expect(twitchParentList('127.0.0.1')).toEqual(['127.0.0.1', 'localhost']);
  });
});
