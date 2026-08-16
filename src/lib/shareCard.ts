import { getAdapter } from '../platforms';
import type { StreamRef } from '../types';

/**
 * The colors here intentionally mirror main.css's --twitch/--kick/--youtube/
 * --tiktok custom properties (there's no way to read a CSS custom property
 * from inside a <canvas> 2D context — those only apply to DOM painting, not
 * pixel drawing — so the same brand colors are duplicated here as plain
 * hex). Keep both in sync if either changes.
 */
const PROVIDER_BADGE: Record<StreamRef['platform'], { label: string; color: string }> = {
  twitch: { label: 'Twitch', color: '#9146ff' },
  kick: { label: 'Kick', color: '#53fc18' },
  youtube: { label: 'YouTube', color: '#ff0033' },
  tiktok: { label: 'TikTok', color: '#fe2c55' },
};

export interface ShareCardEntry {
  id: string;
  handle: string;
  initials: string;
  platformLabel: string;
  badgeColor: string;
  avatarUrl?: string;
}

export interface ShareCardData {
  headline: string;
  liveNowLabel: string;
  streamCountLabel: string;
  watchUrl: string;
  entries: ShareCardEntry[];
}

function initialsFor(handle: string): string {
  const cleaned = handle.replace(/^[@#]/, '').trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Pure data prep for the Watch Party share card — no canvas/DOM here, so
 * this half is unit-testable (see shareCard.test.ts). renderShareCard (same
 * directory) is the impure half that actually draws it; it isn't unit
 * tested since jsdom has no real <canvas> 2D context (see shareCard.md /
 * this file's own test file for that split, matching the existing
 * gridLayout.ts pure-math vs StreamGrid.ts DOM-writing convention already
 * used elsewhere in this codebase).
 */
export function buildShareCardData(
  streams: StreamRef[],
  watchUrl: string,
  avatarUrls?: Map<string, string>,
): ShareCardData {
  const entries: ShareCardEntry[] = streams.map((stream) => {
    const handle = getAdapter(stream.platform).displayName(stream);
    const badge = PROVIDER_BADGE[stream.platform];
    return {
      id: stream.id,
      handle,
      initials: initialsFor(handle),
      platformLabel: badge.label,
      badgeColor: badge.color,
      avatarUrl: avatarUrls?.get(stream.id),
    };
  });

  return {
    headline: 'Join my live watch party',
    liveNowLabel: 'LIVE NOW',
    streamCountLabel:
      streams.length === 1 ? '1 stream' : `${streams.length} streams`,
    watchUrl,
    entries,
  };
}

export const SHARE_CARD_WIDTH = 1080;
export const SHARE_CARD_HEIGHT = 1920;

/**
 * Three display tiers so the card never silently drops most of a large
 * lineup (see this module's own render doc comment for the "only includes a
 * few profile images" regression this fixes): 1-6 gets a roomy 2-3 column
 * grid, 7-16 gets a denser-but-still-individually-readable 4 column grid
 * showing everyone, and >16 shows the first 15 plus one same-size "+N more"
 * cell drawn in the same circle style as a real avatar — an explicit,
 * intentional-looking summary rather than a stray caption easy to miss.
 */
const ROOMY_TIER_MAX = 6;
const COMPACT_TIER_MAX = 16;
const COMPACT_TIER_SHOWN_WITH_OVERFLOW = 15;

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const words = text.split(' ');
  let line = '';
  let lineY = y;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, lineY);
      line = word;
      lineY += lineHeight;
    } else {
      line = candidate;
    }
  }
  if (line) ctx.fillText(line, x, lineY);
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export const SHARE_CARD_SAFE_MARGIN = 64;
export const SHARE_URL_FONT_MAX = 30;
export const SHARE_URL_FONT_MIN = 14;
export const SHARE_URL_LINE_HEIGHT = 1.28;
export const SHARE_URL_LAST_LINE_OFFSET = 100;
export const SHARE_URL_ATTRIBUTION_OFFSET = 60;

