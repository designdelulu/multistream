import { describe, expect, it } from 'vitest';
import { kickAdapter } from './kick';

describe('kickAdapter.parseInput', () => {
  // Unlike Twitch, Kick has no bare-username fallback here — a plain name is
  // ambiguous between platforms, so StreamToolbar's resolveAddInput() always
  // adds the k: prefix upstream before this ever sees a Kick submission.
  it('rejects a plain username with no prefix', () => {
    expect(kickAdapter.parseInput('trainwreckstv')).toBeNull();
  });

  it('lowercases the channel from a prefixed username', () => {
    expect(kickAdapter.parseInput('k:TrainwrecksTV')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('strips a leading @ before matching the prefix', () => {
    expect(kickAdapter.parseInput('@k:trainwreckstv')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('accepts the k: prefix', () => {
    expect(kickAdapter.parseInput('k:trainwreckstv')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('accepts the legacy kick: prefix', () => {
    expect(kickAdapter.parseInput('kick:trainwreckstv')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('accepts a bare kick.com URL', () => {
    expect(kickAdapter.parseInput('kick.com/trainwreckstv')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('accepts a full https URL with www', () => {
    expect(kickAdapter.parseInput('https://www.kick.com/trainwreckstv')).toEqual({
      platform: 'kick',
      channel: 'trainwreckstv',
    });
  });

  it('rejects a non-Kick host', () => {
    expect(kickAdapter.parseInput('https://twitch.tv/trainwreckstv')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(kickAdapter.parseInput('')).toBeNull();
  });

  it('rejects a bare hostname with no channel path', () => {
    expect(kickAdapter.parseInput('kick.com')).toBeNull();
  });
});

describe('kickAdapter.buildEmbedUrl', () => {
  it('includes muted, autoplay, and playsinline', () => {
    const url = kickAdapter.buildEmbedUrl(
      { platform: 'kick', channel: 'trainwreckstv' },
      { muted: true, parent: 'multistream.cc' },
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://player.kick.com/trainwreckstv');
    expect(parsed.searchParams.get('muted')).toBe('true');
    expect(parsed.searchParams.get('autoplay')).toBe('true');
    expect(parsed.searchParams.get('playsinline')).toBe('true');
    expect(parsed.searchParams.get('parent')).toBe('multistream.cc');
  });

  it('defaults autoplay to true when unspecified', () => {
    const url = kickAdapter.buildEmbedUrl(
      { platform: 'kick', channel: 'trainwreckstv' },
      { muted: false, parent: 'multistream.cc' },
    );
    expect(new URL(url).searchParams.get('autoplay')).toBe('true');
  });

  it('honors autoplay: false', () => {
    const url = kickAdapter.buildEmbedUrl(
      { platform: 'kick', channel: 'trainwreckstv' },
      { muted: false, parent: 'multistream.cc', autoplay: false },
    );
    expect(new URL(url).searchParams.get('autoplay')).toBe('false');
  });

  it('encodes the channel in the path', () => {
    const url = kickAdapter.buildEmbedUrl(
      { platform: 'kick', channel: 'weird name' },
      { muted: true, parent: 'multistream.cc' },
    );
    expect(url).toContain('/weird%20name?');
  });
});

describe('kickAdapter.displayName', () => {
  it('returns the channel name', () => {
    expect(kickAdapter.displayName({ channel: 'trainwreckstv' })).toBe('trainwreckstv');
  });
});
