import type { TwitchStatusResult } from '../platforms/twitchStatus';

/**
 * Diagnostics-only tag for why a refresh ran. Never changes behavior or
 * touches player/iframe state — see the module doc below.
 */
export type TwitchStatusRefreshReason =
  | 'initial-restore'
  | 'manual'
  | 'periodic'
  | 'visibility-resume';

export type TwitchStatusRefreshOutcome = 'ok' | 'skipped-inflight' | 'skipped-empty';

export type TwitchStatusRefreshResult =
  | { outcome: 'ok'; results: Map<string, TwitchStatusResult> }
  | { outcome: 'skipped-inflight' | 'skipped-empty' };

/**
 * Coordinates the "refresh every Twitch card's status" flow so only one
 * batched request is ever in flight at a time, regardless of whether it was
 * triggered by the manual button, the periodic scheduler, initial restore, or
 * a visibility-resume check. DOM/store-agnostic and fully injectable so it's
 * unit-testable on its own — matches the injectable-timer style already used
 * by src/lib/playbackRecovery.ts.
 *
 * This coordinator only ever calls the injected `checkStatus` (the existing
 * batched Twitch status client) and the injected `onResult` (DOM pill
 * updates). It has no knowledge of, and no dependency on, players, iframes,
 * or embed lifecycle — nothing here can affect playback.
 */
export function createTwitchStatusCoordinator(deps: {
  checkStatus: (channels: string[]) => Promise<Map<string, TwitchStatusResult>>;
  onResult: (results: Map<string, TwitchStatusResult>, reason: TwitchStatusRefreshReason) => void;
}) {
  let inFlight = false;
  let sequence = 0;
  let lastCheckAt: number | null = null;

  function normalizeChannels(channels: string[]): string[] {
    const seen = new Set<string>();
    for (const raw of channels) {
      const normalized = raw.trim().toLowerCase();
      if (normalized) seen.add(normalized);
    }
    return [...seen];
  }

  async function refresh(
    channels: string[],
    reason: TwitchStatusRefreshReason,
  ): Promise<TwitchStatusRefreshResult> {
    if (inFlight) return { outcome: 'skipped-inflight' };

    const wanted = normalizeChannels(channels);
    if (wanted.length === 0) return { outcome: 'skipped-empty' };

    inFlight = true;
    const mySequence = ++sequence;

    try {
      const results = await deps.checkStatus(wanted);
      // Defense in depth: the `inFlight` gate above already makes concurrent
      // coordinator requests impossible, so this can never actually fire
      // today. Kept anyway so a future relaxation of that gate can't silently
      // let a stale response overwrite a newer one.
      if (mySequence !== sequence) return { outcome: 'skipped-inflight' };
      lastCheckAt = Date.now();
      deps.onResult(results, reason);
      return { outcome: 'ok', results };
    } finally {
      inFlight = false;
    }
  }

  return {
    refresh,
    isInFlight: () => inFlight,
    getLastCheckAt: () => lastCheckAt,
  };
}

export type TwitchStatusCoordinator = ReturnType<typeof createTwitchStatusCoordinator>;
