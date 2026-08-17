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
/** Fixed compact control strip rendered below players while headers are hidden. */
export const COMPACT_TOOLBAR_HEIGHT = 30;
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
  /** Width of one landscape under-grid tile at trayHeight (9:16 secondaries use trayHeight * 9/16 instead). */
  readonly trayColumnWidth: number;
  readonly trayColumns: number;
  readonly trayRows: number;
}

const EMPTY_FOCUS: FocusViewLayoutResult = {
  primaryWidth: 0,
  primaryHeight: 0,
  trayHeight: 0,
  trayColumnWidth: 0,
  trayColumns: 0,
  trayRows: 0,
};

/** Old chat-closed film-strip band — empirically large enough for Twitch to start. */
const MIN_TRAY_HEIGHT = 160;
const MAX_TRAY_HEIGHT = 220;
/** 16:9 width at ~172px, the chat-closed 1920 size that used to work. */
const TRAY_FIT_COLUMN_WIDTH = Math.round((172 * 16) / 9);
/** Primary keeps the majority of the viewport; under-grid shrinks if needed. */
const UNDER_GRID_MAX_FRACTION = 0.4;

/**
 * How many ~306px-wide under-grid columns fit in the area. Never caps how
 * many secondary streams exist — wrapping uses this as the column count.
 */
export function targetVisibleTrayCount(areaWidth: number): number {
  return Math.max(1, Math.floor((areaWidth + GRID_GAP) / (TRAY_FIT_COLUMN_WIDTH + GRID_GAP)));
}

/**
 * Sizes the Focus View primary box (respecting its own orientation — a
 * portrait primary is never stretched to 16:9) and, when an under-grid is
 * present, a wrapping grid of every other stream below it. Both regions
 * share one grid container in the DOM (see StreamGrid.ts's syncFocusViewDom)
 * — this function only produces pixel sizes; it never decides which stream
 * is primary.
 *
 * `includeTray: false` (Theater — see StreamGrid.ts's updateFocusViewLayout)
 * gives the primary the entire area height instead of reserving under-grid
 * space that CSS never renders (main.css's `[data-view-mode='theater']` hides
 * every non-primary card).
 *
 * `secondaryCount` is how many streams sit in the under-grid. When omitted,
 * the layout uses one row of `targetVisibleTrayCount` tiles (the old strip
 * density) so callers that only care about primary sizing stay valid.
 *
 * Both primary dimensions are a true "contain" fit — width and height are
 * each clamped against their own area budget, then the other dimension is
 * re-derived from whichever one was the tighter constraint.
 */
export function computeFocusViewLayout(
  areaWidth: number,
  areaHeight: number,
  primaryOrientation: StreamOrientation,
  options: {
    gap?: number;
    chromeHeightPerRow?: number;
    includeTray?: boolean;
    secondaryCount?: number;
  } = {},
): FocusViewLayoutResult {
  const gap = options.gap ?? GRID_GAP;
  const chromeHeightPerRow = options.chromeHeightPerRow ?? 0;
  const includeTray = options.includeTray ?? true;
  if (areaWidth <= 0 || areaHeight <= 0) {
    return EMPTY_FOCUS;
  }

  let trayHeight = 0;
  let trayColumnWidth = 0;
  let trayColumns = 0;
  let trayRows = 0;
  let primaryAreaHeight = areaHeight - chromeHeightPerRow;

  if (includeTray) {
    const fitColumns = targetVisibleTrayCount(areaWidth);
    const secondaries = options.secondaryCount ?? fitColumns;
    if (secondaries > 0) {
      // Pick the row count first, then spread items evenly across it (e.g. 8
      // secondaries at fitColumns=5 becomes 2 rows of 4, not a 5+3 orphan) —
      // this is what lets the last row center cleanly in main.css/StreamGrid.ts.
      trayRows = Math.ceil(secondaries / fitColumns);
      trayColumns = Math.max(1, Math.ceil(secondaries / trayRows));
      const provisionalColumnWidth = Math.max(
        64,
        Math.floor((areaWidth - gap * (trayColumns - 1)) / trayColumns),
      );
      let cellHeight = Math.min(
        MAX_TRAY_HEIGHT,
        Math.max(MIN_TRAY_HEIGHT, Math.round((provisionalColumnWidth * 9) / 16)),
      );
      const underHeightFor = (height: number): number =>
        trayRows * (height + chromeHeightPerRow) + gap * Math.max(0, trayRows - 1);
      const maxUnder = Math.floor(areaHeight * UNDER_GRID_MAX_FRACTION);
      if (maxUnder > 0 && underHeightFor(cellHeight) > maxUnder) {
        const heightBudget = maxUnder - gap * Math.max(0, trayRows - 1);
        const perRow = Math.floor(heightBudget / trayRows) - chromeHeightPerRow;
        cellHeight = Math.max(1, Math.min(cellHeight, perRow));
      }
      trayHeight = cellHeight;
      trayColumnWidth = Math.round((trayHeight * 16) / 9);
      primaryAreaHeight = areaHeight - underHeightFor(trayHeight) - gap - chromeHeightPerRow;
    }
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

  return {
    primaryWidth,
    primaryHeight,
    trayHeight,
    trayColumnWidth,
    trayColumns,
    trayRows,
  };
}
