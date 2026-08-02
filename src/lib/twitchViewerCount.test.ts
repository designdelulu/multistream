import { describe, expect, it } from 'vitest';
import { formatTwitchViewerCount } from './twitchViewerCount';

describe('formatTwitchViewerCount', () => {
  it('formats a single viewer', () => {
    expect(formatTwitchViewerCount(1)).toBe('1 viewer');
  });

  it('formats sub-1000 counts exactly', () => {
    expect(formatTwitchViewerCount(0)).toBe('0 viewers');
    expect(formatTwitchViewerCount(999)).toBe('999 viewers');
  });

  it('formats thousands with one decimal, trimmed when whole', () => {
    expect(formatTwitchViewerCount(1000)).toBe('1K viewers');
    expect(formatTwitchViewerCount(12432)).toBe('12.4K viewers');
  });

  it('formats millions with one decimal, trimmed when whole', () => {
    expect(formatTwitchViewerCount(1_000_000)).toBe('1M viewers');
    expect(formatTwitchViewerCount(2_340_000)).toBe('2.3M viewers');
  });

  it('returns null for missing or invalid input', () => {
    expect(formatTwitchViewerCount(undefined)).toBeNull();
    expect(formatTwitchViewerCount(Number.NaN)).toBeNull();
    expect(formatTwitchViewerCount(-5)).toBeNull();
  });
});
