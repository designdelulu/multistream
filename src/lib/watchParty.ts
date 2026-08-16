import type { Platform, StreamRef } from '../types';

export const WATCH_PARTY_ID_LENGTH = 10;
export const WATCH_PARTY_POLL_INTERVAL_MS = 2000;
export const WATCH_PARTY_ENDPOINT = '/api/watch-party.php';
export const WATCH_PARTY_HOST_STORAGE_KEY = 'multistream:live-party';

const WATCH_PARTY_PATH_RE = /^\/w\/([a-z0-9]{10})\/?$/i;

export type WatchPartyRole = 'none' | 'host' | 'viewer';
export type WatchPartyStatus = 'active' | 'ended';

export interface WatchPartyStream {
  platform: Platform;
  channel: string;
}

export interface WatchPartySession {
  id: string;
  status: WatchPartyStatus;
  streams: WatchPartyStream[];
  updatedAt: number;
  createdAt: number;
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
  return streams.map((stream) => `${stream.platform}:${stream.channel}`).join('|');
}

export function streamsToWatchPartyPayload(
  streams: readonly Pick<StreamRef, 'platform' | 'channel'>[],
): WatchPartyStream[] {
  return streams.map((stream) => ({ platform: stream.platform, channel: stream.channel }));
}

export function isWatchPartyStream(value: unknown): value is WatchPartyStream {
  if (!value || typeof value !== 'object') return false;
  const platform = (value as { platform?: unknown }).platform;
  const channel = (value as { channel?: unknown }).channel;
  return (
    typeof platform === 'string' &&
    PLATFORMS.includes(platform as Platform) &&
    typeof channel === 'string' &&
    channel.length > 0 &&
    channel.length <= 128
  );
}

export function parseWatchPartySession(value: unknown): WatchPartySession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as {
    id?: unknown;
    status?: unknown;
    streams?: unknown;
    updatedAt?: unknown;
    createdAt?: unknown;
  };
  if (typeof record.id !== 'string' || !/^[a-z0-9]{10}$/.test(record.id)) return null;
  if (record.status !== 'active' && record.status !== 'ended') return null;
  if (!Array.isArray(record.streams) || !record.streams.every(isWatchPartyStream)) return null;
  return {
    id: record.id,
    status: record.status,
    streams: record.streams,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
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
  streams: readonly Pick<StreamRef, 'platform' | 'channel'>[],
): Promise<WatchPartyCreateResult | WatchPartyErrorResult> {
  const payload = await postAction({
    action: 'create',
    streams: streamsToWatchPartyPayload(streams),
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
  return { ok: true, id, hostToken, session };
}

export async function fetchWatchParty(roomId: string): Promise<
  { ok: true; session: WatchPartySession } | WatchPartyErrorResult
> {
  let response: Response;
  try {
    response = await fetch(`${WATCH_PARTY_ENDPOINT}?id=${encodeURIComponent(roomId)}`, {
      cache: 'no-store',
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
  streams: readonly Pick<StreamRef, 'platform' | 'channel'>[],
): Promise<{ ok: true; session: WatchPartySession } | WatchPartyErrorResult> {
  const payload = await postAction({
    action: 'update',
    id: roomId,
    hostToken,
    streams: streamsToWatchPartyPayload(streams),
  });
  if (!payload.ok) {
    return { ok: false, error: typeof payload.error === 'string' ? payload.error : 'forbidden' };
  }
  const session = parseWatchPartySession(payload.session);
  if (!session) return { ok: false, error: 'invalid_input' };
  return { ok: true, session };
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
