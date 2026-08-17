import {
  WATCH_PARTY_HEARTBEAT_INTERVAL_MS,
  WATCH_PARTY_POLL_INTERVAL_MS,
  WATCH_PARTY_VIEWER_PING_INTERVAL_MS,
  clearHostRecord,
  createWatchParty,
  endWatchParty,
  fetchWatchParty,
  getViewerId,
  heartbeatWatchParty,
  hostRecordForRoom,
  lineupFingerprint,
  saveHostRecord,
  streamsToWatchPartyPayload,
  updateWatchParty,
  viewFingerprint,
  watchPartyIdFromPath,
  watchPartyPath,
  watchPartyUrl,
  type WatchPartyRole,
  type WatchPartySession,
  type WatchPartyStream,
  type WatchPartyView,
} from '../lib/watchParty';
import { isPhoneViewport } from '../lib/viewport';
import type { StreamStore } from '../state/streams';

export interface WatchPartyController {
  getRole(): WatchPartyRole;
  getRoomId(): string | null;
  getViewerUrl(): string | null;
  getStatusText(): string;
  start(): Promise<{ ok: boolean; url?: string; error?: string }>;
  end(): Promise<{ ok: boolean; error?: string }>;
  applyChrome(): void;
  subscribe(listener: () => void): () => void;
}

/**
 * Host spotlight wiring, injected from main.ts (the only place that knows
 * about the view-mode store and the grid's focus-view helpers):
 * - getView: current local view mode + primary stream id (host pushes this).
 * - applyView: apply a host view locally (viewer side; already resolved
 *   against the lineup and never called on phone viewports).
 * - subscribeView: fires whenever the local view mode or primary changes.
 */
export interface WatchPartyViewSync {
  getView(): WatchPartyView;
  applyView(view: WatchPartyView): void;
  subscribeView(listener: () => void): void;
}

/**
 * Reconcile a host view against the lineup it arrived with: Theater/Focus
 * need their primary stream present, otherwise fall back to grid (e.g. the
 * host removed the primary stream and the lineup + view updates raced).
 */
export function resolveViewForLineup(
  view: WatchPartyView,
  streams: readonly WatchPartyStream[],
): WatchPartyView {
  const withChat = typeof view.chatVisible === 'boolean' ? { chatVisible: view.chatVisible } : {};
  if (view.mode === 'grid') return { mode: 'grid', primary: null, ...withChat };
  if (!view.primary) return { mode: 'grid', primary: null, ...withChat };
  const inLineup = streams.some(
    (stream) => `${stream.platform}:${stream.channel}` === view.primary,
  );
  return inLineup ? view : { mode: 'grid', primary: null, ...withChat };
}

/**
 * Live watch-party session: host pushes lineup changes; viewers poll.
 * Video is never rebroadcast — only the stream list/order is shared.
 */
