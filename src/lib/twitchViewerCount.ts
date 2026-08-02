/** Compact "12.4K viewers" formatting for a live channel's viewer count. */
export function formatTwitchViewerCount(count: number | undefined): string | null {
  if (count === undefined || !Number.isFinite(count) || count < 0) return null;

  const rounded = Math.floor(count);
  const label = rounded === 1 ? 'viewer' : 'viewers';

  if (rounded < 1000) return `${rounded} ${label}`;
  if (rounded < 1_000_000) return `${trimDecimal(rounded / 1000)}K ${label}`;
  return `${trimDecimal(rounded / 1_000_000)}M ${label}`;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
