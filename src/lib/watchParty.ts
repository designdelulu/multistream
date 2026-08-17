import type { Platform, StreamOrientation, StreamRef } from '../types';

export const WATCH_PARTY_ID_LENGTH = 10;
export const WATCH_PARTY_POLL_INTERVAL_MS = 2000;
export const WATCH_PARTY_HEARTBEAT_INTERVAL_MS = 30_000;
export const WATCH_PARTY_ENDPOINT = '/api/watch-party.php';
export const WATCH_PARTY_HOST_STORAGE_KEY = 'multistream:live-party';
export const WATCH_PARTY_VIEWER_STORAGE_KEY = 'multistream:viewer-id';
/** Viewer presence pings ride the 2s poll at most this often (hb=1 writes server-side). */
export const WATCH_PARTY_VIEWER_PING_INTERVAL_MS = 30_000;

const WATCH_PARTY_PATH_RE = /^\/w\/([a-z0-9]{10})\/?$/i;

export type WatchPartyRole = 'none' | 'host' | 'viewer';
export type WatchPartyStatus = 'active' | 'ended';

export interface WatchPartyStream {
  platform: Platform;
  channel: string;
  /**
   * Optional for backward compatibility with pre-orientation room files and
   * static shares: absent means the viewer derives it from the platform
   * (TikTok portrait, everything else landscape) — see toStreamRefs in
   * state/streams.ts. Present means the host's actual orientation (so a
   * Shorts link stays portrait for every viewer).
   */
  orientation?: StreamOrientation;
}

export type WatchPartyViewMode = 'grid' | 'theater' | 'focus';

/**
 * Host spotlight: which view mode the host is in and which stream (the
 * existing "platform:channel" stream id) is primary. `primary` is null in
 * grid. Optional on the session for backward compatibility with pre-view
 * room files; absent means viewers keep their local view.
 */
export interface WatchPartyView {
  mode: WatchPartyViewMode;
  primary: string | null;
  /** Optional for rooms created before chat visibility was synchronized. */
  chatVisible?: boolean;
}

export interface WatchPartySession {
  id: string;
  status: WatchPartyStatus;
  streams: WatchPartyStream[];
  updatedAt: number;
  createdAt: number;
  view?: WatchPartyView;
  /**
   * Whether the host's tab has heartbeat within the server's live window
   * (~2 min). Optional for backward compatibility with pre-presence servers
   * that never sent it; absent means "unknown", and the UI shows no
   * host-presence hint at all.
   */
  hostLive?: boolean;
}

export interface WatchPartyHostRecord {
  roomId: string;
  hostToken: string;
}

export interface WatchPartyCreateResult {
  ok: true;
  id: string;
  hostToken: string;
  session: WatchPartySession;
  viewerCount: number | null;
}

export interface WatchPartyErrorResult {
  ok: false;
  error: string;
}

const PLATFORMS: Platform[] = ['twitch', 'kick', 'youtube', 'tiktok'];

export function watchPartyIdFromPath(pathname: string): string | null {
  const match = pathname.match(WATCH_PARTY_PATH_RE);
  return match ? match[1].toLowerCase() : null;
}

export function watchPartyPath(roomId: string): string {
  return `/w/${roomId}`;
}

export function watchPartyUrl(origin: string, roomId: string): string {
  return `${origin}${watchPartyPath(roomId)}`;
}

export function lineupFingerprint(streams: readonly WatchPartyStream[]): string {
  return streams
    .map((stream) => `${stream.platform}:${stream.channel}:${stream.orientation ?? ''}`)
    .join('|');
}

/**
 * Fingerprint for the host spotlight alone, so a view-only change (no lineup
 * change) still triggers a host push and a viewer re-apply. null/absent view
 * fingerprints to the empty string.
 */
export function viewFingerprint(view: WatchPartyView | null | undefined): string {
  if (!view) return '';
  const chat = typeof view.chatVisible === 'boolean' ? (view.chatVisible ? '1' : '0') : '';
  return `${view.mode}:${view.primary ?? ''}:${chat}`;
}

