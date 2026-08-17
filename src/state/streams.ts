import { watchPartyIdFromPath, watchPartyPath } from '../lib/watchParty';
import {
  buildPathFromStreams,
  parseStreamInput,
  streamsFromPathname,
  streamsFromSearch,
} from '../platforms';
import type { Platform, StreamOrientation, StreamRef } from '../types';

type Listener = () => void;

const STORAGE_KEY = 'multistream:streams';

function createId(platform: string, channel: string): string {
  return `${platform}:${channel}`;
}

/**
 * A stream as carried by restore/sync paths (localStorage, live-party
 * payloads): everything but the derived fields, plus an optional
 * orientation. URL path/query shares are the deliberate exception — they
 * stay platform+channel only, so a shared static link still falls back to
 * the platform-derived default.
 */
type RestoredStream = Omit<StreamRef, 'id' | 'muted' | 'orientation'> & {
  orientation?: StreamOrientation;
};

/**
 * localStorage and live-party payloads DO carry orientation (persistStreams
 * writes it; watch-party.php validates it), so a YouTube Shorts link's
 * portrait hint now survives reload and party sync — that used to be a
 * documented loss (only a fresh addStream() in the current session had the
 * raw input to detect it from). TikTok never needs the hint: every TikTok
 * stream is LIVE and LIVE is always portrait, so the platform rule wins
 * over anything stored.
 */
function toStreamRefs(items: RestoredStream[]): StreamRef[] {
  return items.map((item) => ({
    ...item,
    id: createId(item.platform, item.channel),
    muted: true,
    orientation:
      item.platform === 'tiktok'
        ? 'portrait'
        : item.orientation === 'portrait'
          ? 'portrait'
          : 'landscape',
  }));
}

/** youtube.com/shorts/... and youtu.be-shorts links are always 9:16 by convention. */
const YOUTUBE_SHORTS_RE = /youtube\.com\/shorts\//i;

function detectOrientation(platform: Platform, rawInput: string): StreamRef['orientation'] {
  if (platform === 'tiktok') return 'portrait'; // TikTok LIVE is always portrait.
  return YOUTUBE_SHORTS_RE.test(rawInput) ? 'portrait' : 'landscape';
}

