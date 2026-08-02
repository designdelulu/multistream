import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTwitchDurationTimerForTests,
  applyTwitchStatus,
  refreshAllTwitchStatuses,
  refreshTwitchStatus,
  twitchStatusDotProps,
} from './StreamGrid';
import { createStreamStore, type StreamStore } from '../state/streams';
import type { TwitchStatusResult } from '../platforms/twitchStatus';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetTwitchDurationTimerForTests();
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

  it('renders category + viewer count + duration on both dot instances and the header meta span for a live result', () => {
    const { card } = buildTwitchCard('foo');
    container.append(card);

    applyTwitchStatus(container, new Map([['foo', liveResult('foo')]]));

    const dots = card.querySelectorAll<HTMLElement>('.stream-card__name-badge-dot');
    expect(dots).toHaveLength(2);
    for (const dot of dots) {
      expect(dot.classList.contains('stream-card__name-badge-dot--live')).toBe(true);
      expect(dot.classList.contains('stream-card__name-badge-dot--pulse')).toBe(true);
      expect(dot.getAttribute('aria-hidden')).toBe('false');
      expect(dot.title).toBe('Live · Just Chatting · 42 viewers · 37m');
    }

    const meta = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
    expect(meta?.hidden).toBe(false);
    expect(meta?.textContent).toBe('· Just Chatting · 42 viewers · 37m');
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
    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).toBe(
      '· Just Chatting · 42 viewers · 37m',
    );

    vi.advanceTimersByTime(60_000);

    expect(card.querySelector('.stream-card__name-badge-meta')?.textContent).toBe(
      '· Just Chatting · 42 viewers · 38m',
    );
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
      { id: 't:Foo', platform: 'twitch', channel: 'Foo', muted: true },
      { id: 't:bar', platform: 'twitch', channel: 'bar', muted: true },
      { id: 'k:baz', platform: 'kick', channel: 'baz', muted: true },
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
      { id: 'k:baz', platform: 'kick', channel: 'baz', muted: true },
    ]);

    const result = await refreshAllTwitchStatuses(store, 'manual');

    expect(result.outcome).toBe('skipped-empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
