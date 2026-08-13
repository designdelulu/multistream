/**
 * Opt-in debug logging. Enable with ?debug=embeds, ?debug=stats,
 * ?debug=players, a comma list (?debug=embeds,players), or ?debug=all —
 * persists for the tab session via sessionStorage, because stream URL sync
 * strips query params. Disable with ?debug=off.
 *
 * ?debugPlayers=1 is an alias for ?debug=players, kept because it is the
 * spelling the add/remove recovery work is documented under.
 *
 * ?debug=twitch-fast-poll shortens the Twitch status polling interval for
 * manual testing — see twitchStatusFastPollEnabled below for why this one is
 * also gated behind import.meta.env.DEV, unlike the others.
 *
 * No playback behavior — console diagnostics only.
 */

const SESSION_KEY = 'multistream:debug-flags';
const KNOWN_FLAGS = ['embeds', 'stats', 'players', 'twitch-fast-poll'] as const;
type DebugFlag = (typeof KNOWN_FLAGS)[number];

function isDebugFlag(value: string): value is DebugFlag {
  return (KNOWN_FLAGS as readonly string[]).includes(value);
}

function readFlags(): Set<DebugFlag> {
  try {
    const params = new URLSearchParams(window.location.search);
    const debug = params.get('debug');

    if (debug === '0' || debug === 'off') {
      sessionStorage.removeItem(SESSION_KEY);
      return new Set();
    }

    const requested: string[] = [];
    if (debug) {
      requested.push(...(debug === 'all' ? [...KNOWN_FLAGS] : debug.split(',')));
    }
    if (params.get('debugPlayers') === '1') {
      requested.push('players');
    }

    const valid = requested.filter(isDebugFlag);
    if (valid.length > 0) {
      const merged = [...new Set(valid)];
      sessionStorage.setItem(SESSION_KEY, merged.join(','));
      return new Set(merged);
    }

    const stored = sessionStorage.getItem(SESSION_KEY) ?? '';
    return new Set(stored.split(',').filter(isDebugFlag));
  } catch {
    return new Set();
  }
}

const enabledDebugFlags = readFlags();

export type EmbedDebugReason =
  | 'mount'
  | 'mount-forced'
  | 'tab-freeze'
  | 'tab-resume'
  | 'focus-freeze'
  | 'focus-resume'
  | 'focus-unmute'
  | 'headers-recover'
  | 'watchdog'
  | 'visibility'
  | 'script-fallback'
  | 'player-ready'
  | 'player-blocked'
  | 'player-offline'
  | 'player-online'
  | 'player-recover'
  | 'tiktok-mounted'
  | 'tiktok-not-live'
  | 'tiktok-resolve-error'
  | 'tiktok-player-error';

type EmbedDebugDetail = {
  platform?: string;
  channel?: string;
  action?: 'blank' | 'src' | 'skip-same-url';
  muted?: boolean;
  card?: HTMLElement;
};

const counts: Record<string, number> = Object.create(null) as Record<string, number>;

export const embedDebugEnabled = enabledDebugFlags.has('embeds');
export const statsDebugEnabled = enabledDebugFlags.has('stats');
export const playersDebugEnabled = enabledDebugFlags.has('players');

/**
 * Dev-only accelerated Twitch status poll interval, for manually compressing
 * "10 automatic cycles" of testing into a short session. Gated on
 * import.meta.env.DEV in addition to the ?debug flag so the accelerated
 * cadence is unreachable in the production build regardless of query string
 * — never shipped, per the task's explicit requirement.
 */
export const twitchStatusFastPollEnabled =
  import.meta.env.DEV && enabledDebugFlags.has('twitch-fast-poll');

/**
 * Player-lifecycle trace for the add/remove recovery path (?debugPlayers=1).
 * Separate from ?debug=embeds because that one logs iframe src churn, while
 * this one follows Twitch.Player instances: which ids exist, what the
 * pre-mutation snapshot was, when layout settled, and every check / play() /
 * event / retry outcome in between. Console only, never touches playback.
 */
export function logPlayerEvent(event: string, detail: Record<string, unknown> = {}): void {
  if (!playersDebugEnabled) return;
  console.info('[players-debug]', {
    t: Math.round(performance.now()),
    event,
    ...detail,
  });
}

function iframeSize(card: HTMLElement | undefined): string | undefined {
  if (!card) return undefined;
  const iframe = card.querySelector('.stream-card__iframe');
  if (!(iframe instanceof HTMLElement)) return undefined;
  const rect = iframe.getBoundingClientRect();
  return `${Math.round(rect.width)}×${Math.round(rect.height)}`;
}

export function logEmbedEvent(reason: EmbedDebugReason, detail: EmbedDebugDetail = {}): void {
  if (!embedDebugEnabled) return;

  counts[reason] = (counts[reason] ?? 0) + 1;

  const { card, ...rest } = detail;
  console.info('[embed-debug]', {
    t: Math.round(performance.now()),
    reason,
    n: counts[reason],
    hidden: document.hidden,
    size: iframeSize(card),
    ...rest,
    totals: { ...counts },
  });
}

export type StatsSample = {
  streamId: string;
  channel?: string;
  isPaused: boolean | 'error';
  currentTime: number | 'error';
  stats: unknown;
  size?: string;
};

/**
 * Read-only diagnostic probe, gated behind ?debug=stats. Purpose: capture
 * what a genuinely stuck Twitch player's signals actually look like, before
 * writing a stuck-detector — see the plan's Phase C2/D reasoning. Never
 * touches playback.
 */
export function logStatsSample(sample: StatsSample): void {
  if (!statsDebugEnabled) return;
  console.info('[stats-debug]', {
    t: Math.round(performance.now()),
    hidden: document.hidden,
    ...sample,
  });
}

export type EmbedRecoveryAction =
  | 'script-fallback'
  | 'playback-blocked'
  | 'player-recover'
  | 'forced-remount'
  | 'tab-freeze';

/**
 * Always-on (not gated by ?debug=embeds) — a curated subset of recovery
 * events sent to GA4 (already loaded in index.html) so stall frequency is
 * measurable instead of guessed at. Never throws; telemetry must not be able
 * to affect playback.
 */
export function reportEmbedRecovery(
  action: EmbedRecoveryAction,
  detail: { platform?: string; reason?: string } = {},
): void {
  try {
    window.gtag?.('event', 'embed_recovery', {
      recovery_action: action,
      platform: detail.platform,
      reason: detail.reason,
    });
  } catch {
    // Never let telemetry break playback.
  }
}

export function announceEmbedDebug(): void {
  if (embedDebugEnabled) {
    console.info(
      '[embed-debug] enabled — remounts will log here. Disable with ?debug=off. Totals: window.__multistreamEmbedDebug',
    );
    try {
      (window as Window & { __multistreamEmbedDebug?: unknown }).__multistreamEmbedDebug = {
        counts,
        enabled: true,
      };
    } catch {
      // Ignore.
    }
  }

  if (statsDebugEnabled) {
    console.info(
      '[stats-debug] enabled — samples every ~5s for api-mode Twitch cards. Disable with ?debug=off.',
    );
  }

  if (playersDebugEnabled) {
    console.info(
      '[players-debug] enabled — Twitch player lifecycle and add/remove recovery. Disable with ?debug=off.',
    );
  }

  if (twitchStatusFastPollEnabled) {
    console.info(
      '[twitch-status-debug] fast-poll enabled (dev build only) — status polling interval shortened. Disable with ?debug=off.',
    );
  }
}
