import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetKickDurationTimerForTests,
  __resetTwitchDurationTimerForTests,
  __resetTwitchMutePollTimerForTests,
  __resetYouTubeDurationTimerForTests,
  applyKickStatus,
  applyTwitchStatus,
  applyYouTubeStats,
  beginAddRemoveRecovery,
  beginFocusExitRecovery,
  bindFocusViewEntry,
  bindFocusViewPromotion,
  bindStreamRemoved,
  getFocusedStreamId,
  getFocusViewPrimaryId,
  isStreamFocused,
  nudgeStalledTwitchPlayers,
  refreshAllKickStatuses,
  refreshAllTwitchStatuses,
  refreshAllYouTubeStats,
  refreshKickStatus,
  refreshLoadedStreamPlayers,
  refreshTwitchStatus,
  refreshYouTubeStats,
  setFocusedStream,
  setFocusViewPrimary,
  snapshotPlayingTwitchPlayers,
  snapshotReorderRecoveryIds,
  captureTwitchPlayerIdentities,
  diffTwitchPlayerIdentities,
  syncStreamGrid,
  syncViewMode,
  twitchStatusDotProps,
  updateGridLayout,
} from './StreamGrid';
import { createStreamStore, type StreamStore } from '../state/streams';
import type { StreamRef } from '../types';
import type { KickStatusResult } from '../platforms/kickStatus';
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
  document.documentElement.classList.remove('headers-hidden');
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

  it('retains a resolved creator avatar when the stream goes offline without a new URL', () => {
    const { card } = buildTwitchCard('foo');
    container.append(card);

    applyTwitchStatus(
      container,
      new Map([['foo', liveResult('foo', { avatarUrl: 'https://static-cdn.jtvnw.net/foo.png' })]]),
    );
    expect(card.dataset.twitchAvatarUrl).toBe('https://static-cdn.jtvnw.net/foo.png');

    applyTwitchStatus(container, new Map([['foo', offlineResult('foo')]]));
    expect(card.dataset.twitchAvatarUrl).toBe('https://static-cdn.jtvnw.net/foo.png');
    expect(card.dataset.twitchViewerCount).toBeUndefined();
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

  it('does not clear a cached channel avatar when the live session ends', () => {
    const { card } = buildYouTubeCard('abc123');
    card.dataset.youtubeAvatarUrl = 'https://yt3.ggpht.com/channel.jpg';
    container.append(card);

    applyYouTubeStats(container, new Map([['abc123', liveStats('abc123')]]));
    applyYouTubeStats(container, new Map([['abc123', endedStats('abc123')]]));

    expect(card.dataset.youtubeAvatarUrl).toBe('https://yt3.ggpht.com/channel.jpg');
    expect(card.dataset.youtubeViewerCount).toBeUndefined();
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
    muted: boolean;
    setMutedCalls: boolean[] = [];
    pauseCallCount = 0;
    playCallCount = 0;
    destroyCallCount = 0;
    private listeners = new Map<string, Array<() => void>>();

    constructor(
      public elementId: string,
      public options: Twitch.PlayerOptions,
    ) {
      this.muted = options.muted ?? true;
    }
    play(): void {
      this.paused = false;
      this.playCallCount += 1;
      // Real Twitch play() can unmute via embed storage — recovery must not.
      this.muted = false;
    }
    pause(): void {
      this.paused = true;
      this.pauseCallCount += 1;
    }
    isPaused(): boolean {
      return this.paused;
    }
    setMuted(muted: boolean): void {
      this.muted = muted;
      this.setMutedCalls.push(muted);
    }
    getMuted(): boolean {
      return this.muted;
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

  /**
   * Regression coverage for the "touching/scrolling the Focus tray pauses the
   * primary" bug. Root cause: verifyAndRecoverTwitchPlayer's "skip the stream
   * someone is actively watching" guard only ever checked the old solo-focus
   * `focusedStreamId`, which Theater/Focus never sets — so the interaction-
   * armed nudge sweep (window pointerdown/mousemove -> nudgeStalledTwitchPlayers,
   * armed by the ResizeObserver firing when Theater's chat panel opens) had no
   * awareness of the Theater/Focus primary at all and would call play() on it
   * like any other card. Fixed via isActivelyWatchedStream() checking
   * focusViewPrimaryId too. This proves the primary is skipped while an
   * ordinary tray stream is still recovered normally by the same sweep.
   */
  it('nudgeStalledTwitchPlayers skips the Theater/Focus primary but still recovers a stalled tray stream', async () => {
    const twitchStreams: StreamRef[] = ['a', 'b'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));
    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(2));
    const [playerA, playerB] = createdTwitchPlayers;

    syncViewMode(container, 'focus', twitchStreams);
    setFocusViewPrimary(container, 'twitch:a');
    expect(getFocusViewPrimaryId()).toBe('twitch:a');

    // Simulate both cards reading as paused at the exact instant of a tray
    // touch — the real-world trigger being a resize-induced transient stall
    // reading, not a genuine pause.
    playerA.paused = true;
    playerB.paused = true;

    nudgeStalledTwitchPlayers(container);
    // verifyAndRecoverTwitchPlayer re-checks isPaused() after a 500ms
    // STALL_CONFIRM_DELAY_MS before acting — wait past that.
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The primary was never touched by the recovery sweep at all.
    expect(playerA.playCallCount).toBe(0);
    expect(playerA.isPaused()).toBe(true);

    // An ordinary tray stream in the exact same stalled state is still
    // recovered normally — the fix is scoped to the primary, not a global
    // regression in stall recovery.
    expect(playerB.playCallCount).toBe(1);
    expect(playerB.isPaused()).toBe(false);
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

  /**
   * Regression coverage for the "exiting Theater leaves every non-primary
   * Twitch player paused" bug. Root cause: Theater's CSS collapses every
   * non-primary card to display:none (see main.css's
   * `[data-view-mode='theater']` rule), which makes a live Twitch embed
   * genuinely pause itself — and nothing was wired to resume it on exit.
   * recoverTwitchPlayersAfterLayout only handles 'fallback'-mode iframes (a
   * no-op here), and the periodic stall watchdog can take up to ~90s, which
   * reads as "stuck paused, needs a hard refresh". main.ts's
   * afterViewModeToggle now snapshots playing ids on Theater entry and calls
   * beginFocusExitRecovery with that snapshot on exit — this test exercises
   * that exact pair of functions directly (bypassing jsdom's lack of real
   * layout/display:none-induced pausing) by reproducing the collapse's
   * effect on the fake players, then proving the recovery pass replays
   * play() on every one of them.
   */
  it('beginFocusExitRecovery replays play() on every player that was playing before a Theater collapse', async () => {
    const twitchStreams: StreamRef[] = ['primary', 'sec1', 'sec2'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));

    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(3));
    for (const player of createdTwitchPlayers) player.play();

    // Mirrors main.ts's afterViewModeToggle: snapshot BEFORE the collapse.
    const startedAt = Date.now();
    const snapshotIds = snapshotPlayingTwitchPlayers(container);
    expect(new Set(snapshotIds)).toEqual(new Set(['twitch:primary', 'twitch:sec1', 'twitch:sec2']));

    // Theater's display:none collapse is a real CSS/layout effect jsdom
    // doesn't reproduce — stand in for its observed consequence (Twitch
    // pausing the underlying player) directly on the fake players.
    for (const player of createdTwitchPlayers) player.pause();
    expect(createdTwitchPlayers.every((player) => player.isPaused())).toBe(true);

    // The exact call afterViewModeToggle now makes on Theater exit.
    beginFocusExitRecovery(container, snapshotIds, startedAt);

    // Pass 0 of the recovery schedule runs at a 0ms offset (see
    // RECOVERY_RETRY_OFFSETS_MS) — real setTimeout, so give it one tick.
    // playCallCount must reach 2: the first was our own setup play() above,
    // the second is the recovery pass replaying it after the collapse.
    await vi.waitFor(() => {
      expect(createdTwitchPlayers.every((player) => player.playCallCount >= 2)).toBe(true);
    });

    for (const player of createdTwitchPlayers) {
      expect(player.isPaused()).toBe(false);
    }
  });

  it('beginAddRemoveRecovery replays play() after a reorder pause of players that were playing beforehand', async () => {
    const twitchStreams: StreamRef[] = ['a', 'b', 'c'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));

    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(3));
    for (const player of createdTwitchPlayers) player.play();

    const snapshotIds = snapshotPlayingTwitchPlayers(container);
    expect(new Set(snapshotIds)).toEqual(new Set(['twitch:a', 'twitch:b', 'twitch:c']));

    // App-controlled reorder can still pause api-mode players (dense-pack
    // resize). A user-paused stream is absent from the snapshot and must not
    // be restarted — only the pre-mutation playing set is eligible.
    createdTwitchPlayers[1].pause();
    for (const player of createdTwitchPlayers) {
      if (player !== createdTwitchPlayers[1]) player.pause();
    }

    beginAddRemoveRecovery(container, snapshotIds, 'reorder');

    await vi.waitFor(() => {
      expect(createdTwitchPlayers.every((player) => player.playCallCount >= 2)).toBe(true);
    });
    expect(createdTwitchPlayers.every((player) => player.isPaused() === false)).toBe(true);
  });

  it('beginAddRemoveRecovery replays play() after a Story Card preview pause of players that were playing beforehand', async () => {
    const twitchStreams: StreamRef[] = ['a', 'b'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));

    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(2));
    for (const player of createdTwitchPlayers) player.play();

    const snapshotIds = snapshotPlayingTwitchPlayers(container);
    expect(new Set(snapshotIds)).toEqual(new Set(['twitch:a', 'twitch:b']));

    for (const player of createdTwitchPlayers) player.pause();

    beginAddRemoveRecovery(container, snapshotIds, 'story-preview');

    await vi.waitFor(() => {
      expect(createdTwitchPlayers.every((player) => player.playCallCount >= 2)).toBe(true);
    });
    expect(createdTwitchPlayers.every((player) => player.isPaused() === false)).toBe(true);
    expect(createdTwitchPlayers.every((player) => player.setMutedCalls.includes(false))).toBe(false);
    expect(createdTwitchPlayers.every((player) => player.getMuted() === true)).toBe(true);
  });

  it('snapshotReorderRecoveryIds keeps hover-paused players that the coordinator is already chasing', async () => {
    const twitchStreams: StreamRef[] = ['a', 'b', 'c'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));

    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(3));
    for (const player of createdTwitchPlayers) player.play();

    createdTwitchPlayers[0].pause();
    beginAddRemoveRecovery(container, ['twitch:a'], 'reorder');

    const snapshot = snapshotReorderRecoveryIds(container);
    expect(snapshot).toEqual(expect.arrayContaining(['twitch:a', 'twitch:b', 'twitch:c']));
  });

  it('headers-hidden reorder recovery restores 12 playing Twitch players across 20 operations', async () => {
    document.documentElement.classList.add('headers-hidden');
    try {
      const twitchStreams: StreamRef[] = Array.from({ length: 12 }, (_, i) => ({
        id: `twitch:ch${i}`,
        platform: 'twitch' as const,
        channel: `ch${i}`,
        muted: true,
        orientation: 'landscape' as const,
      }));

      syncStreamGrid(container, fakeStore(twitchStreams));
      await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(12));

      for (let op = 0; op < 20; op++) {
        for (const player of createdTwitchPlayers) player.play();
        const snapshotIds = snapshotReorderRecoveryIds(container);
        expect(snapshotIds).toHaveLength(12);
        for (const player of createdTwitchPlayers) player.pause();
        beginAddRemoveRecovery(container, snapshotIds, 'reorder');
        await vi.waitFor(() => {
          expect(createdTwitchPlayers.every((player) => player.isPaused() === false)).toBe(true);
        });
      }
    } finally {
      document.documentElement.classList.remove('headers-hidden');
    }
  });

  it('Story Preview identity capture reports zero remounts or src changes across 10 open/close cycles', async () => {
    const twitchStreams: StreamRef[] = Array.from({ length: 10 }, (_, i) => ({
      id: `twitch:live${i}`,
      platform: 'twitch' as const,
      channel: `live${i}`,
      muted: true,
      orientation: 'landscape' as const,
    }));
    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(10));
    for (const player of createdTwitchPlayers) player.play();

    const before = captureTwitchPlayerIdentities(container);
    expect(before).toHaveLength(10);

    for (let cycle = 0; cycle < 10; cycle++) {
      const afterOpen = captureTwitchPlayerIdentities(container);
      const openDiff = diffTwitchPlayerIdentities(before, afterOpen);
      expect(openDiff.remounts).toEqual([]);
      expect(openDiff.srcChanges).toEqual([]);
      expect(openDiff.playerObjectChanges).toEqual([]);

      const afterClose = captureTwitchPlayerIdentities(container);
      const closeDiff = diffTwitchPlayerIdentities(before, afterClose);
      expect(closeDiff.remounts).toEqual([]);
      expect(closeDiff.srcChanges).toEqual([]);
      expect(closeDiff.playerObjectChanges).toEqual([]);
    }

    expect(createdTwitchPlayers).toHaveLength(10);
  });

  it('Twitch READY re-asserts mute when embed storage restores unmuted on page load', async () => {
    syncStreamGrid(container, fakeStore([
      { id: 'twitch:a', platform: 'twitch', channel: 'a', muted: true, orientation: 'landscape' },
    ]));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(1));

    const player = createdTwitchPlayers[0];
    player.muted = false;
    player.emit(FakeTwitchPlayer.READY);

    expect(player.setMutedCalls.at(-1)).toBe(true);
    expect(player.getMuted()).toBe(true);
    const card = container.querySelector<HTMLElement>('[data-stream-id="twitch:a"]');
    expect(card?.dataset.embedMuted).toBe('1');
  });

  it('reordering existing streams never reparents mounted Twitch cards; CSS order follows store index', async () => {
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
      const iframe = card?.querySelector('iframe');
      if (!card || !mount) throw new Error(`test setup failed to mount ${stream.id}`);
      return { id: stream.id, card, mount, mountId: mount.id, iframe, parent: card.parentNode };
    });

    const insertBefore = vi.spyOn(container, 'insertBefore');
    const reversed = [...twitchStreams].reverse();
    syncStreamGrid(container, fakeStore(reversed));

    expect(insertBefore).not.toHaveBeenCalled();
    expect([...container.children].map((node) => (node as HTMLElement).dataset.streamId)).toEqual([
      'twitch:ta',
      'twitch:tb',
      'twitch:tc',
    ]);
    expect(container.querySelector<HTMLElement>('[data-stream-id="twitch:tc"]')?.style.order).toBe('0');
    expect(container.querySelector<HTMLElement>('[data-stream-id="twitch:tb"]')?.style.order).toBe('1');
    expect(container.querySelector<HTMLElement>('[data-stream-id="twitch:ta"]')?.style.order).toBe('2');

    for (const prior of before) {
      const cardAfter = container.querySelector<HTMLElement>(`[data-stream-id="${prior.id}"]`);
      const mountAfter = cardAfter?.querySelector<HTMLElement>('.stream-card__iframe');
      expect(cardAfter).toBe(prior.card);
      expect(mountAfter).toBe(prior.mount);
      expect(mountAfter?.id).toBe(prior.mountId);
      expect(cardAfter?.parentNode).toBe(prior.parent);
      expect(cardAfter?.querySelector('iframe')).toBe(prior.iframe);
    }

    expect(createdTwitchPlayers).toHaveLength(3);
    for (const player of createdTwitchPlayers) {
      expect(player.pauseCallCount).toBe(0);
      expect(player.destroyCallCount).toBe(0);
      expect(player.isPaused()).toBe(false);
    }
  });

  it('reordering a TikTok card never remounts it or duplicates its media wrap', () => {
    const streams: StreamRef[] = [
      { id: 'tiktok:creator', platform: 'tiktok', channel: 'creator', muted: true, orientation: 'portrait' },
      { id: 'twitch:a', platform: 'twitch', channel: 'a', muted: true, orientation: 'landscape' },
      { id: 'kick:deen', platform: 'kick', channel: 'deen', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));

    const card = container.querySelector<HTMLElement>('[data-stream-id="tiktok:creator"]');
    const wrap = card?.querySelector<HTMLElement>('.stream-card__tiktok-wrap');
    if (!card || !wrap) throw new Error('TikTok card did not mount');
    const videosBefore = container.querySelectorAll('video.stream-card__tiktok-video').length;

    syncStreamGrid(
      container,
      fakeStore([streams[1], streams[2], streams[0]]),
    );

    const cardAfter = container.querySelector<HTMLElement>('[data-stream-id="tiktok:creator"]');
    const wrapAfter = cardAfter?.querySelector<HTMLElement>('.stream-card__tiktok-wrap');
    expect(cardAfter).toBe(card);
    expect(wrapAfter).toBe(wrap);
    expect(cardAfter?.style.order).toBe('2');
    expect(container.querySelectorAll('video.stream-card__tiktok-video').length).toBe(videosBefore);
    expect(container.querySelectorAll('[data-stream-id="tiktok:creator"]').length).toBe(1);
  });

  it('refreshLoadedStreamPlayers replays paused Twitch players and leaves healthy ones untouched', async () => {
    const twitchStreams: StreamRef[] = ['a', 'b'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));

    syncStreamGrid(container, fakeStore(twitchStreams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(2));
    for (const player of createdTwitchPlayers) player.play();
    const healthyPlays = createdTwitchPlayers[0].playCallCount;
    createdTwitchPlayers[1].pause();

    refreshLoadedStreamPlayers(container);

    expect(createdTwitchPlayers[0].playCallCount).toBe(healthyPlays);
    expect(createdTwitchPlayers[0].isPaused()).toBe(false);
    expect(createdTwitchPlayers[1].isPaused()).toBe(false);
    expect(createdTwitchPlayers[1].playCallCount).toBeGreaterThan(1);
    expect(createdTwitchPlayers[0].destroyCallCount).toBe(0);
    expect(createdTwitchPlayers[1].destroyCallCount).toBe(0);
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

  it('entering Focus View while a card is solo-focused (old per-card expand) cleanly exits solo-focus and carries that same stream forward as the Focus View primary, instead of both modes being active at once', async () => {
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

    setFocusedStream(container, 'twitch:b');
    expect(getFocusedStreamId()).toBe('twitch:b');
    expect(isStreamFocused()).toBe(true);
    expect(
      container.querySelector('[data-stream-id="twitch:b"]')?.classList.contains('is-focused'),
    ).toBe(true);

    syncViewMode(container, 'focus', streams);

    // Solo-focus is fully cleared, not left active alongside Focus View.
    expect(getFocusedStreamId()).toBeNull();
    expect(isStreamFocused()).toBe(false);
    expect(
      container.querySelector('[data-stream-id="twitch:b"]')?.classList.contains('is-focused'),
    ).toBe(false);
    expect(document.documentElement.classList.contains('stream-focused')).toBe(false);

    // The stream the viewer was solo-focused on carries forward as primary,
    // rather than falling back to the first stream.
    expect(container.dataset.viewMode).toBe('focus');
    expect(getFocusViewPrimaryId()).toBe('twitch:b');
    expect(
      container.querySelector('[data-stream-id="twitch:b"]')?.classList.contains('is-focus-primary'),
    ).toBe(true);
  });

  it('Focus View centers the primary within the actual available stream area (derived from .stream-area\'s live clientWidth), not the full viewport — proven by re-running updateGridLayout at a narrower width, matching what chat opening does to that same element via flex', async () => {
    const streams: StreamRef[] = ['a', 'b', 'c', 'd'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));

    // updateGridLayout reads container.closest('.stream-area').clientWidth —
    // wrap the grid in that ancestor and stub its dimensions, exactly the
    // property chat open/close changes in production via flex (see main.css's
    // .main-layout).
    const streamArea = document.createElement('div');
    streamArea.className = 'stream-area';
    container.remove();
    streamArea.append(container);
    document.body.append(streamArea);
    let width = 1200;
    const height = 700;
    Object.defineProperty(streamArea, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(streamArea, 'clientHeight', { configurable: true, get: () => height });

    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(4),
    );
    syncViewMode(container, 'focus', streams);

    // Chat-closed width.
    updateGridLayout(container);
    const wideTrayCount = container.style.getPropertyValue('--focus-tray-count');
    const widePrimaryWidth = container.style.getPropertyValue('--focus-primary-width');
    expect(wideTrayCount).not.toBe('');
    expect(widePrimaryWidth).not.toBe('');
    expect(Number.parseInt(widePrimaryWidth, 10)).toBeGreaterThan(0);

    // Chat-open width (same mechanism as a real chat panel shrinking this
    // element via flex) — re-running layout must shrink the primary to fit
    // the new, smaller available area rather than leaving stale wide-mode
    // vars (which would silently overflow / mis-center against a chat panel).
    width = 760;
    updateGridLayout(container);
    const narrowPrimaryWidth = container.style.getPropertyValue('--focus-primary-width');
    expect(Number.parseInt(narrowPrimaryWidth, 10)).toBeGreaterThan(0);
    expect(Number.parseInt(narrowPrimaryWidth, 10)).toBeLessThan(
      Number.parseInt(widePrimaryWidth, 10),
    );

    streamArea.remove();
    document.body.append(container);
  });

  it('data-tray-overflow tracks scroll position while the tray overflows, and clears once nothing is left to scroll to', async () => {
    const streams: StreamRef[] = ['a', 'b', 'c'].map((channel) => ({
      id: `twitch:${channel}`,
      platform: 'twitch',
      channel,
      muted: true,
      orientation: 'landscape',
    }));

    const streamArea = document.createElement('div');
    streamArea.className = 'stream-area';
    container.remove();
    streamArea.append(container);
    document.body.append(streamArea);
    Object.defineProperty(streamArea, 'clientWidth', { configurable: true, get: () => 900 });
    Object.defineProperty(streamArea, 'clientHeight', { configurable: true, get: () => 600 });

    // The overflow indicator reads container.scrollWidth/clientWidth/scrollLeft
    // directly (the grid itself is the scroll container — see main.css) —
    // jsdom never computes real layout, so these are stubbed the same way
    // streamArea's dimensions are above.
    let scrollWidth = 1400;
    let clientWidth = 900;
    let scrollLeft = 0;
    Object.defineProperty(container, 'scrollWidth', { configurable: true, get: () => scrollWidth });
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => clientWidth });
    Object.defineProperty(container, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });

    bindFocusViewPromotion(container);
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(3),
    );
    syncViewMode(container, 'focus', streams);
    updateGridLayout(container);

    // At the start of an overflowing tray: only the "more to the right" fade.
    expect(container.dataset.trayOverflow).toBe('end');

    scrollLeft = 250;
    container.dispatchEvent(new Event('scroll'));
    expect(container.dataset.trayOverflow).toBe('both');

    scrollLeft = scrollWidth - clientWidth;
    container.dispatchEvent(new Event('scroll'));
    expect(container.dataset.trayOverflow).toBe('start');

    // Nothing left to scroll: no indicator at all, not a stale one.
    scrollWidth = clientWidth;
    scrollLeft = 0;
    updateGridLayout(container);
    expect(container.dataset.trayOverflow).toBeUndefined();

    streamArea.remove();
    document.body.append(container);
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