export function streamsToWatchPartyPayload(
  streams: readonly (Pick<StreamRef, 'platform' | 'channel'> & {
    orientation?: StreamOrientation;
  })[],
): WatchPartyStream[] {
  return streams.map((stream) => ({
    platform: stream.platform,
    channel: stream.channel,
    ...(stream.orientation ? { orientation: stream.orientation } : {}),
  }));
}

export function isWatchPartyStream(value: unknown): value is WatchPartyStream {
  if (!value || typeof value !== 'object') return false;
  const platform = (value as { platform?: unknown }).platform;
  const channel = (value as { channel?: unknown }).channel;
  const orientation = (value as { orientation?: unknown }).orientation;
  return (
    typeof platform === 'string' &&
    PLATFORMS.includes(platform as Platform) &&
    typeof channel === 'string' &&
    channel.length > 0 &&
    channel.length <= 128 &&
    (orientation === undefined || orientation === 'landscape' || orientation === 'portrait')
  );
}

export function isWatchPartyView(value: unknown): value is WatchPartyView {
  if (!value || typeof value !== 'object') return false;
  const record = value as { mode?: unknown; primary?: unknown };
  if (record.mode !== 'grid' && record.mode !== 'theater' && record.mode !== 'focus') return false;
  if (record.primary !== null && typeof record.primary !== 'string') return false;
  const chatVisible = (record as { chatVisible?: unknown }).chatVisible;
  return chatVisible === undefined || typeof chatVisible === 'boolean';
}

export function parseWatchPartySession(value: unknown): WatchPartySession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as {
    id?: unknown;
    status?: unknown;
    streams?: unknown;
    updatedAt?: unknown;
    createdAt?: unknown;
    view?: unknown;
  };
  if (typeof record.id !== 'string' || !/^[a-z0-9]{10}$/.test(record.id)) return null;
  if (record.status !== 'active' && record.status !== 'ended') return null;
  if (!Array.isArray(record.streams) || !record.streams.every(isWatchPartyStream)) return null;
  // A present-but-malformed view would be worse than none (viewers could
  // apply a bogus primary), so reject the session outright.
  if (record.view !== undefined && !isWatchPartyView(record.view)) return null;
  return {
    id: record.id,
    status: record.status,
    streams: record.streams,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    ...(record.view !== undefined ? { view: record.view as WatchPartyView } : {}),
    ...(typeof (record as { hostLive?: unknown }).hostLive === 'boolean'
      ? { hostLive: (record as { hostLive: boolean }).hostLive }
      : {}),
  };
}

export function loadHostRecord(): WatchPartyHostRecord | null {
  try {
    const raw = localStorage.getItem(WATCH_PARTY_HOST_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const roomId = (parsed as { roomId?: unknown }).roomId;
    const hostToken = (parsed as { hostToken?: unknown }).hostToken;
    if (typeof roomId !== 'string' || typeof hostToken !== 'string') return null;
    if (!/^[a-z0-9]{10}$/.test(roomId) || hostToken.length < 32) return null;
    return { roomId, hostToken };
  } catch {
    return null;
  }
}

export function saveHostRecord(record: WatchPartyHostRecord): void {
  try {
    localStorage.setItem(WATCH_PARTY_HOST_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Ignore storage failures.
  }
}

export function clearHostRecord(): void {
  try {
    localStorage.removeItem(WATCH_PARTY_HOST_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function hostRecordForRoom(roomId: string): WatchPartyHostRecord | null {
  const stored = loadHostRecord();
  return stored && stored.roomId === roomId ? stored : null;
}

/**
 * Opaque per-browser viewer id, generated once and reused forever. It exists
 * only so the host can see an audience size — it identifies nobody, is never
 * sent to any platform, and never leaves the watch-party endpoint.
 */
export function getViewerId(): string {
  try {
    const existing = localStorage.getItem(WATCH_PARTY_VIEWER_STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9-]{8,64}$/.test(existing)) return existing;
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Array.from({ length: 16 }, () =>
            Math.floor(Math.random() * 16).toString(16),
          ).join('');
    localStorage.setItem(WATCH_PARTY_VIEWER_STORAGE_KEY, id);
    return id;
  } catch {
    // Storage blocked: fall back to an ephemeral id for this page load so
    // presence still works (the host's count just sees a new id next load).
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }
}

async function postAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(WATCH_PARTY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'unreachable' };
  }
  return payload as Record<string, unknown>;
}

export async function createWatchParty(
  streams: readonly (Pick<StreamRef, 'platform' | 'channel'> & { orientation?: StreamOrientation })[],
  view?: WatchPartyView | null,
): Promise<WatchPartyCreateResult | WatchPartyErrorResult> {
  const payload = await postAction({
    action: 'create',
    streams: streamsToWatchPartyPayload(streams),
    ...(view ? { view } : {}),
  });
  if (!payload.ok) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : 'unreachable' };
  }
  const session = parseWatchPartySession(payload.session);
  const id = typeof payload.id === 'string' ? payload.id : session?.id;
  const hostToken = typeof payload.hostToken === 'string' ? payload.hostToken : '';
  if (!session || !id || !hostToken) {
    return { ok: false, error: 'invalid_input' };
  }
  return {
    ok: true,
    id,
    hostToken,
    session,
    viewerCount: typeof payload.viewerCount === 'number' ? payload.viewerCount : null,
  };
}

