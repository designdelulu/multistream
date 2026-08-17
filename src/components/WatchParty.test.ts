import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindWatchParty, resolveViewForLineup, type WatchPartyViewSync } from './WatchParty';
import type { WatchPartySession, WatchPartyView } from '../lib/watchParty';
import { createStreamStore } from '../state/streams';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function session(overrides: Partial<WatchPartySession> = {}): WatchPartySession {
  return {
    id: 'abcdefghij',
    status: 'active',
    streams: [{ platform: 'twitch', channel: 'shroud' }],
    updatedAt: 100,
    createdAt: 90,
    ...overrides,
  };
}

function createViewSyncHarness(initial: WatchPartyView = { mode: 'grid', primary: null }) {
  const listeners = new Set<() => void>();
  let view = initial;
  const applyView = vi.fn((next: WatchPartyView) => {
    view = next;
  });
  const sync: WatchPartyViewSync = {
    getView: () => view,
    applyView,
    subscribeView: (listener) => {
      listeners.add(listener);
    },
  };
  return {
    sync,
    applyView,
    getView: () => view,
    setView: (next: WatchPartyView) => {
      view = next;
    },
    emit: () => {
      for (const listener of listeners) listener();
    },
  };
}

function stubPhoneViewport(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function postBodies(action: string, id?: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .map(([, init]) => init as RequestInit | undefined)
    .filter((init): init is RequestInit => typeof init?.body === 'string')
    .map((init) => JSON.parse(init.body as string) as Record<string, unknown>)
    .filter((body) => body.action === action && (id === undefined || body.id === id));
}

describe('resolveViewForLineup', () => {
  const lineup = [
    { platform: 'twitch' as const, channel: 'a' },
    { platform: 'kick' as const, channel: 'b' },
  ];

  it('passes grid through untouched', () => {
    expect(resolveViewForLineup({ mode: 'grid', primary: null }, lineup)).toEqual({
      mode: 'grid',
      primary: null,
    });
  });

  it('passes a valid theater/focus primary through', () => {
    expect(resolveViewForLineup({ mode: 'theater', primary: 'twitch:a' }, lineup)).toEqual({
      mode: 'theater',
      primary: 'twitch:a',
    });
    expect(resolveViewForLineup({ mode: 'focus', primary: 'kick:b' }, lineup)).toEqual({
      mode: 'focus',
      primary: 'kick:b',
    });
  });

  it('falls back to grid when the primary is missing or not in the lineup', () => {
    expect(resolveViewForLineup({ mode: 'theater', primary: null }, lineup)).toEqual({
      mode: 'grid',
      primary: null,
    });
    expect(resolveViewForLineup({ mode: 'focus', primary: 'twitch:zzz' }, lineup)).toEqual({
      mode: 'grid',
      primary: null,
    });
  });

  it('preserves optional chat visibility while resolving the lineup', () => {
    expect(
      resolveViewForLineup(
        { mode: 'theater', primary: 'twitch:missing', chatVisible: false },
        lineup,
      ),
    ).toEqual({ mode: 'grid', primary: null, chatVisible: false });
  });
});

describe('bindWatchParty — host spotlight push', () => {
  it('sends the current view on create', async () => {
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'create') {
        return Promise.resolve(
          okJson({ ok: true, id: 'abcdefghij', hostToken: 't'.repeat(64), session: session() }),
        );
      }
      return Promise.resolve(okJson({ ok: true, session: session() }));
    });
    const store = createStreamStore();
    store.addStream('shroud');
    const view = createViewSyncHarness({ mode: 'theater', primary: 'twitch:shroud' });
    const wp = bindWatchParty(store, view.sync);

    const result = await wp.start();
    expect(result.ok).toBe(true);
    expect(postBodies('create')[0]?.view).toEqual({ mode: 'theater', primary: 'twitch:shroud' });
  });

  it('pushes on the debounce when only the view changes (no lineup change)', async () => {
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'create') {
        return Promise.resolve(
          okJson({ ok: true, id: 'abcdefghij', hostToken: 't'.repeat(64), session: session() }),
        );
      }
      return Promise.resolve(okJson({ ok: true, session: session() }));
    });
    const store = createStreamStore();
    store.addStream('shroud');
    const view = createViewSyncHarness();
    const wp = bindWatchParty(store, view.sync);
    await wp.start();
    expect(postBodies('update')).toHaveLength(0);

    view.setView({ mode: 'theater', primary: 'twitch:shroud' });
    view.emit();
    await vi.advanceTimersByTimeAsync(399);
    expect(postBodies('update')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(postBodies('update')).toHaveLength(1);
    expect(postBodies('update')[0].view).toEqual({ mode: 'theater', primary: 'twitch:shroud' });
  });

  it('maps server throttling to friendly status text on start', async () => {
    const store = createStreamStore();
    store.addStream('shroud');
    const view = createViewSyncHarness();
    const wp = bindWatchParty(store, view.sync);

    fetchMock.mockImplementation(() =>
      Promise.resolve(okJson({ ok: false, error: 'rate_limited' })),
    );
    const limited = await wp.start();
    expect(limited.ok).toBe(false);
    expect(wp.getStatusText()).toBe(
      'Too many watch parties are being created right now — try again shortly.',
    );

    fetchMock.mockImplementation(() => Promise.resolve(okJson({ ok: false, error: 'busy' })));
    const full = await wp.start();
    expect(full.ok).toBe(false);
    expect(wp.getStatusText()).toBe('The watch-party server is full right now — try again later.');
  });

  it('viewers keep their lineup and keep polling when a poll is rate-limited', async () => {
    window.history.replaceState({}, '', '/w/abcdefghij');
    let limited = false;
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        limited ? okJson({ ok: false, error: 'rate_limited' }) : okJson({ ok: true, session: session() }),
      ),
    );
    const store = createStreamStore();
    const view = createViewSyncHarness();
    const wp = bindWatchParty(store, view.sync);
    await vi.advanceTimersByTimeAsync(0);
    expect(wp.getRole()).toBe('viewer');
    expect(store.getStreams().map((s) => s.id)).toEqual(['twitch:shroud']);

    limited = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(wp.getRole()).toBe('viewer');
    expect(store.getStreams().map((s) => s.id)).toEqual(['twitch:shroud']);

    limited = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(wp.getRole()).toBe('viewer');
    expect(wp.getStatusText()).toContain('Watching a live watch party');
  });

  it('does not re-push when the view listener fires without an actual change', async () => {
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'create') {
        return Promise.resolve(
          okJson({ ok: true, id: 'abcdefghij', hostToken: 't'.repeat(64), session: session() }),
        );
      }
      return Promise.resolve(okJson({ ok: true, session: session() }));
    });
    const store = createStreamStore();
    store.addStream('shroud');
    const view = createViewSyncHarness();
    const wp = bindWatchParty(store, view.sync);
    await wp.start();

    view.emit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(postBodies('update')).toHaveLength(0);
  });
});

