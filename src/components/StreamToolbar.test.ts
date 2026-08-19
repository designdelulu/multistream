import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveAddInput,
  plainUsernameCandidate,
  usernameCandidatePlatforms,
  resolveLivePartyShareUrl,
  collectShareCardAvatarUrls,
  bindStreamToolbar,
  type OverlayHooks,
} from './StreamToolbar';
import { parseStreamInput } from '../platforms';
import { isTikTokShortLink } from '../platforms/tiktok';
import { createStreamStore } from '../state/streams';
import { createHeadersStore } from '../state/headers';
import { createViewModeStore } from '../state/viewMode';

function buildCard(dataset: Record<string, string>): HTMLElement {
  const card = document.createElement('article');
  card.className = 'stream-card';
  for (const [key, value] of Object.entries(dataset)) {
    card.dataset[key] = value;
  }
  return card;
}

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

  it('accepts a dotted handle and offers only compatible providers', () => {
    expect(plainUsernameCandidate('yonna.jay')).toBe('yonna.jay');
    expect(usernameCandidatePlatforms('yonna.jay')).toEqual(['youtube', 'tiktok']);
    expect(parseStreamInput(resolveAddInput('yonna.jay', 'tiktok'))).toEqual({
      platform: 'tiktok',
      channel: 'yonna.jay',
    });
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

describe('collectShareCardAvatarUrls', () => {
  it('prefers the avatar over the live thumbnail when both are present', () => {
    const root = document.createElement('div');
    root.append(
      buildCard({
        streamId: 'twitch:foo',
        platform: 'twitch',
        twitchAvatarUrl: 'https://static-cdn.jtvnw.net/foo.png',
        twitchThumbnailUrl: 'https://static-cdn.jtvnw.net/foo-live.jpg',
      }),
    );

    expect(collectShareCardAvatarUrls(root).get('twitch:foo')).toBe('https://static-cdn.jtvnw.net/foo.png');
  });

  it('falls back to the live Twitch thumbnail when no avatar resolved', () => {
    const root = document.createElement('div');
    root.append(
      buildCard({
        streamId: 'twitch:foo',
        platform: 'twitch',
        twitchThumbnailUrl: 'https://static-cdn.jtvnw.net/foo-live.jpg',
      }),
    );

    expect(collectShareCardAvatarUrls(root).get('twitch:foo')).toBe(
      'https://static-cdn.jtvnw.net/foo-live.jpg',
    );
  });

  it('collects each platform\'s avatar and skips cards with no imagery at all', () => {
    const root = document.createElement('div');
    root.append(
      buildCard({
        streamId: 'youtube:a',
        platform: 'youtube',
        youtubeAvatarUrl: 'https://yt3.ggpht.com/a.jpg',
      }),
      buildCard({ streamId: 'kick:b', platform: 'kick', kickAvatarUrl: 'https://files.kick.com/b.webp' }),
      buildCard({ streamId: 'tiktok:c', platform: 'tiktok', tiktokAvatarUrl: '/api/tiktok-avatar.php?handle=c' }),
      buildCard({ streamId: 'twitch:bare', platform: 'twitch' }),
    );

    const urls = collectShareCardAvatarUrls(root);
    expect(urls.get('youtube:a')).toBe('https://yt3.ggpht.com/a.jpg');
    expect(urls.get('kick:b')).toBe('https://files.kick.com/b.webp');
    expect(urls.get('tiktok:c')).toBe('/api/tiktok-avatar.php?handle=c');
    expect(urls.has('twitch:bare')).toBe(false);
  });
});

/**
 * The add-stream suggestions dropdown and the share/watch-party menu are
 * absolutely-positioned overlays that can cover the grid without resizing
 * it — nothing about their layout tells the grid they exist. These tests
 * pin the edge-triggering contract StreamGrid.ts's beginOverlayRecovery
 * depends on: fire once on the hidden->visible transition (never once per
 * keystroke, since suggestions re-renders on every keystroke while staying
 * open), and once on the visible->hidden transition, however that happens
 * (Escape, outside click, or a successful add).
 */
describe('bindStreamToolbar — overlay hooks for covering dropdowns', () => {
  function mountToolbarDom(): void {
    document.body.innerHTML = `
      <form id="add-stream-form">
        <div class="toolbar__input-wrap">
          <input id="stream-input" />
          <div id="add-stream-suggestions" hidden></div>
        </div>
        <button id="add-stream-submit" type="submit">Add Stream</button>
      </form>
      <div class="toolbar__share-menu-wrap">
        <button id="share-menu-toggle" type="button" aria-expanded="false"></button>
        <div id="share-menu" hidden></div>
      </div>
    `;
  }

  function setup(overlayHooks: OverlayHooks) {
    mountToolbarDom();
    const store = createStreamStore();
    const headersStore = createHeadersStore();
    const viewModeStore = createViewModeStore();
    bindStreamToolbar(
      store,
      headersStore,
      viewModeStore,
      {
        refresh: async () => ({ outcome: 'ok' as const, twitchAllUnavailable: false }),
        isRefreshInFlight: () => false,
      },
      undefined,
      undefined,
      overlayHooks,
    );
    return {
      store,
      input: document.querySelector<HTMLInputElement>('#stream-input')!,
      shareToggle: document.querySelector<HTMLButtonElement>('#share-menu-toggle')!,
    };
  }

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('opening the suggestions dropdown fires onOverlayOpen once, not on every keystroke', () => {
    const onOverlayOpen = vi.fn();
    const onOverlayClose = vi.fn();
    const { input } = setup({ onOverlayOpen, onOverlayClose });

    for (const value of ['t', 'te', 'tes', 'test']) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }

    expect(onOverlayOpen).toHaveBeenCalledTimes(1);
    expect(onOverlayClose).not.toHaveBeenCalled();
  });

  it('pressing Escape closes the dropdown and fires onOverlayClose exactly once', () => {
    const onOverlayOpen = vi.fn();
    const onOverlayClose = vi.fn();
    const { input } = setup({ onOverlayOpen, onOverlayClose });

    input.value = 'test';
    input.dispatchEvent(new Event('input'));
    expect(onOverlayOpen).toHaveBeenCalledTimes(1);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onOverlayClose).toHaveBeenCalledTimes(1);
  });

  it('an outside click closes the dropdown once, and a second outside click while already closed does not re-fire', () => {
    const onOverlayOpen = vi.fn();
    const onOverlayClose = vi.fn();
    const { input } = setup({ onOverlayOpen, onOverlayClose });

    input.value = 'test';
    input.dispatchEvent(new Event('input'));
    expect(onOverlayOpen).toHaveBeenCalledTimes(1);

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOverlayClose).toHaveBeenCalledTimes(1);

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOverlayClose).toHaveBeenCalledTimes(1);
  });

  it('selecting a suggestion adds the stream, closes the dropdown, and fires onOverlayClose once', () => {
    const onOverlayOpen = vi.fn();
    const onOverlayClose = vi.fn();
    const { input, store } = setup({ onOverlayOpen, onOverlayClose });

    input.value = 'teststreamer123';
    input.dispatchEvent(new Event('input'));
    expect(onOverlayOpen).toHaveBeenCalledTimes(1);

    const twitchOption = document.querySelector<HTMLButtonElement>(
      '.toolbar__suggestion[data-platform="twitch"]',
    );
    expect(twitchOption).toBeTruthy();
    twitchOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(store.getStreams().some((stream) => stream.id === 'twitch:teststreamer123')).toBe(true);
    expect(onOverlayClose).toHaveBeenCalledTimes(1);
  });

  it('opening the share menu fires onOverlayOpen with its own rect; closing it fires onOverlayClose', () => {
    const onOverlayOpen = vi.fn();
    const onOverlayClose = vi.fn();
    const { shareToggle } = setup({ onOverlayOpen, onOverlayClose });

    shareToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOverlayOpen).toHaveBeenCalledTimes(1);
    const rect = onOverlayOpen.mock.calls[0][0] as DOMRect;
    expect(typeof rect.width).toBe('number');

    shareToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOverlayClose).toHaveBeenCalledTimes(1);
  });
});