export async function fetchWatchParty(
  roomId: string,
  options?: { viewerId?: string; presencePing?: boolean },
): Promise<{ ok: true; session: WatchPartySession } | WatchPartyErrorResult> {
  let url = `${WATCH_PARTY_ENDPOINT}?id=${encodeURIComponent(roomId)}`;
  if (options?.viewerId && options.presencePing) {
    url += `&vid=${encodeURIComponent(options.viewerId)}&hb=1`;
  }
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) {
    const error =
      payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : 'not_found';
    return { ok: false, error };
  }
  const session = parseWatchPartySession((payload as { session?: unknown }).session);
  if (!session) return { ok: false, error: 'not_found' };
  return { ok: true, session };
}

export async function updateWatchParty(
  roomId: string,
  hostToken: string,
  streams: readonly (Pick<StreamRef, 'platform' | 'channel'> & { orientation?: StreamOrientation })[],
  view?: WatchPartyView | null,
): Promise<{ ok: true; session: WatchPartySession; viewerCount: number | null } | WatchPartyErrorResult> {
  const payload = await postAction({
    action: 'update',
    id: roomId,
    hostToken,
    streams: streamsToWatchPartyPayload(streams),
    ...(view ? { view } : {}),
  });
  if (!payload.ok) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : 'forbidden' };
  }
  const session = parseWatchPartySession(payload.session);
  if (!session) return { ok: false, error: 'invalid_input' };
  return {
    ok: true,
    session,
    viewerCount: typeof payload.viewerCount === 'number' ? payload.viewerCount : null,
  };
}

/**
 * Host presence ping (no lineup/view payload). The host client sends this
 * on an interval while its tab is visible; the server stamps hostSeenAt,
 * which drives both the viewers' "Host is live/away" line and the idle
 * auto-end. viewerCount is returned here (host-authorized) rather than in
 * the public GET — see WatchParty.ts.
 */
export async function heartbeatWatchParty(
  roomId: string,
  hostToken: string,
): Promise<{ ok: true; viewerCount: number | null } | WatchPartyErrorResult> {
  const payload = await postAction({
    action: 'heartbeat',
    id: roomId,
    hostToken,
  });
  if (!payload.ok) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : 'forbidden' };
  }
  return {
    ok: true,
    viewerCount: typeof payload.viewerCount === 'number' ? payload.viewerCount : null,
  };
}

export async function endWatchParty(
  roomId: string,
  hostToken: string,
): Promise<{ ok: true; session: WatchPartySession } | WatchPartyErrorResult> {
  const payload = await postAction({
    action: 'end',
    id: roomId,
    hostToken,
  });
  if (!payload.ok) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : 'forbidden' };
  }
  const session = parseWatchPartySession(payload.session);
  if (!session) return { ok: false, error: 'invalid_input' };
  return { ok: true, session };
}
