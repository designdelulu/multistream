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

describe('iPad stream cap', () => {
  const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)';
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  let restoreNavigator: (() => void) | null = null;

  function asDevice(userAgent: string, platform: string, maxTouchPoints: number): void {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent, platform, maxTouchPoints },
      configurable: true,
    });
    restoreNavigator = () => {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    };
  }

  function setup() {
    document.body.innerHTML = `
      <form id="add-stream-form">
        <div class="toolbar__input-wrap">
          <input id="stream-input" />
          <div id="add-stream-suggestions" hidden></div>
        </div>
        <button id="add-stream-submit" type="submit">Add Stream</button>
      </form>
      <button id="refresh-streams" type="button"></button>
      <button id="headers-toggle" type="button">
        <span class="toolbar__icon-btn-label"></span>
      </button>
      <p id="ipad-stream-note"></p>
    `;
    const store = createStreamStore();
    // createStreamStore hydrates from the URL, and jsdom's location persists
    // across every test in this file — without this the lineup arrives
    // pre-populated by whatever ran before.
    store.clearStreams();
    bindStreamToolbar(store, createHeadersStore(), createViewModeStore(), {
      refresh: async () => ({ outcome: 'ok' as const, twitchAllUnavailable: false }),
      isRefreshInFlight: () => false,
    });
    return {
      store,
      form: document.querySelector<HTMLFormElement>('#add-stream-form')!,
      input: document.querySelector<HTMLInputElement>('#stream-input')!,
      submit: document.querySelector<HTMLButtonElement>('#add-stream-submit')!,
      headers: document.querySelector<HTMLButtonElement>('#headers-toggle')!,
      note: document.querySelector<HTMLElement>('#ipad-stream-note')!,
    };
  }

  function fill(store: ReturnType<typeof createStreamStore>, count: number): void {
    for (let i = 0; i < count; i += 1) store.addStream(`t:streamer${i}`);
  }

  function submitValue(
    ctx: ReturnType<typeof setup>,
    value: string,
  ): void {
    ctx.input.value = value;
    ctx.input.dispatchEvent(new Event('input'));
    ctx.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    ctx.form.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  afterEach(() => {
    restoreNavigator?.();
    restoreNavigator = null;
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('refuses the eleventh manual add on iPad and says why', () => {
    asDevice(IPAD_UA, 'iPad', 5);
    const ctx = setup();
    fill(ctx.store, 10);
    expect(ctx.store.getStreams()).toHaveLength(10);

    submitValue(ctx, 't:onemore');

    expect(ctx.store.getStreams()).toHaveLength(10);
    expect(ctx.input.getAttribute('aria-invalid')).toBe('stream-limit');
    expect(ctx.note.textContent).toContain('Remove one to add another');
  });

  it('adds normally below the cap on iPad', () => {
    asDevice(IPAD_UA, 'iPad', 5);
    const ctx = setup();
    fill(ctx.store, 9);

    submitValue(ctx, 't:onemore');

    expect(ctx.store.getStreams()).toHaveLength(10);
  });

  it('does not cap desktop', () => {
    asDevice(MAC_UA, 'MacIntel', 0);
    const ctx = setup();
    fill(ctx.store, 12);

    submitValue(ctx, 't:onemore');

    expect(ctx.store.getStreams()).toHaveLength(13);
  });

  it('reports an over-cap lineup without trimming it — a shared link or party host always loads in full', () => {
    asDevice(IPAD_UA, 'iPad', 5);
    const ctx = setup();
    // replaceLineup is the watch-party/URL-restore path; trimming here would
    // desync a viewer from the host, so the cap must not touch it.
    ctx.store.replaceLineup(
      Array.from({ length: 12 }, (_, i) => ({
        platform: 'twitch' as const,
        channel: `streamer${i}`,
      })),
    );

    expect(ctx.store.getStreams()).toHaveLength(12);
    expect(ctx.note.textContent).toContain('12 streams loaded');
    expect(ctx.note.textContent).toContain('10 or fewer');
  });

  it('disables the Add button at the cap and re-enables it once a stream is removed', () => {
    asDevice(IPAD_UA, 'iPad', 5);
    const ctx = setup();
    fill(ctx.store, 10);
    expect(ctx.submit.disabled).toBe(true);

    ctx.store.removeStream(ctx.store.getStreams()[0].id);
    expect(ctx.submit.disabled).toBe(false);
  });

  it('keeps Hide Headers available on a phone but hidden on iPad', () => {
    asDevice(MAC_UA, 'MacIntel', 0);
    const phone = setup();
    expect(phone.headers.hidden).toBe(false);
    restoreNavigator?.();

    asDevice(IPAD_UA, 'iPad', 5);
    const ipad = setup();
    expect(ipad.headers.hidden).toBe(true);
  });
});
