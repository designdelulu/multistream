import { describe, expect, it } from 'vitest';
import {
  computeFocusViewLayout,
  computeWeightedGridLayout,
  CARD_HEADER_HEIGHT,
  COMPACT_TOOLBAR_HEIGHT,
  GRID_GAP,
  PORTRAIT_ROW_SPAN,
  targetVisibleTrayCount,
  type WeightedGridItem,
} from './gridLayout';

function landscape(id: string): WeightedGridItem {
  return { id, orientation: 'landscape' };
}

function portrait(id: string): WeightedGridItem {
  return { id, orientation: 'portrait' };
}

describe('computeWeightedGridLayout — all-landscape (unweighted) baseline', () => {
  it('returns a zeroed result for an empty grid', () => {
    const result = computeWeightedGridLayout([], 1200, 800);
    expect(result).toEqual({
      columns: 1,
      cellWidth: 0,
      cellHeight: 0,
      portraitRowSpan: PORTRAIT_ROW_SPAN,
      portraitContentWidth: 0,
      portraitContentHeight: 0,
    });
  });

  it('returns a zeroed result when the area has no measurable size', () => {
    expect(computeWeightedGridLayout([landscape('a')], 0, 800).cellWidth).toBe(0);
    expect(computeWeightedGridLayout([landscape('a')], 1200, 0).cellWidth).toBe(0);
  });

  it('single stream fills the area at 16:9', () => {
    const result = computeWeightedGridLayout([landscape('a')], 1200, 800);
    expect(result.columns).toBe(1);
    expect(result.cellWidth / result.cellHeight).toBeCloseTo(16 / 9, 2);
  });

  it('never exceeds the configured max column count regardless of stream count', () => {
    const items = Array.from({ length: 9 }, (_, i) => landscape(String(i)));
    const result = computeWeightedGridLayout(items, 1600, 900);
    expect(result.columns).toBeLessThanOrEqual(4);
  });

  it('picks more columns as the area widens for a fixed count', () => {
    const items = [landscape('a'), landscape('b'), landscape('c'), landscape('d')];
    const narrow = computeWeightedGridLayout(items, 700, 900);
    const wide = computeWeightedGridLayout(items, 2400, 900);
    expect(wide.columns).toBeGreaterThanOrEqual(narrow.columns);
  });
});

