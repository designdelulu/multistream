/**
 * Opt-in embed remount logger. Enable with ?debug=embeds (persists for the
 * tab session via sessionStorage, because stream URL sync strips query params).
 * Disable with ?debug=off.
 *
 * No playback behavior — console diagnostics only.
 */

const SESSION_KEY = 'multistream:debug-embeds';

export type EmbedDebugReason =
  | 'mount'
  | 'mount-forced'
  | 'tab-freeze'
  | 'tab-resume'
  | 'focus-freeze'
  | 'focus-resume'
  | 'focus-unmute'
  | 'headers-recover'
  | 'visibility';

type EmbedDebugDetail = {
  platform?: string;
  channel?: string;
  action?: 'blank' | 'src' | 'skip-same-url';
  muted?: boolean;
  card?: HTMLElement;
};

const counts: Record<string, number> = Object.create(null) as Record<string, number>;

function readFlag(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const debug = params.get('debug');
    if (debug === 'embeds') {
      sessionStorage.setItem(SESSION_KEY, '1');
      return true;
    }
    if (debug === '0' || debug === 'off') {
      sessionStorage.removeItem(SESSION_KEY);
      return false;
    }
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export const embedDebugEnabled = readFlag();

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

export function announceEmbedDebug(): void {
  if (!embedDebugEnabled) return;
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