export function bindWatchParty(
  store: StreamStore,
  viewSync?: WatchPartyViewSync,
): WatchPartyController {
  const listeners = new Set<() => void>();
  let role: WatchPartyRole = 'none';
  let roomId: string | null = watchPartyIdFromPath(window.location.pathname);
  let hostToken: string | null = roomId ? hostRecordForRoom(roomId)?.hostToken ?? null : null;
  let applyingRemote = false;
  let lastFingerprint = lineupFingerprint(streamsToWatchPartyPayload(store.getStreams()));
  let lastViewFingerprint = viewFingerprint(viewSync?.getView());
  let pollTimer = 0;
  let pushTimer = 0;
  let heartbeatTimer = 0;
  let statusText = '';
  // Viewer-side mirror of the session's hostLive flag; null = the server
  // predates host presence, so no hint is shown.
  let hostLive: boolean | null = null;
  // Host-only audience size from heartbeat/update responses; null = the
  // server predates viewer presence, so no count is shown.
  let viewerCount: number | null = null;
  // Viewer presence pings ride the 2s poll at most once per 30s (hb=1 is
  // the only poll variant that writes server-side).
  let lastViewerPingAt = 0;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function setStatus(text: string): void {
    if (text === statusText) return;
    statusText = text;
    notify();
  }

  function applyChrome(): void {
    document.documentElement.classList.toggle('watch-party-host', role === 'host');
    document.documentElement.classList.toggle('watch-party-viewer', role === 'viewer');
  }

  function viewerStatusText(): string {
    if (hostLive === true) return 'Watching a live watch party · Host is live';
    if (hostLive === false) return 'Watching a live watch party · Host away';
    return 'Watching a live watch party — lineup updates automatically';
  }

  function hostStatusText(): string {
    if (viewerCount !== null) return `Live watch party · ${viewerCount} watching`;
    return 'Live watch party — viewers follow your lineup';
  }

  function becomeHost(id: string, token: string): void {
    role = 'host';
    roomId = id;
    hostToken = token;
    hostLive = null;
    viewerCount = null;
    saveHostRecord({ roomId: id, hostToken: token });
    store.setPersistEnabled(true);
    store.setPathLock(watchPartyPath(id));
    stopPolling();
    applyChrome();
    setStatus(hostStatusText());
    startHeartbeat();
  }

  function becomeViewer(id: string): void {
    role = 'viewer';
    roomId = id;
    hostToken = null;
    viewerCount = null;
    lastViewerPingAt = 0;
    stopHeartbeat();
    store.setPersistEnabled(false);
    store.setPathLock(watchPartyPath(id));
    applyChrome();
    setStatus(viewerStatusText());
    startPolling();
  }

  function becomeNone(message: string): void {
    role = 'none';
    roomId = null;
    hostToken = null;
    hostLive = null;
    viewerCount = null;
    stopPolling();
    stopHeartbeat();
    store.setPathLock(null);
    store.setPersistEnabled(true);
    applyChrome();
    setStatus(message);
  }

  /**
   * Host presence: one immediate ping (a returning host's hydrate was a GET
   * that proved nothing) then every 30s — but only while the tab is visible,
   * since "host is live" is meaningless for a backgrounded tab, and skipping
   * hidden pings lets the server's 30-min idle auto-end actually engage for
   * a host who walked away.
   */
  function startHeartbeat(): void {
    stopHeartbeat();
    void sendHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (document.hidden) return;
      void sendHeartbeat();
    }, WATCH_PARTY_HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat(): void {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
  }

  async function sendHeartbeat(): Promise<void> {
    if (role !== 'host' || !roomId || !hostToken) return;
    const result = await heartbeatWatchParty(roomId, hostToken);
    if (result.ok) {
      viewerCount = result.viewerCount;
      setStatus(hostStatusText());
      return;
    }
    if (result.error === 'ended') {
      clearHostRecord();
      becomeNone('Watch party ended');
    } else if (result.error === 'forbidden') {
      clearHostRecord();
      becomeViewer(roomId);
    }
  }

  function applySession(session: WatchPartySession, options?: { applyView?: boolean }): void {
    const nextFingerprint = lineupFingerprint(session.streams);
    if (nextFingerprint !== lastFingerprint) {
      applyingRemote = true;
      lastFingerprint = nextFingerprint;
      store.replaceLineup(session.streams);
      applyingRemote = false;
    }
    if (options?.applyView && viewSync && session.view) {
      applyHostView(session.view, session.streams);
    }
  }

  /**
   * Viewer-side spotlight follow. Applied only when the host's view actually
   * changed (lastViewFingerprint), so a viewer's own local override is not
   * fought on every poll. Theater/Focus don't exist on phones — those
   * viewers stay in the single-column grid (the fingerprint is deliberately
   * left stale so a viewport change to desktop picks the view up on the
   * next poll).
   */
  function applyHostView(view: WatchPartyView, streams: readonly WatchPartyStream[]): void {
    if (!viewSync) return;
    if (typeof window.matchMedia === 'function' && isPhoneViewport()) return;
    const nextViewFingerprint = viewFingerprint(view);
    if (nextViewFingerprint === lastViewFingerprint) return;
    lastViewFingerprint = nextViewFingerprint;
    viewSync.applyView(resolveViewForLineup(view, streams));
  }

  async function pushHostState(): Promise<void> {
    if (role !== 'host' || !roomId || !hostToken || applyingRemote) return;
    const streams = store.getStreams();
    const view = viewSync?.getView() ?? null;
    lastFingerprint = lineupFingerprint(streamsToWatchPartyPayload(streams));
    lastViewFingerprint = viewFingerprint(view);
    const result = await updateWatchParty(roomId, hostToken, streams, view);
    if (result.ok) {
      viewerCount = result.viewerCount;
      setStatus(hostStatusText());
      return;
    }
    if (result.error === 'ended') {
      clearHostRecord();
      becomeNone('Watch party ended');
    } else if (result.error === 'forbidden') {
      clearHostRecord();
      becomeViewer(roomId);
    }
  }

  function schedulePush(): void {
    if (role !== 'host' || applyingRemote) return;
    window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => {
      pushTimer = 0;
      void pushHostState();
    }, 400);
  }

  async function pollOnce(): Promise<void> {
    if (role !== 'viewer' || !roomId) return;
    const now = Date.now();
    const presencePing = now - lastViewerPingAt >= WATCH_PARTY_VIEWER_PING_INTERVAL_MS;
    if (presencePing) lastViewerPingAt = now;
    const result = await fetchWatchParty(roomId, { viewerId: getViewerId(), presencePing });
    if (!result.ok) {
      if (result.error === 'not_found') {
        becomeNone('Watch party not found');
      }
      return;
    }
    if (result.session.status === 'ended') {
      applySession(result.session, { applyView: true });
      becomeNone('This watch party has ended — you can keep watching this lineup');
      return;
    }
    hostLive = result.session.hostLive ?? null;
    applySession(result.session, { applyView: true });
    setStatus(viewerStatusText());
  }

  function startPolling(): void {
    stopPolling();
    pollTimer = window.setInterval(() => {
      void pollOnce();
    }, WATCH_PARTY_POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  async function hydrateFromLocation(): Promise<void> {
    if (!roomId) return;
    const result = await fetchWatchParty(roomId);
    if (!result.ok) {
      becomeNone(result.error === 'not_found' ? 'Watch party not found' : 'Could not load watch party');
      return;
    }
    // A returning host keeps their locally-restored view (their next change
    // re-asserts it to the room); a fresh viewer adopts the host's view.
    applySession(result.session, { applyView: !hostToken });
    if (result.session.status === 'ended') {
      becomeNone('This watch party has ended — you can keep watching this lineup');
      return;
    }
    if (hostToken) {
      becomeHost(roomId, hostToken);
      // Local persistence is the returning host's latest intent. Reconcile
      // the room immediately so viewers do not remain on an older snapshot.
      void pushHostState();
      return;
    }
    hostLive = result.session.hostLive ?? null;
    becomeViewer(roomId);
  }

  store.subscribe(() => {
    if (applyingRemote) return;
    if (role !== 'host') return;
    const fingerprint = lineupFingerprint(streamsToWatchPartyPayload(store.getStreams()));
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    schedulePush();
  });

  viewSync?.subscribeView(() => {
    if (applyingRemote) return;
    if (role !== 'host') return;
    const nextViewFingerprint = viewFingerprint(viewSync.getView());
    if (nextViewFingerprint === lastViewFingerprint) return;
    lastViewFingerprint = nextViewFingerprint;
    schedulePush();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (role === 'viewer') {
      void pollOnce();
    } else if (role === 'host') {
      // Returning to a visible tab re-proves presence immediately rather
      // than waiting out the rest of the 30s interval.
      void sendHeartbeat();
    }
  });

  void hydrateFromLocation();
  applyChrome();

  return {
    getRole(): WatchPartyRole {
      return role;
    },
    getRoomId(): string | null {
      return roomId;
    },
    getViewerUrl(): string | null {
      return roomId ? watchPartyUrl(window.location.origin, roomId) : null;
    },
    getStatusText(): string {
      return statusText;
    },
    async start() {
      if ((role === 'host' || role === 'viewer') && roomId) {
        return { ok: true, url: watchPartyUrl(window.location.origin, roomId) };
      }
      const streams = store.getStreams();
      if (streams.length === 0) {
        return { ok: false, error: 'Add at least one stream first.' };
      }
      const view = viewSync?.getView() ?? null;
      const result = await createWatchParty(streams, view);
      if (!result.ok) {
        const message =
          result.error === 'unreachable'
            ? 'Live watch party needs the API (same as YouTube/Kick status).'
            : result.error === 'rate_limited'
              ? 'Too many watch parties are being created right now — try again shortly.'
              : result.error === 'busy'
                ? 'The watch-party server is full right now — try again later.'
                : 'Could not start a live watch party.';
        setStatus(message);
        return { ok: false, error: message };
      }
      lastFingerprint = lineupFingerprint(streamsToWatchPartyPayload(streams));
      lastViewFingerprint = viewFingerprint(view);
      becomeHost(result.id, result.hostToken);
      return { ok: true, url: watchPartyUrl(window.location.origin, result.id) };
    },
    async end() {
      if (role !== 'host' || !roomId || !hostToken) {
        return { ok: false, error: 'Only the host can end this watch party.' };
      }
      const result = await endWatchParty(roomId, hostToken);
      clearHostRecord();
      if (!result.ok && result.error !== 'ended' && result.error !== 'not_found') {
        return { ok: false, error: 'Could not end the watch party.' };
      }
      becomeNone('Watch party ended');
      return { ok: true };
    },
    applyChrome,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