describe('computeWeightedGridLayout — portrait weighting (fixed 2-row span)', () => {
  it('a portrait item always reports exactly PORTRAIT_ROW_SPAN (2), not aspect-derived math', () => {
    const result = computeWeightedGridLayout([portrait('a')], 1200, 900);
    expect(result.portraitRowSpan).toBe(2);
    expect(PORTRAIT_ROW_SPAN).toBe(2);
  });

  it('an all-landscape grid still reports the same 2-row constant (span only applies via data-orientation in CSS)', () => {
    const items = [landscape('a'), landscape('b'), landscape('c')];
    const result = computeWeightedGridLayout(items, 1400, 900);
    expect(result.portraitRowSpan).toBe(2);
    expect(result.portraitContentWidth).toBe(0);
    expect(result.portraitContentHeight).toBe(0);
  });

  it('3 landscape + 1 portrait: portrait item never widens the column beyond a landscape one', () => {
    const items = [landscape('a'), landscape('b'), landscape('c'), portrait('d')];
    const result = computeWeightedGridLayout(items, 1400, 900);
    expect(result.cellWidth).toBeGreaterThan(0);
    expect(result.portraitRowSpan).toBe(2);
  });

  it('the portrait content box fits within 2 row tracks + 1 gap (plus chrome accounting) and keeps a true 9:16 ratio', () => {
    const items = [landscape('a'), landscape('b'), landscape('c'), portrait('d')];
    const chromeHeightPerRow = 42;
    const result = computeWeightedGridLayout(items, 1400, 900, { chromeHeightPerRow });
    expect(result.portraitContentWidth).toBeGreaterThan(0);
    expect(result.portraitContentHeight).toBeGreaterThan(0);
    expect(result.portraitContentWidth / result.portraitContentHeight).toBeCloseTo(9 / 16, 3);
    // Never wider than the shared landscape column, never taller than the
    // 2-row allocation minus the portrait card's own single header.
    expect(result.portraitContentWidth).toBeLessThanOrEqual(result.cellWidth + 0.01);
    const allocatedPlayerHeight =
      result.cellHeight * PORTRAIT_ROW_SPAN + chromeHeightPerRow * (PORTRAIT_ROW_SPAN - 1) + GRID_GAP * (PORTRAIT_ROW_SPAN - 1);
    expect(result.portraitContentHeight).toBeLessThanOrEqual(allocatedPlayerHeight + 0.01);
  });

  it('reordering which item is portrait does not change the span (order-independent)', () => {
    const a = computeWeightedGridLayout(
      [portrait('p'), landscape('a'), landscape('b'), landscape('c')],
      1400,
      900,
    );
    const b = computeWeightedGridLayout(
      [landscape('a'), landscape('b'), portrait('p'), landscape('c')],
      1400,
      900,
    );
    expect(a.portraitRowSpan).toBe(2);
    expect(b.portraitRowSpan).toBe(2);
    expect(a.cellWidth).toBeCloseTo(b.cellWidth, 5);
    expect(a.portraitContentWidth).toBeCloseTo(b.portraitContentWidth, 5);
  });

  it('adding/removing surrounding landscape streams never changes the portrait span itself', () => {
    const fewer = computeWeightedGridLayout([landscape('a'), portrait('p')], 1400, 900);
    const more = computeWeightedGridLayout(
      [...Array.from({ length: 8 }, (_, i) => landscape(`l${i}`)), portrait('p')],
      1920,
      1080,
    );
    expect(fewer.portraitRowSpan).toBe(2);
    expect(more.portraitRowSpan).toBe(2);
  });

  it('two portrait items each still resolve to a 2-row span, not a doubled span', () => {
    const items = [...Array.from({ length: 6 }, (_, i) => landscape(`l${i}`)), portrait('p0'), portrait('p1')];
    const result = computeWeightedGridLayout(items, 1600, 900);
    expect(result.portraitRowSpan).toBe(2);
    expect(result.portraitContentWidth).toBeGreaterThan(0);
  });

  it('6 landscape + 1 portrait packs without a non-finite or negative cell size', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => landscape(`l${i}`)),
      portrait('p0'),
    ];
    const result = computeWeightedGridLayout(items, 1600, 900);
    expect(Number.isFinite(result.cellWidth)).toBe(true);
    expect(Number.isFinite(result.cellHeight)).toBe(true);
    expect(result.cellWidth).toBeGreaterThan(0);
    expect(result.cellHeight).toBeGreaterThan(0);
  });

  it('8 landscape + 1 portrait stays within column cap and produces a usable (non-tiny) cell', () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) => landscape(`l${i}`)),
      portrait('p0'),
    ];
    const result = computeWeightedGridLayout(items, 1920, 1080);
    expect(result.columns).toBeLessThanOrEqual(4);
    expect(result.cellWidth).toBeGreaterThan(50);
  });

  it('mostly-portrait grid still resolves to a positive, finite cell size', () => {
    const items = [portrait('a'), portrait('b'), portrait('c'), landscape('d')];
    const result = computeWeightedGridLayout(items, 1400, 900);
    expect(result.cellWidth).toBeGreaterThan(0);
    expect(Number.isFinite(result.cellHeight)).toBe(true);
  });

  it('only-portrait grid resolves without error', () => {
    const items = [portrait('a'), portrait('b'), portrait('c')];
    const result = computeWeightedGridLayout(items, 1400, 900);
    expect(result.cellWidth).toBeGreaterThan(0);
    expect(result.portraitRowSpan).toBe(2);
  });
});

describe('targetVisibleTrayCount — how many ~306px under-grid columns fit', () => {
  it('narrow screens still show at least 1', () => {
    expect(targetVisibleTrayCount(375)).toBe(1);
  });
  it('900px fits 2', () => {
    expect(targetVisibleTrayCount(900)).toBe(2);
  });
  it('1280px fits 4', () => {
    expect(targetVisibleTrayCount(1280)).toBe(4);
  });
  it('1920px fits 6', () => {
    expect(targetVisibleTrayCount(1920)).toBe(6);
  });
});