describe('Audio controls — Kick mute-only, Twitch/YouTube mute-only, TikTok volume slider, per-stream state', () => {
  class FakeTwitchPlayer {
    static readonly READY = 'READY';
    static readonly PLAY = 'PLAY';
    static readonly PLAYING = 'PLAYING';
    static readonly PAUSE = 'PAUSE';
    static readonly ENDED = 'ENDED';
    static readonly PLAYBACK_BLOCKED = 'PLAYBACK_BLOCKED';
    static readonly OFFLINE = 'OFFLINE';
    static readonly ONLINE = 'ONLINE';

    muted: boolean;
    volume = 1;
    setMutedCalls: boolean[] = [];
    setVolumeCalls: number[] = [];

    constructor(
      public elementId: string,
      public options: Twitch.PlayerOptions,
    ) {
      this.muted = options.muted ?? true;
    }
    play(): void {}
    pause(): void {}
    isPaused(): boolean {
      return false;
    }
    setMuted(muted: boolean): void {
      this.muted = muted;
      this.setMutedCalls.push(muted);
    }
    getMuted(): boolean {
      return this.muted;
    }
    setVolume(volume: number): void {
      this.volume = volume;
      this.setVolumeCalls.push(volume);
    }
    getVolume(): number {
      return this.volume;
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

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', results: [] }) }),
    );
  });

  afterEach(() => {
    syncStreamGrid(container, fakeStore([]));
    __resetTwitchMutePollTimerForTests();
    delete (globalThis as unknown as { Twitch?: unknown }).Twitch;
    container.remove();
  });

  it('Kick renders NO header mute/volume control — its only mute mechanism is a full iframe reload, which is too disruptive for a per-click header button (playback stability wins; see docs/PLAYBACK_STABILITY.md)', () => {
    const streams: StreamRef[] = [
      { id: 'kick:trainwreckstv', platform: 'kick', channel: 'trainwreckstv', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));

    const card = container.querySelector<HTMLElement>('[data-stream-id="kick:trainwreckstv"]');
    expect(card).toBeTruthy();
    expect(card!.querySelector('.stream-card__header .stream-card__mute-btn')).toBeNull();
    expect(card!.querySelector('.stream-card__youtube-volume-slider')).toBeNull();
  });

  it("Twitch 'api' mode is mute/unmute only — click toggles mute without ever opening a volume popover, and every unmute resets volume to the shared default (25%)", async () => {
    const streams: StreamRef[] = [
      { id: 'twitch:xqc', platform: 'twitch', channel: 'xqc', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(1));
    const player = createdTwitchPlayers[0];
    const card = container.querySelector<HTMLElement>('[data-stream-id="twitch:xqc"]')!;
    expect(card.dataset.twitchMode).toBe('api');

    const header = card.querySelector<HTMLElement>('.stream-card__header')!;
    const trigger = header.querySelector<HTMLButtonElement>('.stream-card__mute-btn[data-role="trigger"]')!;
    expect(card.dataset.embedMuted).toBe('1');

    trigger.click();
    expect(header.classList.contains('is-volume-mode')).toBe(false);
    expect(card.dataset.embedMuted).toBe('0');
    expect(trigger.getAttribute('aria-pressed')).toBe('false');
    expect(player.setMutedCalls.at(-1)).toBe(false);
    expect(player.setVolumeCalls.at(-1)).toBe(0.25);

    trigger.click();
    expect(card.dataset.embedMuted).toBe('1');
    expect(trigger.getAttribute('aria-pressed')).toBe('true');
    expect(player.setMutedCalls.at(-1)).toBe(true);

    // Unmuting again always lands back on the same default — there's no
    // slider anymore to have left it at a different level.
    trigger.click();
    expect(card.dataset.embedMuted).toBe('0');
    expect(player.setVolumeCalls.at(-1)).toBe(0.25);
  });

  it("Twitch fallback mode (embed script blocked, no Player API) quick-toggles mute on a single click and never opens the volume popover — don't fake unsupported behavior", () => {
    const streams: StreamRef[] = [
      { id: 'twitch:xqc', platform: 'twitch', channel: 'xqc', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));
    const card = container.querySelector<HTMLElement>('[data-stream-id="twitch:xqc"]')!;
    // Simulates the real async outcome of ensureTwitchEmbedScript failing —
    // production reaches 'fallback' the same way, just asynchronously.
    card.dataset.twitchMode = 'fallback';

    const header = card.querySelector<HTMLElement>('.stream-card__header')!;
    const trigger = header.querySelector<HTMLButtonElement>('.stream-card__mute-btn')!;
    expect(card.dataset.embedMuted).toBe('1');
    trigger.click();
    expect(header.classList.contains('is-volume-mode')).toBe(false);
    expect(card.dataset.embedMuted).toBe('0');
  });

  it('per-stream mute state stays keyed by stream id, not array position, across a reorder', async () => {
    const streams: StreamRef[] = [
      { id: 'twitch:a', platform: 'twitch', channel: 'a', muted: true, orientation: 'landscape' },
      { id: 'twitch:b', platform: 'twitch', channel: 'b', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(2));

    function trigger(streamId: string): HTMLButtonElement {
      return container.querySelector<HTMLButtonElement>(
        `[data-stream-id="${streamId}"] .stream-card__mute-btn[data-role="trigger"]`,
      )!;
    }

    trigger('twitch:a').click(); // unmute a, leave b muted

    // Reorder: same stream ids, reversed array order. syncStreamGrid only
    // removes/re-adds cards whose id actually leaves/enters the set, so both
    // existing cards — and the mute state keyed by their id — survive.
    syncStreamGrid(container, fakeStore([streams[1], streams[0]]));

    const cardA = container.querySelector<HTMLElement>('[data-stream-id="twitch:a"]')!;
    const cardB = container.querySelector<HTMLElement>('[data-stream-id="twitch:b"]')!;
    expect(cardA.dataset.embedMuted).toBe('0');
    expect(cardB.dataset.embedMuted).toBe('1');
  });

  it('clicking the Twitch trigger never bubbles a click to the header (no accidental Focus View promotion/reorder)', async () => {
    const streams: StreamRef[] = [
      { id: 'twitch:xqc', platform: 'twitch', channel: 'xqc', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(1));
    const card = container.querySelector<HTMLElement>('[data-stream-id="twitch:xqc"]')!;
    const header = card.querySelector<HTMLElement>('.stream-card__header')!;

    let headerClicks = 0;
    header.addEventListener('click', () => {
      headerClicks += 1;
    });

    const trigger = header.querySelector<HTMLButtonElement>('.stream-card__mute-btn[data-role="trigger"]')!;
    trigger.click();

    expect(headerClicks).toBe(0);
  });

  it("YouTube is mute/unmute only — click toggles mute without opening a panel, and every unmute resets volume to the shared default (25)", async () => {
    class FakeYouTubePlayer {
      mutedState = true;
      volumeState = 100;
      muteCalls: boolean[] = [];
      setVolumeCalls: number[] = [];
      constructor(
        public elementId: string,
        public options: { events?: { onReady?: () => void } },
      ) {
        queueMicrotask(() => this.options.events?.onReady?.());
      }
      isMuted(): boolean {
        return this.mutedState;
      }
      getVolume(): number {
        return this.volumeState;
      }
      mute(): void {
        this.mutedState = true;
        this.muteCalls.push(true);
      }
      unMute(): void {
        this.mutedState = false;
        this.muteCalls.push(false);
      }
      setVolume(volume: number): void {
        this.volumeState = volume;
        this.setVolumeCalls.push(volume);
      }
      getCurrentTime(): number {
        return 0;
      }
      getDuration(): number {
        return 0;
      }
      destroy(): void {}
    }

    let created: FakeYouTubePlayer | undefined;
    (globalThis as unknown as { YT: unknown }).YT = {
      Player: class extends FakeYouTubePlayer {
        constructor(elementId: string, options: { events?: { onReady?: () => void } }) {
          super(elementId, options);
          created = this;
        }
      },
    };

    try {
      const streams: StreamRef[] = [
        {
          id: 'youtube:video:dQw4w9WgXcQ',
          platform: 'youtube',
          channel: 'video:dQw4w9WgXcQ',
          muted: true,
          orientation: 'landscape',
        },
      ];
      syncStreamGrid(container, fakeStore(streams));
      await vi.waitFor(() => expect(created).toBeDefined());
      const player = created!;

      const card = container.querySelector<HTMLElement>('[data-stream-id="youtube:video:dQw4w9WgXcQ"]')!;
      const header = card.querySelector<HTMLElement>('.stream-card__header')!;
      await vi.waitFor(() => {
        const btn = header.querySelector<HTMLButtonElement>('.stream-card__mute-btn')!;
        expect(btn.disabled).toBe(false);
      });
      const trigger = header.querySelector<HTMLButtonElement>('.stream-card__mute-btn')!;

      trigger.click();
      expect(header.classList.contains('is-volume-mode')).toBe(false);
      expect(player.muteCalls.at(-1)).toBe(false);
      expect(player.setVolumeCalls.at(-1)).toBe(25);

      trigger.click();
      expect(player.muteCalls.at(-1)).toBe(true);
    } finally {
      delete (globalThis as unknown as { YT?: unknown }).YT;
    }
  });

  it("YouTube's mute control falls back to a usable default instead of getting stuck disabled forever when onReady's isMuted()/getVolume() throw (regression: this used to leave the button permanently disabled until a hard reload)", async () => {
    (globalThis as unknown as { YT: unknown }).YT = {
      Player: class {
        constructor(
          public elementId: string,
          public options: { events?: { onReady?: () => void } },
        ) {
          queueMicrotask(() => this.options.events?.onReady?.());
        }
        isMuted(): boolean {
          throw new Error('postMessage channel not hydrated yet');
        }
        getVolume(): number {
          throw new Error('postMessage channel not hydrated yet');
        }
        mute(): void {}
        unMute(): void {}
        setVolume(): void {}
        destroy(): void {}
      },
    };

    try {
      const streams: StreamRef[] = [
        {
          id: 'youtube:video:dQw4w9WgXcQ',
          platform: 'youtube',
          channel: 'video:dQw4w9WgXcQ',
          muted: true,
          orientation: 'landscape',
        },
      ];
      syncStreamGrid(container, fakeStore(streams));
      const card = container.querySelector<HTMLElement>('[data-stream-id="youtube:video:dQw4w9WgXcQ"]')!;
      const trigger = card.querySelector<HTMLButtonElement>('.stream-card__mute-btn')!;

      await vi.waitFor(() => expect(trigger.disabled).toBe(false));
    } finally {
      delete (globalThis as unknown as { YT?: unknown }).YT;
    }
  });
});

describe('Theater entry turns primary audio on (restores pre-regression behavior)', () => {
  class FakeTwitchPlayer {
    static readonly READY = 'READY';
    static readonly PLAY = 'PLAY';
    static readonly PLAYING = 'PLAYING';
    static readonly PAUSE = 'PAUSE';
    static readonly ENDED = 'ENDED';
    static readonly PLAYBACK_BLOCKED = 'PLAYBACK_BLOCKED';
    static readonly OFFLINE = 'OFFLINE';
    static readonly ONLINE = 'ONLINE';

    muted: boolean;
    volume = 1;
    setMutedCalls: boolean[] = [];
    setVolumeCalls: number[] = [];

    constructor(
      public elementId: string,
      public options: Twitch.PlayerOptions,
    ) {
      this.muted = options.muted ?? true;
    }
    play(): void {}
    pause(): void {}
    isPaused(): boolean {
      return false;
    }
    setMuted(muted: boolean): void {
      this.muted = muted;
      this.setMutedCalls.push(muted);
    }
    getMuted(): boolean {
      return this.muted;
    }
    setVolume(volume: number): void {
      this.volume = volume;
      this.setVolumeCalls.push(volume);
    }
    getVolume(): number {
      return this.volume;
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
  let createdTwitchPlayers: FakeTwitchPlayer[];

  function fakeStore(streams: StreamRef[]): StreamStore {
    return { getStreams: () => streams } as StreamStore;
  }

  function enterTheater(container: HTMLElement, streamId: string, streams: StreamRef[]): void {
    bindFocusViewEntry((id) => {
      setFocusViewPrimary(container, id);
      syncViewMode(container, 'theater', streams);
    });
    container
      .querySelector<HTMLButtonElement>(`[data-stream-id="${streamId}"] .stream-card__focus`)!
      .click();
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

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', results: [] }) }),
    );
  });

  afterEach(() => {
    syncStreamGrid(container, fakeStore([]));
    syncViewMode(container, 'grid', []);
    __resetTwitchMutePollTimerForTests();
    delete (globalThis as unknown as { Twitch?: unknown }).Twitch;
    container.remove();
  });

  it("clicking a muted Twitch card's Theater/expand control unmutes it at the shared default (25%) via the live player's own setMuted/setVolume — same player node, no remount", async () => {
    const streams: StreamRef[] = [
      { id: 'twitch:xqc', platform: 'twitch', channel: 'xqc', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(1));
    const player = createdTwitchPlayers[0];
    const card = container.querySelector<HTMLElement>('[data-stream-id="twitch:xqc"]')!;
    expect(card.dataset.embedMuted).toBe('1');

    enterTheater(container, 'twitch:xqc', streams);

    expect(container.dataset.viewMode).toBe('theater');
    expect(card.dataset.embedMuted).toBe('0');
    expect(player.setMutedCalls.at(-1)).toBe(false);
    expect(player.setVolumeCalls.at(-1)).toBe(0.25);
    // Same player instance, not destroyed/reconstructed by the audio change.
    expect(createdTwitchPlayers).toHaveLength(1);
  });

  it('Twitch fallback mode (no live Player API) is left untouched on Theater entry — no reload, no iframe src mutation, stays muted', () => {
    const streams: StreamRef[] = [
      { id: 'twitch:xqc', platform: 'twitch', channel: 'xqc', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));
    const card = container.querySelector<HTMLElement>('[data-stream-id="twitch:xqc"]')!;
    card.dataset.twitchMode = 'fallback';
    const iframe = card.querySelector<HTMLIFrameElement>('iframe');
    const srcBefore = iframe?.src;

    enterTheater(container, 'twitch:xqc', streams);

    expect(card.dataset.embedMuted).toBe('1');
    expect(card.querySelector<HTMLIFrameElement>('iframe')?.src).toBe(srcBefore);
  });

  it("clicking a muted YouTube card's Theater/expand control unmutes it via the live player's own unMute/setVolume, at the shared default (25)", async () => {
    class FakeYouTubePlayer {
      mutedState = true;
      volumeState = 100;
      muteCalls: boolean[] = [];
      setVolumeCalls: number[] = [];
      constructor(
        public elementId: string,
        public options: { events?: { onReady?: () => void } },
      ) {
        queueMicrotask(() => this.options.events?.onReady?.());
      }
      isMuted(): boolean {
        return this.mutedState;
      }
      getVolume(): number {
        return this.volumeState;
      }
      mute(): void {
        this.mutedState = true;
        this.muteCalls.push(true);
      }
      unMute(): void {
        this.mutedState = false;
        this.muteCalls.push(false);
      }
      setVolume(volume: number): void {
        this.volumeState = volume;
        this.setVolumeCalls.push(volume);
      }
      getCurrentTime(): number {
        return 0;
      }
      getDuration(): number {
        return 0;
      }
      destroy(): void {}
    }

    let created: FakeYouTubePlayer | undefined;
    (globalThis as unknown as { YT: unknown }).YT = {
      Player: class extends FakeYouTubePlayer {
        constructor(elementId: string, options: { events?: { onReady?: () => void } }) {
          super(elementId, options);
          created = this;
        }
      },
    };

    try {
      const streams: StreamRef[] = [
        {
          id: 'youtube:video:dQw4w9WgXcQ',
          platform: 'youtube',
          channel: 'video:dQw4w9WgXcQ',
          muted: true,
          orientation: 'landscape',
        },
      ];
      syncStreamGrid(container, fakeStore(streams));
      await vi.waitFor(() => expect(created).toBeDefined());
      const player = created!;

      enterTheater(container, 'youtube:video:dQw4w9WgXcQ', streams);

      expect(player.muteCalls.at(-1)).toBe(false);
      expect(player.setVolumeCalls.at(-1)).toBe(25);
    } finally {
      delete (globalThis as unknown as { YT?: unknown }).YT;
    }
  });

  it('Kick has no live audio API — Theater entry never throws and leaves it muted for the native player controls', () => {
    const streams: StreamRef[] = [
      { id: 'kick:trainwreckstv', platform: 'kick', channel: 'trainwreckstv', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));
    const card = container.querySelector<HTMLElement>('[data-stream-id="kick:trainwreckstv"]')!;

    expect(() => enterTheater(container, 'kick:trainwreckstv', streams)).not.toThrow();
    expect(card.dataset.embedMuted).toBe('1');
  });

  it('promoting a different stream to primary, or toggling Theater<->Focus on the current primary, does not re-fire the entry unmute (only the deliberate Theater-entry click does)', async () => {
    const streams: StreamRef[] = [
      { id: 'twitch:a', platform: 'twitch', channel: 'a', muted: true, orientation: 'landscape' },
      { id: 'twitch:b', platform: 'twitch', channel: 'b', muted: true, orientation: 'landscape' },
    ];
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() => expect(createdTwitchPlayers).toHaveLength(2));
    const [playerA, playerB] = createdTwitchPlayers;
    const cardA = container.querySelector<HTMLElement>('[data-stream-id="twitch:a"]')!;
    const cardB = container.querySelector<HTMLElement>('[data-stream-id="twitch:b"]')!;

    enterTheater(container, 'twitch:a', streams);
    expect(cardA.dataset.embedMuted).toBe('0');
    expect(playerA.setMutedCalls).toEqual([false]);

    // Re-mute manually (simulates the viewer choosing to mute it back), then
    // promote b to primary — a plain layout promotion, not a fresh Theater
    // entry, so it must not force a's or b's audio to change.
    cardA.dataset.embedMuted = '1';
    playerA.setMuted(true);
    setFocusViewPrimary(container, 'twitch:b');
    expect(playerA.setMutedCalls).toEqual([false, true]);
    expect(playerB.setMutedCalls).toEqual([]);
    expect(cardB.dataset.embedMuted).toBe('1');
  });
});

describe('bindStreamRemoved — Undo hook fires with the removed stream and its previous index', () => {
  let container: HTMLElement;

  function fakeRemovableStore(initial: StreamRef[]): StreamStore {
    let streams = initial;
    return {
      getStreams: () => streams,
      removeStream: (id: string) => {
        streams = streams.filter((s) => s.id !== id);
      },
    } as unknown as StreamStore;
  }

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'stream-grid';
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('fires once with the removed StreamRef and its index when the header X is clicked', async () => {
    const streams: StreamRef[] = ['a', 'b', 'c'].map((channel) => ({
      id: `kick:${channel}`,
      platform: 'kick',
      channel,
      muted: true,
      orientation: 'landscape',
    }));
    const store = fakeRemovableStore(streams);
    syncStreamGrid(container, store);
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(3),
    );

    const calls: Array<{ id: string; index: number }> = [];
    bindStreamRemoved((removed, index) => calls.push({ id: removed.id, index }));

    const closeButton = container.querySelector<HTMLButtonElement>(
      '[data-stream-id="kick:b"] .stream-card__close',
    )!;
    closeButton.click();

    expect(calls).toEqual([{ id: 'kick:b', index: 1 }]);
  });

  it('fires from the headers-hidden overlay X too, with the same (stream, index) shape', async () => {
    const streams: StreamRef[] = ['a', 'b'].map((channel) => ({
      id: `kick:${channel}`,
      platform: 'kick',
      channel,
      muted: true,
      orientation: 'landscape',
    }));
    const store = fakeRemovableStore(streams);
    syncStreamGrid(container, store);
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(2),
    );

    const calls: Array<{ id: string; index: number }> = [];
    bindStreamRemoved((removed, index) => calls.push({ id: removed.id, index }));

    const overlayRemove = container.querySelector<HTMLButtonElement>(
      '[data-stream-id="kick:a"] .stream-card__overlay-remove',
    )!;
    overlayRemove.click();

    expect(calls).toEqual([{ id: 'kick:a', index: 0 }]);
  });
});