function loadFromStorage(): RestoredStream[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RestoredStream[] = [];
    for (const item of parsed as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const platform = (item as { platform?: unknown }).platform;
      const channel = (item as { channel?: unknown }).channel;
      if (
        platform !== 'twitch' &&
        platform !== 'kick' &&
        platform !== 'youtube' &&
        platform !== 'tiktok'
      ) {
        continue;
      }
      if (typeof channel !== 'string') continue;
      // Orientation persisted by an older/newer build: unknown values are
      // dropped to the platform-derived default rather than trusted.
      const orientation = (item as { orientation?: unknown }).orientation;
      out.push({
        platform,
        channel,
        ...(orientation === 'portrait' || orientation === 'landscape' ? { orientation } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function persistStreams(streams: StreamRef[], enabled: boolean): void {
  if (!enabled) return;
  try {
    if (streams.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(streams.map(({ platform, channel, orientation }) => ({ platform, channel, orientation }))),
    );
  } catch {
    // Ignore storage failures.
  }
}

function loadInitialStreams(): StreamRef[] {
  // /w/ROOM is a live session, not a static lineup. Don't restore
  // localStorage over it — the party client hydrates from the API.
  if (watchPartyIdFromPath(window.location.pathname)) return [];
  const fromUrl = loadFromUrl();
  if (fromUrl.length > 0) return fromUrl;
  return toStreamRefs(loadFromStorage());
}

function loadFromUrl(): StreamRef[] {
  const fromPath = toStreamRefs(streamsFromPathname(window.location.pathname));
  if (fromPath.length > 0) return fromPath;

  return toStreamRefs(streamsFromSearch(window.location.search));
}

/**
 * Classify a store update from the previous id list to the next.
 * Reorder is a real grid mutation (cards move, Twitch can pause) and must
 * not be collapsed into "nothing changed" just because the id *set* is the
 * same — see main.ts renderStreams / beginAddRemoveRecovery.
 */
export function detectStreamListChange(
  previous: readonly string[],
  next: readonly string[],
): 'add' | 'remove' | 'reorder' | null {
  const previousSet = new Set(previous);
  const added = next.filter((id) => !previousSet.has(id)).length;
  const nextSet = new Set(next);
  const removed = previous.filter((id) => !nextSet.has(id)).length;

  if (added > 0 || removed > 0) return added >= removed ? 'add' : 'remove';
  if (previous.some((id, index) => id !== next[index])) return 'reorder';
  return null;
}

function dedupeStreams(streams: StreamRef[]): StreamRef[] {
  const seen = new Set<string>();
  return streams.filter((stream) => {
    if (seen.has(stream.id)) return false;
    seen.add(stream.id);
    return true;
  });
}

function syncUrl(streams: StreamRef[], pathLock: string | null): void {
  const next = pathLock ?? buildPathFromStreams(streams);
  window.history.replaceState(null, '', next);
}

export function createStreamStore() {
  const initialPartyId = watchPartyIdFromPath(window.location.pathname);
  let pathLock = initialPartyId ? watchPartyPath(initialPartyId) : null;
  // Viewers joining /w/ROOM must not overwrite the host's saved lineup.
  // Hosts re-enable persist after proving they hold the room token.
  let persistEnabled = initialPartyId === null;
  let streams = dedupeStreams(loadInitialStreams());
  const listeners = new Set<Listener>();

  syncUrl(streams, pathLock);
  persistStreams(streams, persistEnabled);

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function setStreams(next: StreamRef[]): void {
    streams = dedupeStreams(next);
    syncUrl(streams, pathLock);
    persistStreams(streams, persistEnabled);
    notify();
  }

  return {
    getStreams(): StreamRef[] {
      return streams;
    },

    addStream(input: string): boolean {
      const parsed = parseStreamInput(input);
      if (!parsed) return false;

      const id = createId(parsed.platform, parsed.channel);
      if (streams.some((stream) => stream.id === id)) {
        return false;
      }

      const nextStream: StreamRef = {
        ...parsed,
        id,
        muted: true,
        orientation: detectOrientation(parsed.platform, input),
      };
      // Portrait insertion only: a newly added 9:16 stream starts at index 0
      // so landscape cards dense-pack around it. After that, store/reorder
      // order is the sole placement source — no CSS order:-1, no re-sort.
      setStreams(
        nextStream.orientation === 'portrait' ? [nextStream, ...streams] : [...streams, nextStream],
      );
      return true;
    },

    removeStream(id: string): void {
      setStreams(streams.filter((stream) => stream.id !== id));
    },

    /**
     * Undo for removeStream: re-adds an already-known StreamRef (not a raw
     * URL/username) at its previous approximate index, clamped to the
     * current length in case other streams were added/removed meanwhile.
     * This is "recreate the stream normally" (a fresh player mounts for it
     * the same way any other stream addition mounts one) — it just skips
     * parseStreamInput/detectOrientation since the caller already has the
     * exact StreamRef that was removed, not a raw string to reparse.
     */
    insertStream(stream: StreamRef, index: number): void {
      if (streams.some((existing) => existing.id === stream.id)) return;
      const next = streams.slice();
      const clampedIndex = Math.max(0, Math.min(index, next.length));
      next.splice(clampedIndex, 0, stream);
      setStreams(next);
    },

    clearStreams(): void {
      setStreams([]);
    },

    reorderStreams(ids: string[]): void {
      const byId = new Map(streams.map((stream) => [stream.id, stream]));
      const next: StreamRef[] = [];
      for (const id of ids) {
        const stream = byId.get(id);
        if (stream) {
          next.push(stream);
          byId.delete(id);
        }
      }
      for (const stream of byId.values()) {
        next.push(stream);
      }
      setStreams(next);
    },

    /**
     * Replace the whole lineup from a live-party snapshot. Same restore
     * rules as a URL/localStorage load (TikTok stays portrait; the party
     * payload carries per-stream orientation, so a host's YouTube Shorts
     * arrive portrait for viewers too — see toStreamRefs).
     */
    replaceLineup(items: RestoredStream[]): void {
      setStreams(toStreamRefs(items));
    },

    /** Keep `/w/ROOM` in the address bar while a live party is active. */
    setPathLock(path: string | null): void {
      pathLock = path;
      syncUrl(streams, pathLock);
    },

    getPathLock(): string | null {
      return pathLock;
    },

    setPersistEnabled(enabled: boolean): void {
      persistEnabled = enabled;
      persistStreams(streams, persistEnabled);
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type StreamStore = ReturnType<typeof createStreamStore>;