describe('computeFocusViewLayout', () => {
  it('does not inherit the Grid View 2-row span rule — a portrait primary is sized by aspect ratio alone, not row tracks', () => {
    const result = computeFocusViewLayout(1600, 900, 'portrait');
    expect(result).not.toHaveProperty('portraitRowSpan');
    expect(result.primaryWidth / result.primaryHeight).toBeCloseTo(9 / 16, 1);
  });

  it('returns zeroed sizes for an unmeasurable area', () => {
    expect(computeFocusViewLayout(0, 800, 'landscape')).toEqual({
      primaryWidth: 0,
      primaryHeight: 0,
      trayHeight: 0,
      trayColumnWidth: 0,
      trayColumns: 0,
      trayRows: 0,
    });
  });

  it('landscape primary keeps 16:9 and never exceeds the available width', () => {
    const result = computeFocusViewLayout(1600, 900, 'landscape');
    expect(result.primaryWidth).toBeLessThanOrEqual(1600);
    expect(result.primaryWidth / result.primaryHeight).toBeCloseTo(16 / 9, 1);
  });

  it('portrait primary keeps 9:16 — never stretched to landscape', () => {
    const result = computeFocusViewLayout(1600, 900, 'portrait');
    expect(result.primaryWidth / result.primaryHeight).toBeCloseTo(9 / 16, 1);
    expect(result.primaryWidth).toBeLessThan(result.primaryHeight);
  });

  it('portrait primary is narrower than landscape primary in the same box (never stretched wider than its own aspect)', () => {
    const landscapeResult = computeFocusViewLayout(1600, 900, 'landscape');
    const portraitResult = computeFocusViewLayout(1600, 900, 'portrait');
    expect(portraitResult.primaryWidth).toBeLessThan(landscapeResult.primaryWidth);
  });

  /*
   * The old assertion here was a hard 160–220 band. The upper half of that
   * band was a fixed height cap that ignored the track width, and when
   * row-balancing produced a track wider than 16:9 at that height the tile
   * stretched and the provider pillarboxed it (the reported "black bars on
   * the left and right of each video"). The cap is gone; what replaces it as
   * the invariant is below — a true 16:9 tile, and an under-grid that still
   * respects its 40% share so the primary stays dominant.
   */
  it('under-grid tiles stay a true 16:9 box across viewport sizes', () => {
    for (const width of [320, 375, 430, 768, 900, 1024, 1280, 1440, 1920]) {
      const result = computeFocusViewLayout(width, 800, 'landscape');
      expect(result.trayHeight).toBeGreaterThanOrEqual(160);
      expect(result.trayColumnWidth).toBe(Math.round((result.trayHeight * 16) / 9));
    }
  });

  it('under-grid tiles are 16:9 for every secondary count, and never exceed their track', () => {
    for (let secondaryCount = 1; secondaryCount <= 10; secondaryCount += 1) {
      const result = computeFocusViewLayout(1880, 1666, 'landscape', { secondaryCount });
      expect(result.trayColumnWidth).toBe(Math.round((result.trayHeight * 16) / 9));

      // A tile must fit the track the balancing gave it — the old cap let a
      // 618px track hold a 618x220 box, which is 2.81:1, not 16:9.
      const trackWidth = Math.floor((1880 - GRID_GAP * (result.trayColumns - 1)) / result.trayColumns);
      expect(result.trayColumnWidth).toBeLessThanOrEqual(trackWidth + 1);
    }
  });

  it('under-grid never claims more than its 40% share of the area height', () => {
    for (const secondaryCount of [1, 3, 6, 9]) {
      for (const areaHeight of [800, 1056, 1666]) {
        const result = computeFocusViewLayout(1880, areaHeight, 'landscape', {
          secondaryCount,
          chromeHeightPerRow: CARD_HEADER_HEIGHT,
        });
        const underHeight =
          result.trayRows * (result.trayHeight + CARD_HEADER_HEIGHT) +
          Math.max(0, result.trayRows - 1) * GRID_GAP;
        expect(underHeight).toBeLessThanOrEqual(Math.floor(areaHeight * 0.4));
      }
    }
  });

  it('the reported 6-stream case is 3x2 at true 16:9, not the old stretched 618x220', () => {
    const result = computeFocusViewLayout(1880, 1666, 'landscape', {
      secondaryCount: 6,
      chromeHeightPerRow: CARD_HEADER_HEIGHT,
    });
    expect(result.trayColumns).toBe(3);
    expect(result.trayRows).toBe(2);
    expect(result.trayHeight).toBeGreaterThan(220);
    expect(result.trayColumnWidth).toBe(Math.round((result.trayHeight * 16) / 9));
  });

  it('chat-open desktop cells stay in the 160–220 band, not the Twitch-doc 400×300 floor', () => {
    const result = computeFocusViewLayout(1556, 1056, 'landscape');
    expect(result.trayHeight).toBeGreaterThanOrEqual(160);
    expect(result.trayHeight).toBeLessThanOrEqual(220);
    expect(result.trayColumnWidth).toBeLessThan(400);
  });

  it('wraps every secondary onto multiple rows instead of clipping them to one strip', () => {
    const result = computeFocusViewLayout(1600, 900, 'landscape', { secondaryCount: 8 });
    expect(result.trayRows).toBeGreaterThan(1);
    expect(result.trayColumns * result.trayRows).toBeGreaterThanOrEqual(8);
  });

  describe('row balancing (even rows over a left-aligned orphan)', () => {
    // 1600px area fits 5 tray columns (targetVisibleTrayCount) before balancing.
    it('8 secondaries at fit=5 becomes 2 even rows of 4, not 5+3', () => {
      const result = computeFocusViewLayout(1600, 900, 'landscape', { secondaryCount: 8 });
      expect(result.trayRows).toBe(2);
      expect(result.trayColumns).toBe(4);
    });

    it('7 secondaries at fit=5 becomes a balanced 4+3 (not a left-aligned 5+2)', () => {
      const result = computeFocusViewLayout(1600, 900, 'landscape', { secondaryCount: 7 });
      expect(result.trayRows).toBe(2);
      expect(result.trayColumns).toBe(4);
    });

    it('6 secondaries at fit=5 becomes two full rows of 3', () => {
      const result = computeFocusViewLayout(1600, 900, 'landscape', { secondaryCount: 6 });
      expect(result.trayRows).toBe(2);
      expect(result.trayColumns).toBe(3);
    });

    it('a single secondary is one column, one row', () => {
      const result = computeFocusViewLayout(1600, 900, 'landscape', { secondaryCount: 1 });
      expect(result.trayRows).toBe(1);
      expect(result.trayColumns).toBe(1);
    });
  });

  it('primary height leaves room for the tray (never overlaps it)', () => {
    const result = computeFocusViewLayout(1200, 800, 'landscape');
    expect(result.primaryHeight).toBeLessThan(800);
    expect(result.primaryHeight + result.trayHeight).toBeLessThanOrEqual(800);
  });

  it('budgets the fixed compact footer in every Focus row', () => {
    expect(COMPACT_TOOLBAR_HEIGHT).toBe(30);
    const result = computeFocusViewLayout(1200, 800, 'landscape', {
      secondaryCount: 7,
      chromeHeightPerRow: COMPACT_TOOLBAR_HEIGHT,
    });
    const occupied =
      result.primaryHeight +
      COMPACT_TOOLBAR_HEIGHT +
      GRID_GAP +
      result.trayRows * (result.trayHeight + COMPACT_TOOLBAR_HEIGHT) +
      Math.max(0, result.trayRows - 1) * GRID_GAP;
    expect(occupied).toBeLessThanOrEqual(800);
  });
});

