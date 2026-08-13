import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTwitchDurationTimerForTests,
  __resetTwitchMutePollTimerForTests,
  __resetYouTubeDurationTimerForTests,
  applyTwitchStatus,
  applyYouTubeStats,
  bindFocusViewPromotion,
  getFocusViewPrimaryId,
  refreshAllTwitchStatuses,
  refreshAllYouTubeStats,
  refreshTwitchStatus,
  refreshYouTubeStats,
  setFocusViewPrimary,
  snapshotPlayingTwitchPlayers,
  syncStreamGrid,
  syncViewMode,
  twitchStatusDotProps,
} from './StreamGrid';
import { createStreamStore, type StreamStore } from '../state/streams';
import type { StreamRef } from '../types';
import type { TwitchStatusResult } from '../platforms/twitchStatus';
import type { YouTubeStatsResult } from '../platforms/youtubeStats';

function liveResult(channel: string, overrides: Partial<TwitchStatusResult> = {}): TwitchStatusResult {
  return {
    status: 'live',
    input: channel,
    normalized: channel,
    category: 'Just Chatting',
    viewerCount: 42,
    startedAt: new Date(Date.now() - 37 * 60_000).toISOString(),
    ...overrides,
  } as TwitchStatusResult;
}

function offlineResult(channel: string): TwitchStatusResult {
  return { status: 'offline', input: channel, normalized: channel };
}

function notFoundResult(channel: string): TwitchStatusResult {
  return { status: 'not_found', input: channel, normalized: channel };
}

function unavailableResult(channel: string): TwitchStatusResult {
  return { status: 'unavailable', input: channel, normalized: channel };
}

/**
 * Builds a DOM subtree shaped like a real Twitch stream-card: two
 * .stream-card__name-badge-dot instances (header + hover toolbar, per
 * createNameBadge being used in both places), a header-only
 * .stream-card__name-badge-meta, and a mounted iframe standing in for the
 * real Twitch player — so tests can assert its identity/src are never
 * touched by status-only DOM updates.
 */
function buildTwitchCard(channel: string): { card: HTMLElement; iframe: HTMLIFrameElement } {
  const card = document.createElement('article');
  card.className = 'stream-card stream-card--twitch';
  card.dataset.platform = 'twitch';
  card.dataset.channel = channel;

  const header = document.createElement('div');
  header.className = 'stream-card__header';
  const headerBadge = document.createElement('div');
  headerBadge.className = 'stream-card__name-badge';
  const headerDot = document.createElement('span');
  headerDot.className = 'stream-card__name-badge-dot';
  headerDot.setAttribute('aria-hidden', 'true');
  const headerMeta = document.createElement('span');
  headerMeta.className = 'stream-card__name-badge-meta';
  headerMeta.hidden = true;
  headerBadge.append(headerDot, headerMeta);
  header.append(headerBadge);

  const player = document.createElement('div');
  player.className = 'stream-card__player';
  const mount = document.createElement('div');
  mount.className = 'stream-card__iframe';
  const iframe = document.createElement('iframe');
  iframe.src = `https://player.twitch.tv/?channel=${channel}`;
  mount.append(iframe);
  player.append(mount);

  const toolbar = document.createElement('div');
  toolbar.className = 'stream-card__toolbar';
  const toolbarBadge = document.createElement('div');
  toolbarBadge.className = 'stream-card__name-badge';
  const toolbarDot = document.createElement('span');
  toolbarDot.className = 'stream-card__name-badge-dot';
  toolbarDot.setAttribute('aria-hidden', 'true');
  toolbarBadge.append(toolbarDot);
  toolbar.append(toolbarBadge);

  card.append(header, player, toolbar);
  return { card, iframe };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

/**
 * Builds a DOM subtree shaped like a real YouTube stream-card: a header-only
 * .stream-card__name-badge-meta (see createNameBadge's includeMeta), and
 * `data-youtube-video-id` already set the way startYouTubePlayer/
 * resolveAndMountYouTubeChannel set it once mounted — applyYouTubeStats
 * matches results against that, never the stream's raw channel token.
 */
function buildYouTubeCard(videoId: string): { card: HTMLElement } {
  const card = document.createElement('article');
  card.className = 'stream-card stream-card--youtube';
  card.dataset.platform = 'youtube';
  card.dataset.channel = `video:${videoId}`;
  card.dataset.youtubeVideoId = videoId;

  const header = document.createElement('div');
  header.className = 'stream-card__header';
  const headerBadge = document.createElement('div');
  headerBadge.className = 'stream-card__name-badge';
  const headerMeta = document.createElement('span');
  headerMeta.className = 'stream-card__name-badge-meta';
  headerMeta.hidden = true;
  headerBadge.append(headerMeta);
  header.append(headerBadge);

  card.append(header);
  return { card };
}

function liveStats(videoId: string, overrides: Partial<YouTubeStatsResult> = {}): YouTubeStatsResult {
  return {
    videoId,
    status: 'live',
    viewerCount: 42,
    startedAt: new Date(Date.now() - 37 * 60_000).toISOString(),
    title: 'Some stream',
    ...overrides,
  };
}

function endedStats(videoId: string): YouTubeStatsResult {
  return { videoId, status: 'ended' };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetTwitchDurationTimerForTests();
  __resetYouTubeDurationTimerForTests();
  document.body.innerHTML = '';
});

