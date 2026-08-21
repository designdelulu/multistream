import { describe, expect, it } from 'vitest';
import { IPAD_MAX_STREAMS, isIPadDevice, resolveDisplayViewMode } from './viewport';

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

describe('IPAD_MAX_STREAMS', () => {
  it('is the flat ten-stream ceiling the toolbar enforces', () => {
    // Deliberately one number, not orientation-aware: a cap that changed on
    // rotation would put an existing lineup "over cap" mid-session with no
    // action the user took. Landscape's tighter comfortable limit is advisory
    // copy (the iPad note in index.html), not a second threshold.
    expect(IPAD_MAX_STREAMS).toBe(10);
  });
});