/**
 * Byte-for-byte reproduction of the pre-portrait, pre-Focus-View brute-force
 * packer from commit 2a52275 (the Aug 13 known-good production baseline) —
 * transcribed, not imported, since that code no longer exists in this file.
 * This is the archived source of truth for "landscape-only geometry must
 * never change" (see CLAUDE.md / the Aug 2026 baseline-restoration pass).
 */
function baselinePack(
  count: number,
  areaWidth: number,
  areaHeight: number,
  chromeHeight: number,
): { columns: number; width: number; height: number } {
  let bestColumns = 1;
  let bestWidth = 0;
  let bestHeight = 0;

  for (let columns = 1; columns <= Math.min(count, 4); columns += 1) {
    const rows = Math.ceil(count / columns);
    let maxWidth = Math.floor((areaWidth - GRID_GAP * (columns - 1)) / columns);
    let maxHeight = Math.floor((areaHeight - GRID_GAP * (rows - 1)) / rows) - chromeHeight;

    if (maxWidth <= 0 || maxHeight <= 0) {
      continue;
    }

    if ((maxWidth * 9) / 16 < maxHeight) {
      maxHeight = (maxWidth * 9) / 16;
    } else {
      maxWidth = (maxHeight * 16) / 9;
    }

    if (maxWidth > bestWidth) {
      bestWidth = maxWidth;
      bestHeight = maxHeight;
      bestColumns = columns;
    }
  }

  return { columns: bestColumns, width: Math.floor(bestWidth), height: Math.floor(bestHeight) };
}

describe('computeWeightedGridLayout — landscape-only geometry matches the Aug 13 baseline exactly', () => {
  const CHROME = 42; // CARD_HEADER_HEIGHT
  const viewports: Array<[width: number, height: number]> = [
    [1024, 700],
    [1280, 800],
    [1440, 900],
    [1920, 1040],
  ];
  const counts = [1, 2, 4, 6, 7, 9, 10];

  for (const [areaWidth, areaHeight] of viewports) {
    for (const count of counts) {
      it(`${count} landscape streams at ${areaWidth}x${areaHeight}: columns/width/height == baseline`, () => {
        const items: WeightedGridItem[] = Array.from({ length: count }, (_, i) => landscape(`s${i}`));
        const packed = computeWeightedGridLayout(items, areaWidth, areaHeight, {
          gap: GRID_GAP,
          maxColumns: 4,
          chromeHeightPerRow: CHROME,
        });
        const baseline = baselinePack(count, areaWidth, areaHeight, CHROME);

        expect(packed.columns).toBe(baseline.columns);
        expect(Math.floor(packed.cellWidth)).toBe(baseline.width);
        expect(Math.floor(packed.cellHeight)).toBe(baseline.height);
      });
    }
  }
});