describe('twitchStatusDotProps', () => {
  it('maps live', () => {
    expect(twitchStatusDotProps(liveResult('foo'))).toEqual({ modifier: 'live', label: 'Live' });
  });
  it('maps offline', () => {
    expect(twitchStatusDotProps(offlineResult('foo'))).toEqual({
      modifier: 'offline',
      label: 'Offline',
    });
  });
  it('maps not_found', () => {
    expect(twitchStatusDotProps(notFoundResult('foo'))).toEqual({
      modifier: 'not_found',
      label: 'Not found',
    });
  });
  it('maps unavailable', () => {
    expect(twitchStatusDotProps(unavailableResult('foo'))).toEqual({
      modifier: 'unavailable',
      label: 'Unavailable',
    });
  });
  it('maps invalid_input to null', () => {
    expect(
      twitchStatusDotProps({ status: 'invalid_input', input: 'x', normalized: 'x' } as TwitchStatusResult),
    ).toBeNull();
  });
});

describe('applyTwitchStatus — dot + meta rendering', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  it('renders viewer count + duration (no category) on the header meta span, but keeps category on the dot tooltip, for a live result', () => {
    const { card } = buildTwitchCard('foo');
    container.append(card);

    applyTwitchStatus(container, new Map([['foo', liveResult('foo')]]));

    const dots = card.querySelectorAll<HTMLElement>('.stream-card__name-badge-dot');
    expect(dots).toHaveLength(2);
    for (const dot of dots) {
      expect(dot.classList.contains('stream-card__name-badge-dot--live')).toBe(true);
      expect(dot.classList.contains('stream-card__name-badge-dot--pulse')).toBe(true);
      expect(dot.getAttribute('aria-hidden')).toBe('false');
      // Category still shows up here — the tooltip costs no header space.
      expect(dot.title).toBe('Live · Just Chatting · 42 viewers · 37m');
    }

    const meta = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
    expect(meta?.hidden).toBe(false);
    expect(meta?.textContent).toBe('· 42 viewers · 37m');
  });

  it('hides the meta span once no viewer count or duration is available', () => {
    const { card } = buildTwitchCard('foo');
    container.append(card);

    applyTwitchStatus(
      container,
      new Map([['foo', liveResult('foo', { category: undefined, viewerCount: undefined, startedAt: undefined })]]),
    );

    const meta = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
    expect(meta?.hidden).toBe(true);
    expect(meta?.textContent).toBe('');
  });

  it('renders offline with a muted, non-pulsing dot and no meta text', () => {
    const { card } = buildTwitchCard('foo');
    container.append(card);

    applyTwitchStatus(container, new Map([['foo', offlineResult('foo')]]));

    const dot = card.querySelector<HTMLElement>('.stream-card__name-badge-dot');
    expect(dot?.classList.contains('stream-card__name-badge-dot--offline')).toBe(true);
    expect(dot?.classList.contains('stream-card__name-badge-dot--pulse')).toBe(false);
    expect(dot?.title).toBe('Offline');

    const meta = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
    expect(meta?.hidden).toBe(true);
    expect(meta?.textContent).toBe('');
  });

  it('renders not_found and unavailable with distinct, non-pulsing modifiers', () => {
    const notFound = buildTwitchCard('foo');
    const unavailable = buildTwitchCard('bar');
    container.append(notFound.card, unavailable.card);

    applyTwitchStatus(
      container,
      new Map([
        ['foo', notFoundResult('foo')],
        ['bar', unavailableResult('bar')],
      ]),
    );

    const notFoundDot = notFound.card.querySelector<HTMLElement>('.stream-card__name-badge-dot');
    expect(notFoundDot?.classList.contains('stream-card__name-badge-dot--not_found')).toBe(true);
    expect(notFoundDot?.title).toBe('Not found');

    const unavailableDot = unavailable.card.querySelector<HTMLElement>('.stream-card__name-badge-dot');
    expect(unavailableDot?.classList.contains('stream-card__name-badge-dot--unavailable')).toBe(true);
    expect(unavailableDot?.title).toBe('Unavailable');
  });

  it('removes live-only metadata when a later result changes the card to offline', () => {
    const { card } = buildTwitchCard('foo');
    container.append(card);

    applyTwitchStatus(container, new Map([['foo', liveResult('foo')]]));
    expect(card.dataset.twitchStartedAt).toBeDefined();
    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).not.toBe('');

    applyTwitchStatus(container, new Map([['foo', offlineResult('foo')]]));
    expect(card.dataset.twitchStartedAt).toBeUndefined();
    expect(card.dataset.twitchCategory).toBeUndefined();
    expect(card.dataset.twitchViewerCount).toBeUndefined();
    expect(card.querySelector<HTMLElement>('.stream-card__name-badge-meta')?.hidden).toBe(true);
    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).toBe('');
  });

  it('leaves a card with no matching result untouched', () => {
    const { card } = buildTwitchCard('foo');
    container.append(card);

    applyTwitchStatus(container, new Map([['foo', liveResult('foo')]]));
    const dotBefore = card.querySelector('.stream-card__name-badge-dot')?.className;

    applyTwitchStatus(container, new Map()); // no result for 'foo' this time

    expect(card.querySelector('.stream-card__name-badge-dot')?.className).toBe(dotBefore);
  });

  it('never touches the iframe element identity or src', () => {
    const { card, iframe } = buildTwitchCard('foo');
    container.append(card);
    const originalSrc = iframe.src;

    applyTwitchStatus(container, new Map([['foo', liveResult('foo')]]));
    applyTwitchStatus(container, new Map([['foo', offlineResult('foo')]]));
    applyTwitchStatus(container, new Map([['foo', liveResult('foo')]]));

    const iframeAfter = card.querySelector('iframe');
    expect(iframeAfter).toBe(iframe); // same element reference
    expect(iframeAfter?.src).toBe(originalSrc);
  });

  it('handles mixed Twitch, Kick, and YouTube cards — only touches Twitch ones', () => {
    const { card: twitchCard } = buildTwitchCard('foo');
    const kickCard = document.createElement('article');
    kickCard.className = 'stream-card stream-card--kick';
    kickCard.dataset.platform = 'kick';
    kickCard.dataset.channel = 'somekick';
    const youtubeCard = document.createElement('article');
    youtubeCard.className = 'stream-card stream-card--youtube';
    youtubeCard.dataset.platform = 'youtube';
    youtubeCard.dataset.channel = 'someyoutube';
    container.append(twitchCard, kickCard, youtubeCard);

    expect(() =>
      applyTwitchStatus(container, new Map([['foo', liveResult('foo')]])),
    ).not.toThrow();

    expect(twitchCard.querySelector('.stream-card__name-badge-dot')?.className).toContain('--live');
    expect(kickCard.querySelector('.stream-card__name-badge-dot')).toBeNull();
  });
});