describe('bindWatchParty — viewer spotlight follow', () => {
  function mockSessionFetch(current: () => WatchPartySession): void {
    fetchMock.mockImplementation(() => Promise.resolve(okJson({ ok: true, session: current() })));
  }

  it('applies the host view from the session on join', async () => {
    window.history.replaceState({}, '', '/w/abcdefghij');
    mockSessionFetch(() =>
      session({ view: { mode: 'theater', primary: 'twitch:shroud' } }),
    );
    const store = createStreamStore();
    const view = createViewSyncHarness();
    bindWatchParty(store, view.sync);
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getStreams().map((s) => s.id)).toEqual(['twitch:shroud']);
    expect(view.applyView).toHaveBeenCalledTimes(1);
    expect(view.applyView).toHaveBeenCalledWith({ mode: 'theater', primary: 'twitch:shroud' });
  });

  it('does not fight a viewer override while the host view is unchanged, but follows the next host change', async () => {
    window.history.replaceState({}, '', '/w/abcdefghij');
    let current = session({ view: { mode: 'theater', primary: 'twitch:shroud' } });
    mockSessionFetch(() => current);
    const store = createStreamStore();
    const view = createViewSyncHarness();
    bindWatchParty(store, view.sync);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.applyView).toHaveBeenCalledTimes(1);

    // Viewer locally overrides to grid; polls with the same host view must
    // not yank them back.
    view.setView({ mode: 'grid', primary: null });
    await vi.advanceTimersByTimeAsync(4000);
    expect(view.applyView).toHaveBeenCalledTimes(1);

    // Host changes the view: the viewer follows again.
    current = session({
      view: { mode: 'focus', primary: 'twitch:shroud' },
      updatedAt: 200,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.applyView).toHaveBeenCalledTimes(2);
    expect(view.applyView).toHaveBeenLastCalledWith({ mode: 'focus', primary: 'twitch:shroud' });
  });

  it('resolves a stale primary (not in the lineup) to grid before applying', async () => {
    window.history.replaceState({}, '', '/w/abcdefghij');
    mockSessionFetch(() =>
      session({ view: { mode: 'theater', primary: 'twitch:gone' } }),
    );
    const store = createStreamStore();
    const view = createViewSyncHarness();
    bindWatchParty(store, view.sync);
    await vi.advanceTimersByTimeAsync(0);

    expect(view.applyView).toHaveBeenCalledWith({ mode: 'grid', primary: null });
  });

  it('ignores the host view entirely on phone viewports (single-column grid only)', async () => {
    stubPhoneViewport(true);
    window.history.replaceState({}, '', '/w/abcdefghij');
    mockSessionFetch(() =>
      session({ view: { mode: 'theater', primary: 'twitch:shroud' } }),
    );
    const store = createStreamStore();
    const view = createViewSyncHarness();
    bindWatchParty(store, view.sync);
    await vi.advanceTimersByTimeAsync(0);

    // Lineup still applies; only the view is skipped.
    expect(store.getStreams().map((s) => s.id)).toEqual(['twitch:shroud']);
    expect(view.applyView).not.toHaveBeenCalled();
  });

  it('keeps the local view when the session predates host spotlight (no view key)', async () => {
    window.history.replaceState({}, '', '/w/abcdefghij');
    mockSessionFetch(() => session());
    const store = createStreamStore();
    const view = createViewSyncHarness({ mode: 'theater', primary: 'twitch:shroud' });
    bindWatchParty(store, view.sync);
    await vi.advanceTimersByTimeAsync(0);

    expect(view.applyView).not.toHaveBeenCalled();
    expect(view.getView()).toEqual({ mode: 'theater', primary: 'twitch:shroud' });
  });

  it('shows "Host is live" / "Host away" from the session, and no hint when the field is absent', async () => {
    window.history.replaceState({}, '', '/w/abcdefghij');
    let current = session({ hostLive: true });
    mockSessionFetch(() => current);
    const store = createStreamStore();
    const view = createViewSyncHarness();
    const wp = bindWatchParty(store, view.sync);
    await vi.advanceTimersByTimeAsync(0);
    expect(wp.getStatusText()).toBe('Watching a live watch party · Host is live');

    current = session({ hostLive: false, updatedAt: 200 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(wp.getStatusText()).toBe('Watching a live watch party · Host away');

    // A server that predates presence never sends hostLive — show no hint.
    current = session({ updatedAt: 300 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(wp.getStatusText()).toBe('Watching a live watch party — lineup updates automatically');
  });

  it('rides a presence ping (vid + hb=1) on at most one poll per 30s', async () => {
    window.history.replaceState({}, '', '/w/abcdefghij');
    mockSessionFetch(() => session());
    const store = createStreamStore();
    const view = createViewSyncHarness();
    bindWatchParty(store, view.sync);
    await vi.advanceTimersByTimeAsync(0); // hydrate (GET, no ping)

    const pingUrls = (): string[] =>
      fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes('hb=1'));

    // First viewer poll carries the ping; the 2s polls after it don't.
    await vi.advanceTimersByTimeAsync(2000);
    expect(pingUrls()).toHaveLength(1);
    expect(pingUrls()[0]).toContain('vid=');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pingUrls()).toHaveLength(1);

    // After the 30s throttle window, the next poll pings again.
    await vi.advanceTimersByTimeAsync(22_000);
    expect(pingUrls()).toHaveLength(2);
  });
});

describe('bindWatchParty — host presence heartbeat', () => {
  let hidden = false;
  // Each test hosts its own room: visibilitychange listeners from earlier
  // tests' controllers stay attached to the shared document, so heartbeat
  // assertions always filter by room id.
  let roomId = 'hbtest0000';

  beforeEach(() => {
    hidden = false;
    roomId = roomId.slice(0, -1) + String(Number(roomId.slice(-1)) + 1);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'create') {
        return Promise.resolve(
          okJson({ ok: true, id: roomId, hostToken: 't'.repeat(64), session: session({ id: roomId }) }),
        );
      }
      return Promise.resolve(okJson({ ok: true, session: session({ id: roomId }) }));
    });
  });

  async function startHost() {
    const store = createStreamStore();
    store.addStream('shroud');
    const view = createViewSyncHarness();
    const wp = bindWatchParty(store, view.sync);
    await wp.start();
    await vi.advanceTimersByTimeAsync(0);
    return wp;
  }

  it('pings on start and then every 30s while the tab is visible', async () => {
    await startHost();
    expect(postBodies('heartbeat', roomId)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(postBodies('heartbeat', roomId)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(postBodies('heartbeat', roomId)).toHaveLength(3);
  });

  it('pauses while the tab is hidden and re-pings immediately on return', async () => {
    await startHost();
    expect(postBodies('heartbeat', roomId)).toHaveLength(1);

    hidden = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(postBodies('heartbeat', roomId)).toHaveLength(1);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(postBodies('heartbeat', roomId)).toHaveLength(2);
  });

  it('shows the host-only viewer count in the party status', async () => {
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'create') {
        return Promise.resolve(
          okJson({
            ok: true,
            id: roomId,
            hostToken: 't'.repeat(64),
            viewerCount: 0,
            session: session({ id: roomId }),
          }),
        );
      }
      return Promise.resolve(okJson({ ok: true, viewerCount: 3, session: session({ id: roomId }) }));
    });
    const wp = await startHost();
    expect(wp.getStatusText()).toBe('Live watch party · 3 watching');
  });

  it('a heartbeat that learns the room ended drops the host out of hosting', async () => {
    const wp = await startHost();
    expect(wp.getRole()).toBe('host');

    const ended = { ok: false, error: 'ended' };
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      // Other rooms' stray listeners keep working; this room reports ended.
      return Promise.resolve(okJson(body.id === roomId ? ended : { ok: true, session: session() }));
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wp.getRole()).toBe('none');
    expect(wp.getStatusText()).toBe('Watch party ended');

    // No further heartbeats for this room after it is gone.
    const count = postBodies('heartbeat', roomId).length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(postBodies('heartbeat', roomId)).toHaveLength(count);
  });
});
