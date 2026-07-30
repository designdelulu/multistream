/**
 * Opt-in debug logging. Enable with ?debug=embeds, ?debug=stats, a comma list
 * (?debug=embeds,stats), or ?debug=all — persists for the tab session via
 * sessionStorage, because stream URL sync strips query params. Disable with
 * ?debug=off.
 *
 * No playback behavior — console diagnostics only.
 */

const SESSION_KEY = 'multistream:debug-flags';
const KNOWN_FLAGS = ['embeds', 'stats'] as const;
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

    if (debug) {
      const requested = debug === 'all' ? [...KNOWN_FLAGS] : debug.split(',');
      const valid = requested.filter(isDebugFlag);
      if (valid.length > 0) {
        sessionStorage.setItem(SESSION_KEY, valid.join(','));
        return new Set(valid);
      }
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
  | 'player-recover';

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
}