describe('applyTwitchStatus — shared duration timer', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  it('updates the meta line on a 60s tick without any new network request', () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { card } = buildTwitchCard('foo');
    container.append(card);
    applyTwitchStatus(container, new Map([['foo', liveResult('foo')]]));
    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).toBe('· 42 viewers · 37m');

    vi.advanceTimersByTime(60_000);

    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).toBe('· 42 viewers · 38m');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops the timer once no live Twitch card remains', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, 'clearInterval');

    const { card } = buildTwitchCard('foo');
    container.append(card);
    applyTwitchStatus(container, new Map([['foo', liveResult('foo')]]));

    applyTwitchStatus(container, new Map([['foo', offlineResult('foo')]]));

    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('refreshTwitchStatus / refreshAllTwitchStatuses — batching', () => {
  it('refreshTwitchStatus sends exactly one batched request for many channels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ platform: 'twitch', results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const container = document.createElement('div');
    document.body.append(container);
    const cards = ['a', 'b', 'c'].map((ch) => buildTwitchCard(ch).card);
    container.append(...cards);

    refreshTwitchStatus(container, ['a', 'b', 'c']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    document.body.innerHTML = '';
  });

  it('refreshTwitchStatus with an empty channel list makes no request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');

    refreshTwitchStatus(container, []);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshAllTwitchStatuses collects Twitch-only channels from the store, deduped and lowercased', async () => {
    const grid = document.createElement('div');
    grid.id = 'stream-grid';
    document.body.append(grid);
    for (const ch of ['Foo', 'bar']) grid.append(buildTwitchCard(ch).card);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ platform: 'twitch', results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const store = createStreamStore() as StreamStore;
    vi.spyOn(store, 'getStreams').mockReturnValue([
      { id: 't:Foo', platform: 'twitch', channel: 'Foo', muted: true, orientation: 'landscape' },
      { id: 't:bar', platform: 'twitch', channel: 'bar', muted: true, orientation: 'landscape' },
      { id: 'k:baz', platform: 'kick', channel: 'baz', muted: true, orientation: 'landscape' },
    ]);

    const result = await refreshAllTwitchStatuses(store, 'manual');

    expect(result.outcome).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).channels).toEqual(['foo', 'bar']);

    document.body.innerHTML = '';
  });

  it('refreshAllTwitchStatuses with no Twitch cards resolves to skipped-empty and makes no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const store = createStreamStore() as StreamStore;
    vi.spyOn(store, 'getStreams').mockReturnValue([
      { id: 'k:baz', platform: 'kick', channel: 'baz', muted: true, orientation: 'landscape' },
    ]);

    const result = await refreshAllTwitchStatuses(store, 'manual');

    expect(result.outcome).toBe('skipped-empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('applyYouTubeStats — meta rendering', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  it('renders viewer count + duration on the header meta span for a live result', () => {
    const { card } = buildYouTubeCard('abc123');
    container.append(card);

    applyYouTubeStats(container, new Map([['abc123', liveStats('abc123')]]));

    const meta = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
    expect(meta?.hidden).toBe(false);
    expect(meta?.textContent).toBe('· 42 viewers · 37m');
  });

  it('clears viewer count + duration once the video is no longer live', () => {
    const { card } = buildYouTubeCard('abc123');
    container.append(card);

    applyYouTubeStats(container, new Map([['abc123', liveStats('abc123')]]));
    expect(card.dataset.youtubeStartedAt).toBeDefined();

    applyYouTubeStats(container, new Map([['abc123', endedStats('abc123')]]));

    expect(card.dataset.youtubeViewerCount).toBeUndefined();
    expect(card.dataset.youtubeStartedAt).toBeUndefined();
    const meta = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
    expect(meta?.hidden).toBe(true);
    expect(meta?.textContent).toBe('');
  });

  it('leaves a card whose videoId has no matching result untouched', () => {
    const { card } = buildYouTubeCard('abc123');
    container.append(card);
    applyYouTubeStats(container, new Map([['abc123', liveStats('abc123')]]));
    const before = card.querySelector('.stream-card__name-badge-meta')?.textContent;

    applyYouTubeStats(container, new Map()); // no result for 'abc123' this time

    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).toBe(before);
  });

  it('ignores a card with no data-youtube-video-id yet (not mounted/resolved)', () => {
    const { card } = buildYouTubeCard('abc123');
    delete card.dataset.youtubeVideoId;
    container.append(card);

    expect(() =>
      applyYouTubeStats(container, new Map([['abc123', liveStats('abc123')]])),
    ).not.toThrow();
    expect(card.querySelector<HTMLElement>('.stream-card__name-badge-meta')?.hidden).toBe(true);
  });
});

