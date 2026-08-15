/**
 * Pure layout math for the stream grid — no DOM access, fully unit-testable.
 * StreamGrid.ts's updateGridLayout() calls into this module and only ever
 * writes the returned numbers into CSS custom properties; it never contains
 * the packing logic itself. Keeping this DOM-free is what makes the packing
 * algorithm (and the Focus View sizing next to it) testable without jsdom.
 */

export type StreamOrientation = 'landscape' | 'portrait';

export const GRID_GAP = 12;
export const GRID_PADDING = 24;
export const CARD_HEADER_HEIGHT = 42;
export const MAX_GRID_COLUMNS = 4;

/**
 * A portrait tile always occupies exactly this many landscape row tracks in
 * Grid View — a fixed product rule (orientation-based, not per-platform),
 * not a value derived from real 9:16 aspect math. An adaptive span (tried
 * first) produced tiles that landed at ~2.7-2.9 rows depending on cell size,
 * which never aligned cleanly with the surrounding landscape rows. The
 * tradeoff: the allocated cell and the video's true aspect ratio can now
 * disagree, so the video is letterboxed (see portraitContentWidth/Height)
 * inside the fixed 2-row box rather than stretched to fill it.
 */
export const PORTRAIT_ROW_SPAN = 2;

export interface WeightedGridItem {
  readonly id: string;
  readonly orientation: StreamOrientation;
}

export interface WeightedGridResult {
  readonly columns: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Always PORTRAIT_ROW_SPAN when any portrait item is present — see that constant's doc comment. */
  readonly portraitRowSpan: number;
  /**
   * The true-9:16 box a portrait player renders at, centered inside its
   * fixed 2-row cell (see StreamGrid.ts's updateGridLayout, which writes
   * these as --portrait-content-width/height). Never stretches the video:
   * whichever of the cell's width or its 2-row height is the tighter
   * constraint determines the box, and the other dimension is derived from
   * it. Zero when there is no portrait item in this layout.
   */
  readonly portraitContentWidth: number;
  readonly portraitContentHeight: number;
}

const EMPTY_RESULT: WeightedGridResult = {
  columns: 1,
  cellWidth: 0,
  cellHeight: 0,
  portraitRowSpan: PORTRAIT_ROW_SPAN,
  portraitContentWidth: 0,
  portraitContentHeight: 0,
};

/**
 * Direct descendant of MultiTwitch's optimize_size (see updateGridLayout's
 * own doc comment): brute-force every column count from 1..maxColumns,
 * clamp each candidate cell to 16:9, and keep whichever column count yields
 * the largest cell. This extends that search to be orientation-aware: a
 * portrait item never widens (it still fits the same column track as a
 * landscape item — 9:16 content is narrow by nature) but spans a fixed 2
 * rows, and the row-count estimate used to size every cell accounts for that
 * weight instead of assuming every item is exactly one row tall.
 */
export function computeWeightedGridLayout(
  items: readonly WeightedGridItem[],
  areaWidth: number,
  areaHeight: number,
  options: { gap?: number; maxColumns?: number; chromeHeightPerRow?: number } = {},
): WeightedGridResult {
  const gap = options.gap ?? GRID_GAP;
  const maxColumns = options.maxColumns ?? MAX_GRID_COLUMNS;
  // Header-chrome height (e.g. the card header row) each grid row loses on
  // top of the gap — see StreamGrid.ts's updateGridLayout, which is the only
  // caller that ever passes this. Defaults to 0 so every existing caller
  // and test that never mentions chrome is unaffected.
  const chromeHeightPerRow = options.chromeHeightPerRow ?? 0;
  const count = items.length;

  if (count === 0 || areaWidth <= 0 || areaHeight <= 0) {
    return EMPTY_RESULT;
  }

  const portraitCount = items.filter((item) => item.orientation === 'portrait').length;
  const landscapeCount = count - portraitCount;

  const clamp16by9 = (width: number, height: number): [number, number] => {
    if ((width * 9) / 16 < height) {
      return [width, (width * 9) / 16];
    }
    return [(height * 16) / 9, height];
  };

  let best: WeightedGridResult = EMPTY_RESULT;

  for (let columns = 1; columns <= Math.min(count, maxColumns); columns++) {
    // Floored before the 16:9 clamp below, matching the pre-portrait
    // baseline packer (commit 2a52275) pixel-for-pixel for the all-landscape
    // case — flooring only at the final CSS write (as this used to) lets a
    // fractional-pixel candidate win a column-count tie it wouldn't have won
    // in production, which is a real (if 1px) numeric drift from the known-
    // good baseline. See gridLayout.test.ts's baseline-equivalence suite.
    const maxCellWidth = Math.floor((areaWidth - gap * (columns - 1)) / columns);
    if (maxCellWidth <= 0) continue;

    const weightedRows = Math.ceil((landscapeCount + portraitCount * PORTRAIT_ROW_SPAN) / columns);
    if (weightedRows <= 0) continue;

    const rowHeight = Math.floor((areaHeight - gap * (weightedRows - 1)) / weightedRows) - chromeHeightPerRow;
    if (rowHeight <= 0) continue;

    const [cellWidth, cellHeight] = clamp16by9(maxCellWidth, rowHeight);

    if (cellWidth > best.cellWidth) {
      best = { columns, cellWidth, cellHeight, portraitRowSpan: PORTRAIT_ROW_SPAN, portraitContentWidth: 0, portraitContentHeight: 0 };
    }
  }

  if (best.cellWidth <= 0 || best.cellHeight <= 0) return EMPTY_RESULT;

  if (portraitCount > 0) {
    /*
     * Total height a portrait card occupies: PORTRAIT_ROW_SPAN row tracks
     * (each cellHeight + chrome tall, matching every landscape card) plus
     * the gaps CSS Grid inserts between them, minus one chrome height since
     * the portrait card renders only its own single header, not one per
     * spanned row. That is the real available height for the player area
     * (see main.css's flex:1 rule on the portrait player), which the video
     * is then letterboxed inside — see portraitContentWidth/Height's doc.
     */
    const spannedHeight =
      best.cellHeight * PORTRAIT_ROW_SPAN +
      chromeHeightPerRow * PORTRAIT_ROW_SPAN +
      gap * (PORTRAIT_ROW_SPAN - 1);
    const playerAreaHeight = spannedHeight - chromeHeightPerRow;
    const contentWidth = Math.min(best.cellWidth, (playerAreaHeight * 9) / 16);
    const contentHeight = (contentWidth * 16) / 9;
    best = { ...best, portraitContentWidth: contentWidth, portraitContentHeight: contentHeight };
  }

  return best;
}

