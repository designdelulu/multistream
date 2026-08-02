/**
 * Pure "Live for…" formatting from Twitch's `started_at` timestamp. No
 * network calls, no DOM, no clock of its own — callers supply `nowMs` (from
 * a shared minute timer or `Date.now()`) so this stays trivially unit-testable
 * and never needs to poll Twitch just to keep an elapsed label current.
 */
export function formatTwitchLiveDuration(
  startedAt: string | undefined,
  nowMs: number,
): string | null {
  if (!startedAt) return null;

  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;

  const elapsedMs = nowMs - startedMs;
  if (elapsedMs < 0) return null;

  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