describe('applyYouTubeStats — shared duration timer', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  it('updates the meta line on a 60s tick without any new network request', () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { card } = buildYouTubeCard('abc123');
    container.append(card);
    applyYouTubeStats(container, new Map([['abc123', liveStats('abc123')]]));
    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).toBe('· 42 viewers · 37m');

    vi.advanceTimersByTime(60_000);

    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).toBe('· 42 viewers · 38m');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops the timer once no live YouTube card remains', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, 'clearInterval');

    const { card } = buildYouTubeCard('abc123');
    container.append(card);
    applyYouTubeStats(container, new Map([['abc123', liveStats('abc123')]]));

    applyYouTubeStats(container, new Map([['abc123', endedStats('abc123')]]));

    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('refreshYouTubeStats / refreshAllYouTubeStats — batching', () => {
  it('refreshYouTubeStats sends exactly one batched request for many videoIds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const container = document.createElement('div');
    document.body.append(container);
    const cards = ['a', 'b', 'c'].map((id) => buildYouTubeCard(id).card);
    container.append(...cards);

    refreshYouTubeStats(container, ['a', 'b', 'c']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    document.body.innerHTML = '';
  });

  it('refreshYouTubeStats with an empty videoId list makes no request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');

    refreshYouTubeStats(container, []);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshAllYouTubeStats collects videoIds from mounted DOM cards, not the store', async () => {
    const grid = document.createElement('div');
    grid.id = 'stream-grid';
    document.body.append(grid);
    for (const id of ['vid1', 'vid2']) grid.append(buildYouTubeCard(id).card);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllYouTubeStats(grid, 'periodic');

    expect(result.outcome).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('ids=vid1%2Cvid2');

    document.body.innerHTML = '';
  });

  it('refreshAllYouTubeStats with no YouTube cards resolves to skipped-empty and makes no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const grid = document.createElement('div');

    const result = await refreshAllYouTubeStats(grid, 'periodic');

    expect(result.outcome).toBe('skipped-empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Regression coverage for the mixed-provider "adding a YouTube Short pauses
 * every existing Twitch player" bug. Root cause: snapshotPlayingTwitchPlayers
 * trusted the `twitchPlayback` PLAYING-event latch, which does not reliably
 * fire for every stream Twitch is actually playing — so the fast (~4-5s)
 * add/remove recovery pass saw an empty snapshot and had nothing to resume,
 * leaving genuinely-playing Twitch streams stuck until the much slower ~90s
 * watchdog. It was never a DOM/player teardown bug (syncStreamGrid's stable
 * `data-stream-id` Map diff already only creates cards for genuinely new
 * ids), but this test proves that identity claim directly rather than by
 * inference, alongside the snapshot fix itself, by driving the real
 * createPlayerElement -> mountStreamMedia -> constructTwitchPlayer path with
 * a fake Twitch.Player/YT.Player (jsdom has neither real embed SDK).
 */
describe('syncStreamGrid — mixed-provider player identity (Twitch pause regression)', () => {
  class FakeTwitchPlayer {
    static readonly READY = 'READY';
    static readonly PLAY = 'PLAY';
    static readonly PLAYING = 'PLAYING';
    static readonly PAUSE = 'PAUSE';
    static readonly ENDED = 'ENDED';
    static readonly PLAYBACK_BLOCKED = 'PLAYBACK_BLOCKED';
    static readonly OFFLINE = 'OFFLINE';
    static readonly ONLINE = 'ONLINE';

    paused = false;
    pauseCallCount = 0;
    destroyCallCount = 0;
    private listeners = new Map<string, Array<() => void>>();

    constructor(
      public elementId: string,
      public options: Twitch.PlayerOptions,
    ) {}
    play(): void {
      this.paused = false;
    }
    pause(): void {
      this.paused = true;
      this.pauseCallCount += 1;
    }
    isPaused(): boolean {
      return this.paused;
    }
    setMuted(): void {}
    getMuted(): boolean {
      return false;
    }
    setChannel(): void {}
    getCurrentTime(): number {
      return 0;
    }
    getPlaybackStats(): Twitch.PlaybackStats {
      return {};
    }
    addEventListener(event: string, callback: () => void): void {
      const list = this.listeners.get(event) ?? [];
      list.push(callback);
      this.listeners.set(event, list);
    }
    removeEventListener(): void {}
    destroy(): void {
      this.destroyCallCount += 1;
    }
    /** Test-only: fires every callback constructTwitchPlayer registered for `event`. */
    emit(event: string): void {
      for (const callback of this.listeners.get(event) ?? []) callback();
    }
  }

  class FakeYouTubePlayer {
    constructor(
      public elementId: string,
      public options: { events?: { onReady?: () => void } },
    ) {
      // Real YT.Player's onReady fires asynchronously (postMessage-based) —
      // defer so `player` in constructYouTubePlayer's closure is assigned
      // before this runs, exactly like the real API's timing.
      queueMicrotask(() => this.options.events?.onReady?.());
    }
    isMuted(): boolean {
      return true;
    }
    getVolume(): number {
      return 100;
    }
    getCurrentTime(): number {
      return 0;
    }
    getDuration(): number {
      return 0;
    }
    destroy(): void {}
  }

  let container: HTMLElement;
  let createdTwitchPlayers: FakeTwitchPlayer[];

  function fakeStore(streams: StreamRef[]): StreamStore {
    return { getStreams: () => streams } as StreamStore;
  }

  beforeEach(() => {
    createdTwitchPlayers = [];
    container = document.createElement('div');
    container.id = 'stream-grid';
    document.body.append(container);

    const created = createdTwitchPlayers;
    (globalThis as unknown as { Twitch: unknown }).Twitch = {
      Player: class extends FakeTwitchPlayer {
        constructor(elementId: string, options: Twitch.PlayerOptions) {
          super(elementId, options);
          created.push(this);
        }
      },
    };
    (globalThis as unknown as { YT: unknown }).YT = { Player: FakeYouTubePlayer };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', results: [] }) }),
    );
  });

  afterEach(() => {
    // Destroy every constructed player via the real removal path and stop
    // the shared mute-poll timer, so no real setInterval survives this test.
    syncStreamGrid(container, fakeStore([]));
    __resetTwitchMutePollTimerForTests();
    delete (globalThis as unknown as { Twitch?: unknown }).Twitch;
    delete (globalThis as unknown as { YT?: unknown }).YT;
    container.remove();
  });

  it("adding a YouTube stream never touches an existing Twitch player's DOM identity, mount id, or playback state", async () => {
    const twitchStreams: StreamRef[] = ['ta', 'tb', 'tc'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));

    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(3));
    for (const player of createdTwitchPlayers) player.play();

    const before = twitchStreams.map((stream) => {
      const card = container.querySelector<HTMLElement>(`[data-stream-id="${stream.id}"]`);
      const mount = card?.querySelector<HTMLElement>('.stream-card__iframe');
      if (!card || !mount) throw new Error(`test setup failed to mount ${stream.id}`);
      return { id: stream.id, card, mount, mountId: mount.id };
    });

    // Assertion 1: BEFORE the mutation, the snapshot already reports all
    // three Twitch streams as playing — proving it relies on isPaused(),
    // since none of these fake players ever fired a PLAYING event.
    expect(new Set(snapshotPlayingTwitchPlayers(container))).toEqual(
      new Set(['twitch:ta', 'twitch:tb', 'twitch:tc']),
    );

    const youtubeStream: StreamRef = {
      id: 'youtube:video:dQw4w9WgXcQ',
      platform: 'youtube',
      channel: 'video:dQw4w9WgXcQ',
      muted: true,
      orientation: 'landscape',
    };
    syncStreamGrid(container, fakeStore([...twitchStreams, youtubeStream]));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-stream-id="youtube:video:dQw4w9WgXcQ"]')).toBeTruthy(),
    );

    // Assertion 2: exactly one new player was constructed overall, and it
    // was the YouTube one — no existing Twitch stream got a second
    // Twitch.Player construction (no destroy-and-rebuild).
    expect(createdTwitchPlayers).toHaveLength(3);

    for (const prior of before) {
      const cardAfter = container.querySelector<HTMLElement>(`[data-stream-id="${prior.id}"]`);
      const mountAfter = cardAfter?.querySelector<HTMLElement>('.stream-card__iframe');
      // Assertions 3-4: same DOM node references (===), not merely
      // equivalent markup — a teardown/rebuild would fail this even if the
      // resulting HTML looked identical.
      expect(cardAfter).toBe(prior.card);
      expect(mountAfter).toBe(prior.mount);
      // Assertion 5: the mount element's id — what Twitch.Player was
      // constructed against — is unchanged, so no re-attach occurred.
      expect(mountAfter?.id).toBe(prior.mountId);
    }

    // Assertions 6-8: no app code called pause()/destroy() on any existing
    // Twitch player, and each is still reporting itself as playing.
    for (const player of createdTwitchPlayers) {
      expect(player.pauseCallCount).toBe(0);
      expect(player.destroyCallCount).toBe(0);
      expect(player.isPaused()).toBe(false);
    }

    // Assertion 9: AFTER the mutation, the snapshot still reports all three
    // original streams as playing — this is the exact symptom fix: before
    // the fix this came back empty, starving the fast recovery pass.
    expect(new Set(snapshotPlayingTwitchPlayers(container))).toEqual(
      new Set(['twitch:ta', 'twitch:tb', 'twitch:tc']),
    );

    // Assertion 10: layout metadata reflects the real new total.
    expect(container.dataset.count).toBe('4');
  });

  it('a player latched offline via the real Twitch OFFLINE event is excluded from the snapshot even while isPaused() reports false', async () => {
    const twitchStreams: StreamRef[] = ['live1', 'offline1'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));
    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(2));
    for (const player of createdTwitchPlayers) player.play(); // both report isPaused() === false

    const offlinePlayer = createdTwitchPlayers.find((p) => p.options.channel === 'offline1');
    if (!offlinePlayer) throw new Error('test setup failed to construct the offline1 player');
    // Exercises the real listener constructTwitchPlayer registered — not a
    // hand-set dataset attribute — so this proves the actual OFFLINE ->
    // setPlaybackState('offline') -> snapshot-exclusion wiring, not a stand-in.
    offlinePlayer.emit(FakeTwitchPlayer.OFFLINE);

    const ids = snapshotPlayingTwitchPlayers(container);
    expect(ids).toContain('twitch:live1');
    expect(ids).not.toContain('twitch:offline1');
  });
});