/** Centered Story header + grid. Avatars stay at STORY_GRID_START_Y. */
export const STORY_CENTER_X = SHARE_CARD_WIDTH / 2;
export const STORY_PILL_W = 190;
export const STORY_PILL_H = 52;
export const STORY_PILL_X = (SHARE_CARD_WIDTH - STORY_PILL_W) / 2;
export const STORY_BRAND_BASELINE_Y = 193;
export const STORY_TAGLINE_BASELINE_Y = 227;
export const STORY_PILL_Y = 273;
export const STORY_HEADLINE_BASELINE_Y = 445;
export const STORY_COUNT_BASELINE_Y = 555;
export const STORY_GRID_START_Y = 600;
export const STORY_ROOMY_ROW_EXTRA = 90;
export const STORY_COMPACT_ROW_EXTRA = 74;
export const STORY_CAPTION_FONT_SIZE = 44;
export const STORY_CAPTION_BASELINE_Y = 1820;

const URL_BREAK_CHARS = new Set(['/', ':', '?', '&', '=', '-', '_']);

export function shortenWatchUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export interface WatchUrlLayout {
  fontSize: number;
  lines: string[];
  truncated: boolean;
  fallbackReason?: string;
}

export interface WatchUrlBox {
  maxWidth: number;
  maxHeight: number;
}

/**
 * Same avatar-grid geometry renderShareCard uses, so URL-fit tests can
 * reserve the real footer band without drawing. Compact >16 lineups still
 * occupy four rows (15 faces + "+N more").
 */
export function shareCardUrlBox(entryCount: number): { gridBottom: number; box: WatchUrlBox } {
  const roomy = entryCount <= ROOMY_TIER_MAX;
  const columns = roomy ? (entryCount <= 2 ? Math.max(entryCount, 1) : entryCount <= 4 ? 2 : 3) : 4;
  const cellSize = roomy ? (columns === 2 ? 320 : 280) : 190;
  const rowHeight = cellSize + (roomy ? STORY_ROOMY_ROW_EXTRA : STORY_COMPACT_ROW_EXTRA);
  const shown = entryCount <= COMPACT_TIER_MAX ? entryCount : COMPACT_TIER_SHOWN_WITH_OVERFLOW;
  const overflow = Math.max(0, entryCount - shown);
  const cells = shown + (overflow > 0 ? 1 : 0);
  const rows = Math.max(1, Math.ceil(cells / columns));
  const gridBottom = STORY_GRID_START_Y + rows * rowHeight;
  const lastLineY = SHARE_CARD_HEIGHT - SHARE_URL_LAST_LINE_OFFSET;
  const urlTopLimit = gridBottom + 28;
  return {
    gridBottom,
    box: {
      maxWidth: SHARE_CARD_WIDTH - SHARE_CARD_SAFE_MARGIN * 2,
      maxHeight: Math.max(SHARE_URL_FONT_MAX * SHARE_URL_LINE_HEIGHT, lastLineY - urlTopLimit),
    },
  };
}