/**
 * Regression coverage for the Aug 13 → Aug 14 landscape-grid geometry bug:
 * `grid-auto-rows: var(--player-height, auto)` was added to the base
 * `.stream-grid` rule (unconditionally, for every layout) to stop a
 * portrait-only grid's rows from collapsing to 0px. It floors every implicit
 * row track at *video* height, with no allowance for the card header
 * (CARD_HEADER_HEIGHT), so a pure-landscape grid — which never needed
 * flooring — had every row shorted by the header's height, undersizing
 * every card and leaving the whole grid centered with visible extra
 * top/bottom whitespace. The 24-case "baseline equivalence" suite in
 * gridLayout.test.ts never caught this because it only asserts
 * computeWeightedGridLayout's numeric output (columns/cellWidth/cellHeight)
 * — the JS math was always correct; only the CSS that consumes it applied a
 * side effect the math never accounted for. These two tests instead pin (a)
 * the JS→DOM wiring that scopes the fix, and (b) the CSS source itself, so
 * a future edit can't silently re-globalize this rule.
 */
describe('data-has-portrait wiring — grid-auto-rows must stay portrait-scoped', () => {
  let container: HTMLElement;

  function fakeStore(streams: StreamRef[]): StreamStore {
    return { getStreams: () => streams } as StreamStore;
  }

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'stream-grid';
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('sets data-has-portrait="0" for an all-landscape lineup', () => {
    const streams: StreamRef[] = ['a', 'b', 'c'].map((channel) => ({
      id: `kick:${channel}`,
      platform: 'kick',
      channel,
      muted: true,
      orientation: 'landscape',
    }));
    syncStreamGrid(container, fakeStore(streams));

    expect(container.dataset.hasPortrait).toBe('0');
  });

  it('sets data-has-portrait="1" when any stream is portrait', () => {
    const streams: StreamRef[] = [
      { id: 'kick:a', platform: 'kick', channel: 'a', muted: true, orientation: 'landscape' },
      { id: 'tiktok:b', platform: 'tiktok', channel: 'b', muted: true, orientation: 'portrait' },
    ];
    syncStreamGrid(container, fakeStore(streams));

    expect(container.dataset.hasPortrait).toBe('1');
  });

  it('main.css only applies grid-auto-rows under [data-has-portrait="1"], never on bare .stream-grid', async () => {
    // Vitest stubs out plain `.css` imports (even with ?raw) to an empty
    // module in the jsdom test environment, so this reads the source file
    // directly via node:fs instead — the only node: import in this
    // browser-only project, hence the local ts-expect-error rather than
    // pulling in @types/node.
    // @ts-expect-error no @types/node in this project — see comment above.
    const fs = await import('node:fs');
    // Vitest's cwd is the project root regardless of which file is running.
    const css: string = fs.readFileSync('src/styles/main.css', 'utf-8');

    // Strip comments so /* ... */ prose mentioning the property doesn't
    // produce a false match.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

    const rules = withoutComments.match(/[^{}]+\{[^{}]*\}/g) ?? [];
    const rulesWithAutoRows = rules.filter((rule: string) => /grid-auto-rows\s*:/.test(rule));

    expect(rulesWithAutoRows.length).toBeGreaterThan(0);
    for (const rule of rulesWithAutoRows) {
      const selector = rule.slice(0, rule.indexOf('{'));
      expect(selector).toContain("[data-has-portrait='1']");
    }
  });

  it('portrait cards span two rows but are not forced first via CSS order', async () => {
    // @ts-expect-error no @types/node in this project — see comment above.
    const fs = await import('node:fs');
    const css: string = fs.readFileSync('src/styles/main.css', 'utf-8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(withoutComments).not.toMatch(/order\s*:\s*-1/);
    expect(withoutComments).not.toMatch(/\.is-reordering/);
    expect(withoutComments).toMatch(/\.stream-grid\.is-dragging/);
    expect(withoutComments).toMatch(
      /html\.headers-hidden\s+\.stream-grid\.is-dragging[\s\S]*?\.stream-card__toolbar/,
    );

    const rules = withoutComments.match(/[^{}]+\{[^{}]*\}/g) ?? [];
    const portraitCardRules = rules.filter((rule: string) => {
      const selector = rule.slice(0, rule.indexOf('{'));
      return (
        /\[data-orientation=['"]portrait['"]\]/.test(selector) &&
        /\.stream-card(?!__)/.test(selector)
      );
    });
    expect(portraitCardRules.some((rule: string) => /grid-row\s*:/.test(rule))).toBe(true);
  });

  it('unmuted speaker buttons tint only the icon red — no glow, gradient, or red chrome', async () => {
    // @ts-expect-error no @types/node in this project — see comment above.
    const fs = await import('node:fs');
    const css: string = fs.readFileSync('src/styles/main.css', 'utf-8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const match = withoutComments.match(
      /\.stream-card__mute-btn\[aria-pressed=['"]false['"]\]\s*\{[^}]*\}/,
    );
    expect(match?.[0]).toMatch(/color:\s*var\(--danger\)/);
    expect(match?.[0]).not.toMatch(/box-shadow/);
    expect(match?.[0]).not.toMatch(/gradient/);
    expect(match?.[0]).not.toMatch(/border-color/);
    expect(match?.[0]).not.toMatch(/background:/);
  });

  it('Story Card preview dims the page with a plain rgba backdrop and no compositor effects', async () => {
    // @ts-expect-error no @types/node in this project — see comment above.
    const fs = await import('node:fs');
    const css: string = fs.readFileSync('src/styles/main.css', 'utf-8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const previewBlock = withoutComments.slice(
      withoutComments.indexOf('.story-preview {'),
      withoutComments.indexOf('.welcome-modal {'),
    );
    expect(previewBlock).toContain('.story-preview {');
    expect(previewBlock).toContain('.story-preview__backdrop {');
    expect(previewBlock).not.toMatch(/backdrop-filter/);
    expect(previewBlock).not.toMatch(/(?<!box-)filter\s*:/);
    expect(previewBlock).not.toMatch(/\bblur\s*\(/);
    expect(previewBlock).not.toMatch(/\btransform\s*:/);
    expect(previewBlock).not.toMatch(/\bperspective\s*:/);
    const dialogBlock = previewBlock.slice(
      previewBlock.indexOf('.story-preview {'),
      previewBlock.indexOf('.story-preview[hidden]'),
    );
    expect(dialogBlock).not.toMatch(/inset\s*:\s*0/);
    const backdropBlock = previewBlock.slice(
      previewBlock.indexOf('.story-preview__backdrop {'),
      previewBlock.indexOf('.story-preview__backdrop[hidden]'),
    );
    expect(backdropBlock).toMatch(/inset\s*:\s*0/);
    expect(backdropBlock).toMatch(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.6[0-9]*\s*\)/);
  });

  it('Story Card preview markup includes Copy Watch URL, Share Watch Party, and a dimmer sibling', async () => {
    // @ts-expect-error no @types/node in this project — see comment above.
    const fs = await import('node:fs');
    const html: string = fs.readFileSync('index.html', 'utf-8');
    expect(html).toContain('id="story-preview-copy"');
    expect(html).toContain('Copy Watch URL');
    expect(html).toContain('id="story-preview-share"');
    expect(html).toContain('Share Watch Party');
    expect(html).toContain('id="story-preview-backdrop"');
    expect(html).toContain('story-preview__backdrop');
  });

  it('headers-hidden does not lock portrait cards to landscape --player-height', async () => {
    // @ts-expect-error no @types/node in this project — see comment above.
    const fs = await import('node:fs');
    const css: string = fs.readFileSync('src/styles/main.css', 'utf-8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).toMatch(
      /html\.headers-hidden[\s\S]*?\[data-orientation=['"]portrait['"]\]\s*\{[^}]*height:\s*auto/,
    );
  });

  it('TikTok unavailable UI stacks a centered message above the Open on TikTok link', async () => {
    syncStreamGrid(container, fakeStore([
      { id: 'tiktok:offlineuser', platform: 'tiktok', channel: 'offlineuser', muted: true, orientation: 'portrait' },
    ]));

    const status = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>('.stream-card__tiktok-status');
      const link = el?.querySelector<HTMLAnchorElement>('.stream-card__tiktok-status-link');
      if (!el || !link) throw new Error('tiktok unavailable status not rendered');
      return el;
    });
    const message = status.querySelector('.stream-card__tiktok-status-message');
    const link = status.querySelector<HTMLAnchorElement>('.stream-card__tiktok-status-link');
    expect(message?.textContent).toMatch(/TikTok LIVE|couldn't be found|offline/i);
    expect(link?.textContent).toBe('Open on TikTok');
    expect(link?.parentElement).toBe(status);
    expect(message?.contains(link)).toBe(false);
    expect(container.querySelector<HTMLElement>('[data-stream-id="tiktok:offlineuser"]')?.dataset.tiktokAvatarUrl).toBe(
      '/api/tiktok-avatar.php?u=offlineuser',
    );
  });

  it('TikTok cards expose a same-origin avatar proxy URL for the Story Card', () => {
    syncStreamGrid(container, fakeStore([
      { id: 'tiktok:creator', platform: 'tiktok', channel: 'creator', muted: true, orientation: 'portrait' },
    ]));
    const card = container.querySelector<HTMLElement>('[data-stream-id="tiktok:creator"]');
    expect(card?.dataset.tiktokAvatarUrl).toBe('/api/tiktok-avatar.php?u=creator');
  });
});

/**
 * Same shape as buildTwitchCard, but for Kick: two name-badge dots (header +
 * hover toolbar) that start in the decorative always-pulsing state
 * createNameBadge gives every non-Twitch platform, a header meta span, and a
 * mounted iframe standing in for the real Kick player — so these tests can
 * prove the metadata path never touches it.
 */
function buildKickCard(channel: string): { card: HTMLElement; iframe: HTMLIFrameElement } {
  const card = document.createElement('article');
  card.className = 'stream-card stream-card--kick';
  card.dataset.platform = 'kick';
  card.dataset.channel = channel;

  const header = document.createElement('div');
  header.className = 'stream-card__header';
  const headerBadge = document.createElement('div');
  headerBadge.className = 'stream-card__name-badge';
  const headerDot = document.createElement('span');
  headerDot.className = 'stream-card__name-badge-dot stream-card__name-badge-dot--pulse';
  headerDot.setAttribute('aria-hidden', 'true');
  const headerMeta = document.createElement('span');
  headerMeta.className = 'stream-card__name-badge-meta';
  headerMeta.hidden = true;
  headerBadge.append(headerDot, headerMeta);
  header.append(headerBadge);

  const player = document.createElement('div');
  player.className = 'stream-card__player';
  const mount = document.createElement('div');
  mount.className = 'stream-card__kick-frame';
  const iframe = document.createElement('iframe');
  iframe.className = 'stream-card__iframe';
  iframe.src = `https://player.kick.com/${channel}?muted=true&autoplay=true`;
  mount.append(iframe);
  player.append(mount);

  const toolbar = document.createElement('div');
  toolbar.className = 'stream-card__toolbar';
  const toolbarBadge = document.createElement('div');
  toolbarBadge.className = 'stream-card__name-badge';
  const toolbarDot = document.createElement('span');
  toolbarDot.className = 'stream-card__name-badge-dot stream-card__name-badge-dot--pulse';
  toolbarDot.setAttribute('aria-hidden', 'true');
  toolbarBadge.append(toolbarDot);
  toolbar.append(toolbarBadge);

  card.append(header, player, toolbar);
  return { card, iframe };
}

function kickLive(channel: string, overrides: Partial<KickStatusResult> = {}): KickStatusResult {
  return {
    status: 'live',
    input: channel,
    normalized: channel,
    displayName: channel,
    category: 'Just Chatting',
    viewerCount: 8200,
    startedAt: new Date(Date.now() - 137 * 60_000).toISOString(),
    ...overrides,
  } as KickStatusResult;
}

describe('applyKickStatus — metadata rendering', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    __resetKickDurationTimerForTests();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders viewer count and elapsed duration in the same "· 8.2K viewers · 2h 17m" shape Twitch uses', () => {
    const { card } = buildKickCard('deenthegreat');
    container.append(card);

    applyKickStatus(container, new Map([['deenthegreat', kickLive('deenthegreat')]]));

    const meta = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
    expect(meta?.textContent).toBe('· 8.2K viewers · 2h 17m');
    expect(meta?.hidden).toBe(false);
  });

  it('marks every name-badge dot live and drops the decorative-only state', () => {
    const { card } = buildKickCard('deenthegreat');
    container.append(card);

    applyKickStatus(container, new Map([['deenthegreat', kickLive('deenthegreat')]]));

    const dots = card.querySelectorAll('.stream-card__name-badge-dot');
    expect(dots).toHaveLength(2);
    for (const dot of dots) {
      expect(dot.classList.contains('stream-card__name-badge-dot--live')).toBe(true);
      expect(dot.getAttribute('aria-label')).toContain('Live');
      expect(dot.getAttribute('aria-label')).toContain('Just Chatting');
    }
  });

  it('never shows a stale viewer count or a ticking duration once offline', () => {
    const { card } = buildKickCard('deenthegreat');
    container.append(card);

    applyKickStatus(container, new Map([['deenthegreat', kickLive('deenthegreat')]]));
    applyKickStatus(
      container,
      new Map([['deenthegreat', { status: 'offline', input: 'deenthegreat', normalized: 'deenthegreat' }]]),
    );

    expect(card.dataset.kickViewerCount).toBeUndefined();
    expect(card.dataset.kickStartedAt).toBeUndefined();
    const meta = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
    expect(meta?.textContent).toBe('');
    expect(meta?.hidden).toBe(true);
  });

  it('retains a live Kick avatar after an offline poll that omits avatarUrl', () => {
    const { card } = buildKickCard('deenthegreat');
    container.append(card);

    applyKickStatus(
      container,
      new Map([
        ['deenthegreat', kickLive('deenthegreat', { avatarUrl: 'https://files.kick.com/deen.webp' })],
      ]),
    );
    applyKickStatus(
      container,
      new Map([['deenthegreat', { status: 'offline', input: 'deenthegreat', normalized: 'deenthegreat' }]]),
    );

    expect(card.dataset.kickAvatarUrl).toBe('https://files.kick.com/deen.webp');
    expect(card.dataset.kickViewerCount).toBeUndefined();
    expect(card.dataset.kickStartedAt).toBeUndefined();
  });

  it('exposes the profile image as data-kick-avatar-url for the Story Card pipeline', () => {
    const { card } = buildKickCard('deenthegreat');
    container.append(card);

    applyKickStatus(
      container,
      new Map([
        ['deenthegreat', kickLive('deenthegreat', { avatarUrl: 'https://files.kick.com/deen.webp' })],
      ]),
    );

    expect(card.dataset.kickAvatarUrl).toBe('https://files.kick.com/deen.webp');
  });

  it('keeps an offline channel avatar so the Story Card still gets a real picture', () => {
    const { card } = buildKickCard('offlineguy');
    container.append(card);

    applyKickStatus(
      container,
      new Map([
        [
          'offlineguy',
          {
            status: 'offline',
            input: 'offlineguy',
            normalized: 'offlineguy',
            avatarUrl: 'https://files.kick.com/off.webp',
          } as KickStatusResult,
        ],
      ]),
    );

    expect(card.dataset.kickAvatarUrl).toBe('https://files.kick.com/off.webp');
  });

  it('leaves the card completely untouched for not_configured — no dot change, no meta, no avatar', () => {
    const { card } = buildKickCard('deenthegreat');
    container.append(card);
    const dot = card.querySelector<HTMLElement>('.stream-card__name-badge-dot');
    const classesBefore = dot?.className;

    applyKickStatus(
      container,
      new Map([
        ['deenthegreat', { status: 'not_configured', input: 'deenthegreat', normalized: 'deenthegreat' }],
      ]),
    );

    expect(dot?.className).toBe(classesBefore);
    expect(card.dataset.kickStatus).toBeUndefined();
    expect(card.dataset.kickAvatarUrl).toBeUndefined();
    expect(card.querySelector<HTMLElement>('.stream-card__name-badge-meta')?.hidden).toBe(true);
  });

  it('never touches the Kick player iframe, whatever the status', () => {
    const { card, iframe } = buildKickCard('deenthegreat');
    container.append(card);
    const srcBefore = iframe.src;

    applyKickStatus(container, new Map([['deenthegreat', kickLive('deenthegreat')]]));
    applyKickStatus(
      container,
      new Map([['deenthegreat', { status: 'unavailable', input: 'deenthegreat', normalized: 'deenthegreat' }]]),
    );
    applyKickStatus(
      container,
      new Map([['deenthegreat', { status: 'not_configured', input: 'deenthegreat', normalized: 'deenthegreat' }]]),
    );

    expect(card.querySelector('iframe')).toBe(iframe);
    expect(iframe.src).toBe(srcBefore);
  });

  it('leaves a card with no matching result exactly as it was', () => {
    const { card } = buildKickCard('deenthegreat');
    container.append(card);
    applyKickStatus(container, new Map([['deenthegreat', kickLive('deenthegreat')]]));

    applyKickStatus(container, new Map([['someoneelse', kickLive('someoneelse')]]));

    expect(card.dataset.kickViewerCount).toBe('8200');
  });
});

describe('refreshKickStatus / refreshAllKickStatuses — batching', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('sends exactly one batched request for many channels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ platform: 'kick', results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const container = document.createElement('div');
    document.body.append(container);
    container.append(...['a', 'b', 'c'].map((ch) => buildKickCard(ch).card));

    refreshKickStatus(container, ['a', 'b', 'c']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('makes no request for an empty channel list', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    refreshKickStatus(document.createElement('div'), []);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collects Kick-only channels from the store', async () => {
    const grid = document.createElement('div');
    grid.id = 'stream-grid';
    document.body.append(grid);
    grid.append(buildKickCard('deenthegreat').card);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ platform: 'kick', results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const store = createStreamStore() as StreamStore;
    vi.spyOn(store, 'getStreams').mockReturnValue([
      { id: 'k:deenthegreat', platform: 'kick', channel: 'deenthegreat', muted: true, orientation: 'landscape' },
      { id: 't:foo', platform: 'twitch', channel: 'foo', muted: true, orientation: 'landscape' },
    ]);

    const result = await refreshAllKickStatuses(store, 'manual');

    expect(result.outcome).toBe('ok');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).channels).toEqual(['deenthegreat']);
  });

  it('resolves to skipped-empty with no request when no Kick streams exist', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const store = createStreamStore() as StreamStore;
    vi.spyOn(store, 'getStreams').mockReturnValue([
      { id: 't:foo', platform: 'twitch', channel: 'foo', muted: true, orientation: 'landscape' },
    ]);

    const result = await refreshAllKickStatuses(store, 'manual');

    expect(result.outcome).toBe('skipped-empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Regression guard for the portrait-grid row-track height. main.css pins
 * `grid-auto-rows` for a grid containing a portrait card, and it must be
 * pinned at PLAYER + HEADER, not the player alone. Pinned at the player
 * alone, every landscape card in that grid ends up one header-height too
 * short, the flex column takes the difference out of the player, and the
 * result is a wider-than-16:9 player host — which is exactly what made
 * Twitch pillarbox itself with app-created black side gutters and clipped
 * the bottom of Kick's CSS-scaled native control bar.
 */
describe('portrait grid row-track height (--grid-row-height)', () => {
  const CARD_HEADER_HEIGHT = 42;
  let streamArea: HTMLElement;
  let container: HTMLElement;

  function fakeStore(streams: StreamRef[]): StreamStore {
    return { getStreams: () => streams } as StreamStore;
  }

  beforeEach(() => {
    streamArea = document.createElement('div');
    streamArea.className = 'stream-area';
    container = document.createElement('div');
    container.id = 'stream-grid';
    streamArea.append(container);
    document.body.append(streamArea);
    Object.defineProperty(streamArea, 'clientWidth', { configurable: true, get: () => 1400 });
    Object.defineProperty(streamArea, 'clientHeight', { configurable: true, get: () => 900 });
    // jsdom has no matchMedia; updateGridLayout consults it (via
    // isStackedStreamLayout) to decide between the phone stack and the real
    // packer. Always answering "no match" selects the desktop grid path,
    // which is the one under test.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    // Only needs to exist so the Twitch cards mount through the 'api' path
    // like they do in production — nothing here asserts on the player.
    (globalThis as unknown as { Twitch: unknown }).Twitch = {
      Player: class {
        static readonly READY = 'READY';
        static readonly PLAY = 'PLAY';
        static readonly PLAYING = 'PLAYING';
        static readonly PAUSE = 'PAUSE';
        static readonly ENDED = 'ENDED';
        static readonly PLAYBACK_BLOCKED = 'PLAYBACK_BLOCKED';
        static readonly OFFLINE = 'OFFLINE';
        static readonly ONLINE = 'ONLINE';
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
        addEventListener(): void {}
        removeEventListener(): void {}
        destroy(): void {}
      },
    };
  });

  afterEach(() => {
    syncStreamGrid(container, fakeStore([]));
    delete (globalThis as unknown as { Twitch?: unknown }).Twitch;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function mixedLineup(): StreamRef[] {
    return [
      { id: 'tt:creator', platform: 'tiktok', channel: 'creator', muted: true, orientation: 'portrait' },
      { id: 't:a', platform: 'twitch', channel: 'a', muted: true, orientation: 'landscape' },
      { id: 't:b', platform: 'twitch', channel: 'b', muted: true, orientation: 'landscape' },
      { id: 'k:c', platform: 'kick', channel: 'c', muted: true, orientation: 'landscape' },
    ];
  }

  it('sets a row track exactly one card header taller than the player box', async () => {
    const streams = mixedLineup();
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() => expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(4));

    updateGridLayout(container);

    const playerHeight = Number.parseFloat(container.style.getPropertyValue('--player-height'));
    const rowHeight = Number.parseFloat(container.style.getPropertyValue('--grid-row-height'));

    expect(playerHeight).toBeGreaterThan(0);
    // jsdom reports offsetHeight 0, so measureCardChrome falls back to the
    // packer's own constant; the track is then that header plus the player,
    // rounded up so the card never has to flex-shrink into its own video.
    expect(rowHeight - playerHeight).toBeGreaterThanOrEqual(CARD_HEADER_HEIGHT);
    expect(rowHeight - playerHeight).toBeLessThan(CARD_HEADER_HEIGHT + 1);
  });

  it('keeps the player box itself exactly 16:9 so a landscape embed has no app-created side gutters', async () => {
    const streams = mixedLineup();
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() => expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(4));

    updateGridLayout(container);

    const playerWidth = Number.parseFloat(container.style.getPropertyValue('--player-width'));
    const playerHeight = Number.parseFloat(container.style.getPropertyValue('--player-height'));

    // Written unrounded off the width the player really gets (track width
    // minus the card border, 0 under jsdom), so 16:9 is exact — not rounded
    // to a host a pixel wider than its video, which is what pillarboxed the
    // Twitch embeds.
    expect(playerHeight).toBeCloseTo(playerWidth * (9 / 16), 9);
  });

  it('clears --grid-row-height along with the other layout vars when the grid empties', async () => {
    const streams = mixedLineup();
    syncStreamGrid(container, fakeStore(streams));
    await vi.waitFor(() => expect(container.querySelectorAll('[data-stream-id]')).toHaveLength(4));
    updateGridLayout(container);
    expect(container.style.getPropertyValue('--grid-row-height')).not.toBe('');

    syncStreamGrid(container, fakeStore([]));
    updateGridLayout(container);

    expect(container.style.getPropertyValue('--grid-row-height')).toBe('');
    expect(container.style.getPropertyValue('--player-height')).toBe('');
  });
});