/**
 * Focus View / orientation coverage at the DOM level (gridLayout.test.ts
 * already covers the pure sizing math). syncFocusViewDom only ever toggles
 * a class and a title attribute on existing cards (see StreamGrid.ts) — it
 * never touches the player subtree — so a real Grid<->Focus toggle and a
 * primary promotion must never recreate a card or its mounted player.
 */
describe('syncViewMode / setFocusViewPrimary — DOM identity across Grid <-> Focus toggles', () => {
  class MinimalFakeTwitchPlayer {
    static readonly READY = 'READY';
    static readonly PLAY = 'PLAY';
    static readonly PLAYING = 'PLAYING';
    static readonly PAUSE = 'PAUSE';
    static readonly ENDED = 'ENDED';
    static readonly PLAYBACK_BLOCKED = 'PLAYBACK_BLOCKED';
    static readonly OFFLINE = 'OFFLINE';
    static readonly ONLINE = 'ONLINE';
    constructor(
      public elementId: string,
      public options: Twitch.PlayerOptions,
    ) {}
    play(): void {}
    pause(): void {}
    isPaused(): boolean {
      return false;
    }
    setMuted(): void {}
    getMuted(): boolean {
      return false;
    }
    setChannel(): void {}
    getCurrentTime(): number {
      return 0;
    }
    getPlaybackStats(): Twitch.PlaybackStats {
      return {};
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    destroy(): void {}
  }

  let container: HTMLElement;

  function fakeStore(streams: StreamRef[]): StreamStore {
    return { getStreams: () => streams } as StreamStore;
  }

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'stream-grid';
    document.body.append(container);
    (globalThis as unknown as { Twitch: unknown }).Twitch = { Player: MinimalFakeTwitchPlayer };
  });

  afterEach(() => {
    syncStreamGrid(container, fakeStore([]));
    __resetTwitchMutePollTimerForTests();
    delete (globalThis as unknown as { Twitch?: unknown }).Twitch;
    container.remove();
  });

  it('toggling grid -> focus -> grid preserves every card and player-mount element reference, and marks exactly one primary', async () => {
    const streams: StreamRef[] = ['a', 'b', 'c'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(3),
    );

    const before = streams.map((s) => ({
      id: s.id,
      card: container.querySelector<HTMLElement>(`[data-stream-id="${s.id}"]`),
      mount: container.querySelector<HTMLElement>(`[data-stream-id="${s.id}"] .stream-card__iframe`),
    }));

    syncViewMode(container, 'focus', streams);
    expect(container.dataset.viewMode).toBe('focus');
    // Defaults to the first stream per syncViewMode's own fallback.
    expect(getFocusViewPrimaryId()).toBe('twitch:a');
    expect(
      container.querySelectorAll('.stream-card.is-focus-primary'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-stream-id="twitch:a"]')?.classList.contains('is-focus-primary'),
    ).toBe(true);

    setFocusViewPrimary(container, 'twitch:c');
    expect(getFocusViewPrimaryId()).toBe('twitch:c');
    expect(
      container.querySelectorAll('.stream-card.is-focus-primary'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-stream-id="twitch:c"]')?.classList.contains('is-focus-primary'),
    ).toBe(true);
    expect(
      container.querySelector('[data-stream-id="twitch:a"]')?.classList.contains('is-focus-primary'),
    ).toBe(false);

    syncViewMode(container, 'grid', streams);
    expect(container.dataset.viewMode).toBe('grid');

    for (const prior of before) {
      const cardAfter = container.querySelector<HTMLElement>(`[data-stream-id="${prior.id}"]`);
      const mountAfter = container.querySelector<HTMLElement>(
        `[data-stream-id="${prior.id}"] .stream-card__iframe`,
      );
      expect(cardAfter).toBe(prior.card);
      expect(mountAfter).toBe(prior.mount);
    }
  });

  it('a portrait stream keeps data-orientation="portrait" through a Grid <-> Focus toggle (Focus View sizes it by aspect ratio alone, per gridLayout.ts)', async () => {
    const streams: StreamRef[] = [
      { id: 'twitch:land', platform: 'twitch', channel: 'land', muted: true, orientation: 'landscape' },
      {
        id: 'youtube:video:dQw4w9WgXcQ',
        platform: 'youtube',
        channel: 'video:dQw4w9WgXcQ',
        muted: true,
        orientation: 'portrait',
      },
    ];
    (globalThis as unknown as { YT: unknown }).YT = {
      Player: class {
        constructor(
          public elementId: string,
          public options: { events?: { onReady?: () => void } },
        ) {
          queueMicrotask(() => this.options.events?.onReady?.());
        }
        isMuted(): boolean {
          return true;
        }
        getVolume(): number {
          return 100;
        }
        destroy(): void {}
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', results: [] }) }),
    );

    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(2),
    );

    const portraitCard = container.querySelector<HTMLElement>('[data-stream-id="youtube:video:dQw4w9WgXcQ"]');
    expect(portraitCard?.dataset.orientation).toBe('portrait');

    syncViewMode(container, 'focus', streams);
    expect(portraitCard?.dataset.orientation).toBe('portrait');

    syncViewMode(container, 'grid', streams);
    expect(portraitCard?.dataset.orientation).toBe('portrait');

    delete (globalThis as unknown as { YT?: unknown }).YT;
  });

  it('a promotable tray header is keyboard-focusable and Enter promotes it, matching the click affordance', async () => {
    const streams: StreamRef[] = ['a', 'b', 'c'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(3),
    );
    bindFocusViewPromotion(container);
    syncViewMode(container, 'focus', streams);
    expect(getFocusViewPrimaryId()).toBe('twitch:a');

    const primaryHeader = container.querySelector<HTMLElement>(
      '[data-stream-id="twitch:a"] .stream-card__header',
    );
    const trayHeaderB = container.querySelector<HTMLElement>(
      '[data-stream-id="twitch:b"] .stream-card__header',
    );
    // The primary's own header is not a promotion target — no button role/tabstop.
    expect(primaryHeader?.getAttribute('role')).toBeNull();
    expect(primaryHeader?.hasAttribute('tabindex')).toBe(false);
    // A non-primary tray header is keyboard-reachable and announces its action.
    expect(trayHeaderB?.getAttribute('role')).toBe('button');
    expect(trayHeaderB?.tabIndex).toBe(0);
    expect(trayHeaderB?.getAttribute('aria-label')).toBe('Make b the primary stream');

    trayHeaderB?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(getFocusViewPrimaryId()).toBe('twitch:b');
    expect(
      container.querySelector('[data-stream-id="twitch:b"]')?.classList.contains('is-focus-primary'),
    ).toBe(true);

    // b is now primary, so its own header loses the button affordance, and
    // a (now in the tray) gains it — the promotable set tracks primary, live.
    expect(trayHeaderB?.getAttribute('role')).toBeNull();
    const trayHeaderA = container.querySelector<HTMLElement>(
      '[data-stream-id="twitch:a"] .stream-card__header',
    );
    expect(trayHeaderA?.getAttribute('role')).toBe('button');

    const trayHeaderC = container.querySelector<HTMLElement>(
      '[data-stream-id="twitch:c"] .stream-card__header',
    );
    trayHeaderC?.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    expect(getFocusViewPrimaryId()).toBe('twitch:c');
  });
});