function tokenizeUrl(text: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (URL_BREAK_CHARS.has(ch)) {
      if (buf) tokens.push(buf);
      tokens.push(ch);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function longestPrefixThatFits(text: string, measure: (s: string) => number, maxWidth: number): number {
  if (text.length <= 1) return text.length;
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function wrapUrl(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
): string[] {
  if (measure(text) <= maxWidth) return [text];
  const lines: string[] = [];
  let current = '';
  for (const token of tokenizeUrl(text)) {
    const candidate = current + token;
    if (current && measure(candidate) > maxWidth) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
    while (current.length > 1 && measure(current) > maxWidth) {
      const take = longestPrefixThatFits(current, measure, maxWidth);
      lines.push(current.slice(0, take));
      current = current.slice(take);
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Fit a watch URL into a reserved footer box using actual text widths
 * (canvas.measureText or a test double). Prefers a larger single line,
 * then wraps on URL separators, then reduces font size. Never uses a
 * character-count heuristic.
 */
export function fitWatchUrl(
  url: string,
  measureText: (text: string, fontSize: number) => number,
  box: WatchUrlBox,
): WatchUrlLayout {
  const display = shortenWatchUrl(url);

  for (let fontSize = SHARE_URL_FONT_MAX; fontSize >= SHARE_URL_FONT_MIN; fontSize--) {
    const lineHeight = fontSize * SHARE_URL_LINE_HEIGHT;
    const maxLines = Math.max(1, Math.floor(box.maxHeight / lineHeight));
    const lines = wrapUrl(display, (text) => measureText(text, fontSize), box.maxWidth);
    const fits =
      lines.length <= maxLines &&
      lines.every((line) => measureText(line, fontSize) <= box.maxWidth + 0.5);
    if (fits) {
      return { fontSize, lines, truncated: false };
    }
  }

  const fontSize = SHARE_URL_FONT_MIN;
  const lineHeight = fontSize * SHARE_URL_LINE_HEIGHT;
  const maxLines = Math.max(1, Math.floor(box.maxHeight / lineHeight));
  const lines = wrapUrl(display, (text) => measureText(text, fontSize), box.maxWidth);
  if (
    lines.length <= maxLines &&
    lines.every((line) => measureText(line, fontSize) <= box.maxWidth + 0.5)
  ) {
    return { fontSize, lines, truncated: false };
  }

  const kept = lines.slice(0, maxLines);
  let last = kept[kept.length - 1] ?? '';
  const ellipsis = '…';
  while (last.length > 1 && measureText(last + ellipsis, fontSize) > box.maxWidth) {
    last = last.slice(0, -1);
  }
  kept[Math.max(0, kept.length - 1)] = `${last}${ellipsis}`;
  return {
    fontSize,
    lines: kept,
    truncated: true,
    fallbackReason:
      'URL exceeded the footer bounding box at the minimum legible font; last line ellipsized. Copy Watch URL still has the full link.',
  };
}

/** A slow/hanging avatar request must never block the whole card past this. */
const AVATAR_LOAD_TIMEOUT_MS = 4000;

/**
 * Loads a remote avatar for canvas drawing. `crossOrigin = 'anonymous'` is
 * what makes this safe: if the CDN doesn't answer with a permissive CORS
 * header, the browser fails the load (onerror) instead of drawing a tainted
 * image that would silently poison canvas.toBlob later — so a bad/blocked
 * avatar degrades to the initials placeholder rather than breaking the whole
 * download. No generic proxy here on purpose (see this module's own note on
 * why): only ever fetched directly from the URL a trusted status API gave us.
 * Bounded by AVATAR_LOAD_TIMEOUT_MS so one slow CDN response can't hang the
 * whole render — renderShareCard awaits every one of these in parallel.
 */
function loadAvatarImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(null), AVATAR_LOAD_TIMEOUT_MS);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/**
 * Draws the Watch Party story card (9:16, share-ready) onto an offscreen
 * canvas — the impure counterpart to buildShareCardData above. Not unit
 * tested: jsdom (this project's test environment) has no real <canvas> 2D
 * context, so getContext('2d') returns null there and this would only ever
 * exercise the early-return branch — see StreamToolbar.ts's live browser
 * verification instead for actual pixel-level checks. Brand colors here
 * intentionally duplicate main.css's tokens; see PROVIDER_BADGE's own note
 * above for why a canvas can't just read the CSS custom properties.
 */
export async function renderShareCard(
  canvas: HTMLCanvasElement,
  data: ShareCardData,
): Promise<boolean> {
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const bg = ctx.createLinearGradient(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  bg.addColorStop(0, '#0d0d0f');
  bg.addColorStop(1, '#1c1424');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f3f3f5';
  ctx.font = '700 44px system-ui, -apple-system, sans-serif';
  ctx.fillText('MultiStream.cc', STORY_CENTER_X, STORY_BRAND_BASELINE_Y);
  ctx.fillStyle = '#9b9ba8';
  ctx.font = '500 24px system-ui, -apple-system, sans-serif';
  ctx.fillText('A product of Design Delulu', STORY_CENTER_X, STORY_TAGLINE_BASELINE_Y);

  ctx.fillStyle = '#ff5d5d';
  roundedRectPath(ctx, STORY_PILL_X, STORY_PILL_Y, STORY_PILL_W, STORY_PILL_H, STORY_PILL_H / 2);
  ctx.fill();
  ctx.fillStyle = '#0d0d0f';
  ctx.font = '700 24px system-ui, -apple-system, sans-serif';
  ctx.fillText(data.liveNowLabel, STORY_PILL_X + STORY_PILL_W / 2, STORY_PILL_Y + STORY_PILL_H / 2 + 8);

  ctx.fillStyle = '#f3f3f5';
  ctx.font = '700 64px system-ui, -apple-system, sans-serif';
  wrapText(ctx, data.headline, STORY_CENTER_X, STORY_HEADLINE_BASELINE_Y, SHARE_CARD_WIDTH - 128, 74);

  ctx.fillStyle = '#9b9ba8';
  ctx.font = '500 32px system-ui, -apple-system, sans-serif';
  ctx.fillText(data.streamCountLabel, STORY_CENTER_X, STORY_COUNT_BASELINE_Y);

  const totalCount = data.entries.length;
  const roomy = totalCount <= ROOMY_TIER_MAX;
  const columns = roomy ? (totalCount <= 2 ? Math.max(totalCount, 1) : totalCount <= 4 ? 2 : 3) : 4;
  const cellSize = roomy ? (columns === 2 ? 320 : 280) : 190;
  const gap = roomy ? 40 : 24;
  const rowHeight = cellSize + (roomy ? STORY_ROOMY_ROW_EXTRA : STORY_COMPACT_ROW_EXTRA);
  const handleFontSize = roomy ? 30 : 22;
  const platformFontSize = roomy ? 24 : 18;
  const handleMaxChars = roomy ? 14 : 10;

  // >16 entries: show the first 15 plus one same-size "+N more" cell, rather
  // than silently dropping most of the lineup — see this module's tier
  // constants doc comment above.
  const shown = totalCount <= COMPACT_TIER_MAX ? data.entries : data.entries.slice(0, COMPACT_TIER_SHOWN_WITH_OVERFLOW);
  const overflow = totalCount - shown.length;
  const gridWidth = columns * cellSize + (columns - 1) * gap;
  const startX = (SHARE_CARD_WIDTH - gridWidth) / 2;
  const startY = STORY_GRID_START_Y;

  // Loaded in parallel up front — drawImage itself is synchronous, so every
  // avatar has to be a real (or null, on failure) HTMLImageElement before the
  // per-entry draw loop below runs.
  const avatarImages = await Promise.all(
    shown.map((entry) => (entry.avatarUrl ? loadAvatarImage(entry.avatarUrl) : Promise.resolve(null))),
  );

  ctx.textAlign = 'center';
  shown.forEach((entry, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const cx = startX + col * (cellSize + gap) + cellSize / 2;
    const cy = startY + row * rowHeight + cellSize / 2;
    const avatar = avatarImages[i];

    ctx.beginPath();
    ctx.arc(cx, cy, cellSize / 2, 0, Math.PI * 2);

    if (avatar) {
      ctx.save();
      ctx.clip();
      ctx.drawImage(avatar, cx - cellSize / 2, cy - cellSize / 2, cellSize, cellSize);
      ctx.restore();
    } else {
      ctx.fillStyle = entry.badgeColor;
      ctx.fill();

      ctx.fillStyle = '#0d0d0f';
      ctx.font = `700 ${Math.round(cellSize * 0.32)}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(entry.initials, cx, cy + 2);
      ctx.textBaseline = 'alphabetic';
    }

    ctx.fillStyle = '#f3f3f5';
    ctx.font = `600 ${handleFontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(truncate(entry.handle, handleMaxChars), cx, cy + cellSize / 2 + handleFontSize + 16);

    ctx.fillStyle = '#9b9ba8';
    ctx.font = `500 ${platformFontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(entry.platformLabel, cx, cy + cellSize / 2 + handleFontSize + platformFontSize + 24);
  });

  // The overflow marker is drawn as its own same-size circle cell, right
  // after the last real entry in grid order — an explicit, intentional-
  // looking summary (matches a real avatar's visual weight) rather than a
  // small caption line easy to miss underneath a dense grid.
  if (overflow > 0) {
    const i = shown.length;
    const col = i % columns;
    const row = Math.floor(i / columns);
    const cx = startX + col * (cellSize + gap) + cellSize / 2;
    const cy = startY + row * rowHeight + cellSize / 2;

    ctx.beginPath();
    ctx.arc(cx, cy, cellSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#3a3a42';
    ctx.fill();

    ctx.fillStyle = '#f3f3f5';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(cellSize * 0.26)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(`+${overflow}`, cx, cy - 8);
    ctx.font = `500 ${Math.round(cellSize * 0.13)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText('more', cx, cy + Math.round(cellSize * 0.2));
    ctx.textBaseline = 'alphabetic';
  }

  ctx.fillStyle = '#9b9ba8';
  ctx.textAlign = 'center';
  ctx.font = `500 ${STORY_CAPTION_FONT_SIZE}px system-ui, -apple-system, sans-serif`;
  ctx.fillText('Live streams shown at time of sharing', STORY_CENTER_X, STORY_CAPTION_BASELINE_Y);

  return true;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}