// --- Focus View --------------------------------------------------------

export interface FocusViewLayoutResult {
  readonly primaryWidth: number;
  readonly primaryHeight: number;
  readonly trayHeight: number;
  /** Width of one landscape tray tile at trayHeight (9:16 secondaries use trayHeight * 9/16 instead). */
  readonly trayColumnWidth: number;
}

const MIN_TRAY_HEIGHT = 88;
const MAX_TRAY_HEIGHT = 220;

/**
 * Responsive secondary-stream capacity before the tray scrolls, per the
 * product spec's breakpoint guidance. Only used to *size* tray tiles (so
 * roughly this many fit before `overflow-x: auto` kicks in) — it never caps
 * how many secondary streams can exist, only how large each tile starts.
 */
export function targetVisibleTrayCount(areaWidth: number): number {
  if (areaWidth < 640) return 2;
  if (areaWidth < 1024) return 3;
  if (areaWidth < 1440) return 4;
  return 6;
}

/**
 * Sizes the Focus View primary box (respecting its own orientation — a
 * portrait primary is never stretched to 16:9) and, when a tray is present,
 * the horizontal tray strip below it. Both regions share one grid container
 * in the DOM (see StreamGrid.ts's syncFocusViewDom) — this function only
 * produces pixel sizes; it never decides which stream is primary.
 *
 * `includeTray: false` (Theater — see StreamGrid.ts's updateFocusViewLayout)
 * gives the primary the entire area height instead of reserving a tray row
 * that CSS never renders (main.css's `[data-view-mode='theater']` hides
 * every non-primary card) — the previous version always reserved tray space
 * regardless of mode, which is why Theater used to render a primary far
 * smaller than the viewport with a large unused gap below it.
 *
 * Both dimensions are now a true "contain" fit — width and height are each
 * clamped against their own area budget, then the other dimension is
 * re-derived from whichever one was the tighter constraint — so the primary
 * never overflows the area in the dimension that wasn't the binding one
 * (the previous version derived primaryWidth from primaryHeight and then
 * clamped it against areaWidth without re-deriving primaryHeight, so a
 * narrow-but-tall area could still overflow horizontally... only for the
 * width clamp to silently produce a non-16:9 box).
 */
export function computeFocusViewLayout(
  areaWidth: number,
  areaHeight: number,
  primaryOrientation: StreamOrientation,
  options: { gap?: number; chromeHeightPerRow?: number; includeTray?: boolean } = {},
): FocusViewLayoutResult {
  const gap = options.gap ?? GRID_GAP;
  // Header height reserved once for the primary's own row and once for the
  // tray's row (every tray tile shares one row, so its header only costs the
  // row once regardless of tray size) — see StreamGrid.ts's
  // updateFocusViewLayout, the only caller that ever passes this. The
  // returned primaryHeight/trayHeight are pure PLAYER heights either way
  // (matching --player-height's existing meaning elsewhere): callers that
  // also render a header must add chromeHeightPerRow back on top themselves
  // when sizing the row/card, not just the player.
  const chromeHeightPerRow = options.chromeHeightPerRow ?? 0;
  const includeTray = options.includeTray ?? true;
  if (areaWidth <= 0 || areaHeight <= 0) {
    return { primaryWidth: 0, primaryHeight: 0, trayHeight: 0, trayColumnWidth: 0 };
  }

  let trayHeight = 0;
  let trayColumnWidth = 0;
  let primaryAreaHeight = areaHeight - chromeHeightPerRow;

  if (includeTray) {
    const targetVisible = targetVisibleTrayCount(areaWidth);
    const provisionalColumnWidth = Math.max(
      64,
      Math.floor((areaWidth - gap * (targetVisible - 1)) / targetVisible),
    );
    trayHeight = Math.min(
      MAX_TRAY_HEIGHT,
      Math.max(MIN_TRAY_HEIGHT, Math.round((provisionalColumnWidth * 9) / 16)),
    );
    trayColumnWidth = Math.round((trayHeight * 16) / 9);
    primaryAreaHeight = areaHeight - (trayHeight + chromeHeightPerRow) - gap - chromeHeightPerRow;
  }
  primaryAreaHeight = Math.max(0, primaryAreaHeight);

  let primaryWidth: number;
  let primaryHeight: number;
  if (primaryOrientation === 'portrait') {
    primaryHeight = Math.min(primaryAreaHeight, (areaWidth * 16) / 9);
    primaryWidth = (primaryHeight * 9) / 16;
  } else {
    primaryWidth = Math.min(areaWidth, (primaryAreaHeight * 16) / 9);
    primaryHeight = (primaryWidth * 9) / 16;
  }

  return { primaryWidth, primaryHeight, trayHeight, trayColumnWidth };
}
