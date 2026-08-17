import { describe, expect, it, vi } from 'vitest';
import { resolveAddInput, plainUsernameCandidate, resolveLivePartyShareUrl } from './StreamToolbar';
import { parseStreamInput } from '../platforms';
import { isTikTokShortLink } from '../platforms/tiktok';

describe('resolveAddInput — TikTok LIVE explicit provider selection', () => {
  it('bare username resolves to a canonical TikTok LIVE URL and parses as tiktok', () => {
    const resolved = resolveAddInput('someuser', 'tiktok');
    expect(resolved).toBe('https://www.tiktok.com/@someuser/live');
    expect(parseStreamInput(resolved)).toEqual({ platform: 'tiktok', channel: 'someuser' });
  });

  it('@username resolves the same as a bare username', () => {
    const resolved = resolveAddInput('@someuser', 'tiktok');
    expect(resolved).toBe('https://www.tiktok.com/@someuser/live');
    expect(parseStreamInput(resolved)).toEqual({ platform: 'tiktok', channel: 'someuser' });
  });

  it('a full canonical LIVE URL passes through untouched', () => {
    const url = 'https://www.tiktok.com/@someuser/live';
    const resolved = resolveAddInput(url, 'tiktok');
    expect(resolved).toBe(url);
    expect(parseStreamInput(resolved)).toEqual({ platform: 'tiktok', channel: 'someuser' });
  });

  it('a long-form share URL (query params) still resolves as tiktok', () => {
    const url = 'https://www.tiktok.com/@someuser/live?is_from_webapp=1&sender_device=pc';
    const resolved = resolveAddInput(url, 'tiktok');
    expect(resolved).toBe(url);
    expect(parseStreamInput(resolved)).toEqual({ platform: 'tiktok', channel: 'someuser' });
  });

  it('a vt.tiktok.com short link passes through untouched and is flagged for async resolve', () => {
    const url = 'https://vt.tiktok.com/ZS6abcdef/';
    const resolved = resolveAddInput(url, 'tiktok');
    expect(resolved).toBe(url);
    expect(isTikTokShortLink(resolved)).toBe(true);
  });

  it('a vm.tiktok.com short link passes through untouched and is flagged for async resolve', () => {
    const url = 'https://vm.tiktok.com/ZS6abcdef/';
    const resolved = resolveAddInput(url, 'tiktok');
    expect(resolved).toBe(url);
    expect(isTikTokShortLink(resolved)).toBe(true);
  });

  it('with no explicit TikTok selection, a canonical TikTok URL still auto-detects as tiktok (unchanged)', () => {
    const url = 'https://www.tiktok.com/@someuser/live';
    const resolved = resolveAddInput(url, 'twitch');
    expect(resolved).toBe(url);
    expect(parseStreamInput(resolved)).toEqual({ platform: 'tiktok', channel: 'someuser' });
  });

  it('with no explicit TikTok selection, a bare username keeps the existing platform-specific behavior (unchanged)', () => {
    expect(resolveAddInput('someuser', 'twitch')).toBe('someuser');
    expect(resolveAddInput('someuser', 'kick')).toBe('k:someuser');
    expect(resolveAddInput('someuser', 'youtube')).toBe('y:handle:someuser');
  });

  it('a bare username is still a Twitch/Kick/YouTube suggestion candidate when TikTok is not selected', () => {
    expect(plainUsernameCandidate('someuser')).toBe('someuser');
  });
});

describe('resolveLivePartyShareUrl', () => {
  it('reuses the current live party URL without starting a second room', async () => {
    const start = vi.fn();
    const result = await resolveLivePartyShareUrl({
      getViewerUrl: () => 'https://multistream.cc/w/abcdefghij',
      start,
    });
    expect(result).toEqual({ ok: true, url: 'https://multistream.cc/w/abcdefghij' });
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a live party when none is running and returns that URL', async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, url: 'https://multistream.cc/w/newroomid1' });
    const result = await resolveLivePartyShareUrl({
      getViewerUrl: () => null,
      start,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, url: 'https://multistream.cc/w/newroomid1' });
  });

  it('surfaces a start failure instead of falling back to a static lineup URL', async () => {
    const start = vi.fn().mockResolvedValue({ ok: false, error: 'Add at least one stream first.' });
    const result = await resolveLivePartyShareUrl({
      getViewerUrl: () => null,
      start,
    });
    expect(result).toEqual({ ok: false, error: 'Add at least one stream first.' });
  });
});
