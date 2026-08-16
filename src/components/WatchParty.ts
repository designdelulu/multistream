import {
  WATCH_PARTY_POLL_INTERVAL_MS,
  clearHostRecord,
  createWatchParty,
  endWatchParty,
  fetchWatchParty,
  hostRecordForRoom,
  lineupFingerprint,
  saveHostRecord,
  streamsToWatchPartyPayload,
  updateWatchParty,
  watchPartyIdFromPath,
  watchPartyPath,
  watchPartyUrl,
  type WatchPartyRole,
  type WatchPartySession,
} from '../lib/watchParty';
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
 * Live watch-party session: host pushes lineup changes; viewers poll.
 * Video is never rebroadcast — only the stream list/order is shared.
 */
export function bindWatchParty(store: StreamStore): WatchPartyController {
  const listeners = new Set<() => void>();
  let role: WatchPartyRole = 'none';
  let roomId: string | null = watchPartyIdFromPath(window.location.pathname);
  let hostToken: string | null = roomId ? hostRecordForRoom(roomId)?.hostToken ?? null : null;
  let applyingRemote = false;
  let lastFingerprint = lineupFingerprint(streamsToWatchPartyPayload(store.getStreams()));
  let pollTimer = 0;
  let pushTimer = 0;
  let statusText = '';

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function setStatus(text: string): void {
    statusText = text;
    notify();
  }

  function applyChrome(): void {
    document.documentElement.classList.toggle('watch-party-host', role === 'host');
    document.documentElement.classList.toggle('watch-party-viewer', role === 'viewer');
  }

  function becomeHost(id: string, token: string): void {
    role = 'host';
    roomId = id;
    hostToken = token;
    saveHostRecord({ roomId: id, hostToken: token });
    store.setPersistEnabled(true);
    store.setPathLock(watchPartyPath(id));
    stopPolling();
    applyChrome();
    setStatus('Live watch party — viewers follow your lineup');
  }

  function becomeViewer(id: string): void {
    role = 'viewer';
    roomId = id;
    hostToken = null;
    store.setPersistEnabled(false);
    store.setPathLock(watchPartyPath(id));
    applyChrome();
    setStatus('Watching a live watch party — lineup updates automatically');
    startPolling();
  }

  function becomeNone(message: string): void {
    role = 'none';
    roomId = null;
    hostToken = null;
    stopPolling();
    store.setPathLock(null);
    store.setPersistEnabled(true);
    applyChrome();
    setStatus(message);
  }

  function applySession(session: WatchPartySession): void {
    const nextFingerprint = lineupFingerprint(session.streams);
    if (nextFingerprint === lastFingerprint) return;
    applyingRemote = true;
    lastFingerprint = nextFingerprint;
    store.replaceLineup(session.streams);
    applyingRemote = false;
  }

  async function pushHostState(): Promise<void> {
    if (role !== 'host' || !roomId || !hostToken || applyingRemote) return;
    const streams = store.getStreams();
    const fingerprint = lineupFingerprint(streamsToWatchPartyPayload(streams));
    lastFingerprint = fingerprint;
    const result = await updateWatchParty(roomId, hostToken, streams);
    if (!result.ok && result.error === 'ended') {
      clearHostRecord();
      becomeNone('Watch party ended');
    } else if (!result.ok && result.error === 'forbidden') {
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
    const result = await fetchWatchParty(roomId);
    if (!result.ok) {
      if (result.error === 'not_found') {
        becomeNone('Watch party not found');
      }
      return;
    }
    if (result.session.status === 'ended') {
      applySession(result.session);
      becomeNone('This watch party has ended — you can keep watching this lineup');
      return;
    }
    applySession(result.session);
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
    applySession(result.session);
    if (result.session.status === 'ended') {
      becomeNone('This watch party has ended — you can keep watching this lineup');
      return;
    }
    if (hostToken) {
      becomeHost(roomId, hostToken);
      return;
    }
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

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && role === 'viewer') {
      void pollOnce();
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
      const streams = store.getStreams();
      if (streams.length === 0) {
        return { ok: false, error: 'Add at least one stream first.' };
      }
      const result = await createWatchParty(streams);
      if (!result.ok) {
        const message =
          result.error === 'unreachable'
            ? 'Live watch party needs the API (same as YouTube/Kick status).'
            : 'Could not start a live watch party.';
        setStatus(message);
        return { ok: false, error: message };
      }
      lastFingerprint = lineupFingerprint(streamsToWatchPartyPayload(streams));
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
