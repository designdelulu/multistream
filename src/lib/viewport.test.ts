import { describe, expect, it } from 'vitest';
import { isIPadDevice, resolveDisplayViewMode } from './viewport';

describe('isIPadDevice', () => {
  it('recognizes a legacy iPad user agent', () => {
    expect(
      isIPadDevice({
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)',
        platform: 'iPad',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it('recognizes desktop-class iPadOS', () => {
    expect(
      isIPadDevice({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it('does not mistake a Mac for an iPad', () => {
    expect(
      isIPadDevice({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });
});

describe('resolveDisplayViewMode', () => {
  const ipadNav = {
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)',
    platform: 'iPad',
    maxTouchPoints: 5,
  } as const;

  it('maps store focus to solo theater display on iPad', () => {
    expect(resolveDisplayViewMode('focus', ipadNav)).toBe('theater');
  });

  it('passes through other modes on iPad', () => {
    expect(resolveDisplayViewMode('grid', ipadNav)).toBe('grid');
    expect(resolveDisplayViewMode('theater', ipadNav)).toBe('theater');
  });

  it('does not remap focus on desktop', () => {
    expect(
      resolveDisplayViewMode('focus', {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe('focus');
  });
});
