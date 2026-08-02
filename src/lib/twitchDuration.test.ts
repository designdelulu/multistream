import { describe, expect, it } from 'vitest';
import { formatTwitchLiveDuration } from './twitchDuration';

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

describe('formatTwitchLiveDuration', () => {
  it('formats under an hour as minutes only', () => {
    expect(formatTwitchLiveDuration(minutesAgo(37), NOW)).toBe('37m');
  });

  it('formats zero elapsed minutes', () => {
    expect(formatTwitchLiveDuration(minutesAgo(0), NOW)).toBe('0m');
  });

  it('formats an hour or more as hours and minutes', () => {
    expect(formatTwitchLiveDuration(minutesAgo(134), NOW)).toBe('2h 14m');
  });

  it('formats exactly one hour', () => {
    expect(formatTwitchLiveDuration(minutesAgo(60), NOW)).toBe('1h 0m');
  });

  it('formats a day or more as days and hours', () => {
    expect(formatTwitchLiveDuration(minutesAgo(27 * 60), NOW)).toBe('1d 3h');
  });

  it('returns null for a missing started_at', () => {
    expect(formatTwitchLiveDuration(undefined, NOW)).toBeNull();
  });

  it('returns null for an invalid started_at', () => {
    expect(formatTwitchLiveDuration('not-a-date', NOW)).toBeNull();
  });

  it('returns null for a started_at in the future (clock skew)', () => {
    expect(formatTwitchLiveDuration(new Date(NOW + 60_000).toISOString(), NOW)).toBeNull();
  });
});
