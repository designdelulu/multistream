import { describe, expect, it } from 'vitest';
import {
  SHARE_CARD_SAFE_MARGIN,
  SHARE_CARD_WIDTH,
  SHARE_URL_FONT_MAX,
  SHARE_URL_FONT_MIN,
  STORY_BRAND_BASELINE_Y,
  STORY_CAPTION_BASELINE_Y,
  STORY_CAPTION_FONT_SIZE,
  STORY_CENTER_X,
  STORY_COMPACT_ROW_EXTRA,
  STORY_COUNT_BASELINE_Y,
  STORY_GRID_START_Y,
  STORY_HEADLINE_BASELINE_Y,
  STORY_PILL_W,
  STORY_PILL_X,
  STORY_PILL_Y,
  STORY_ROOMY_ROW_EXTRA,
  STORY_SAFE_TOP,
  STORY_TAGLINE_BASELINE_Y,
  buildShareCardData,
  fitWatchUrl,
  shareCardUrlBox,
} from './shareCard';
import { buildPathFromStreams } from '../platforms';
import type { StreamRef } from '../types';

describe('buildShareCardData', () => {
  it('produces one entry per stream, with a provider badge and initials derived from the display handle', () => {
    const streams: StreamRef[] = [
      { id: 'twitch:shroud', platform: 'twitch', channel: 'shroud', muted: true, orientation: 'landscape' },
      { id: 'kick:trainwreckstv', platform: 'kick', channel: 'trainwreckstv', muted: true, orientation: 'landscape' },
      {
        id: 'youtube:handle:pewdiepie',
        platform: 'youtube',
        channel: 'handle:pewdiepie',
        muted: true,
        orientation: 'landscape',
      },
      { id: 'tiktok:creator', platform: 'tiktok', channel: 'creator', muted: true, orientation: 'portrait' },
    ];

    const data = buildShareCardData(streams, 'https://multistream.cc/t:shroud');

    expect(data.watchUrl).toBe('https://multistream.cc/t:shroud');
    expect(data.streamCountLabel).toBe('4 streams');
    expect(data.entries).toEqual([
      { id: 'twitch:shroud', handle: 'shroud', initials: 'SH', platformLabel: 'Twitch', badgeColor: '#9146ff' },
      {
        id: 'kick:trainwreckstv',
        handle: 'trainwreckstv',
        initials: 'TR',
        platformLabel: 'Kick',
        badgeColor: '#53fc18',
      },
      {
        id: 'youtube:handle:pewdiepie',
        handle: '@pewdiepie',
        initials: 'PE',
        platformLabel: 'YouTube',
        badgeColor: '#ff0033',
      },
      {
        id: 'tiktok:creator',
        handle: 'creator',
        initials: 'CR',
        platformLabel: 'TikTok',
        badgeColor: '#fe2c55',
      },
    ]);
  });

  it('uses singular "1 stream" for exactly one stream', () => {
    const streams: StreamRef[] = [
      { id: 'twitch:a', platform: 'twitch', channel: 'a', muted: true, orientation: 'landscape' },
    ];
    expect(buildShareCardData(streams, 'https://multistream.cc/t:a').streamCountLabel).toBe('1 stream');
  });

  it('derives initials from a multi-word handle using the first letter of each of the first two words', () => {
    const streams: StreamRef[] = [
      { id: 'twitch:the_pro_gamer', platform: 'twitch', channel: 'the_pro_gamer', muted: true, orientation: 'landscape' },
    ];
    expect(buildShareCardData(streams, 'https://multistream.cc').entries[0].initials).toBe('TP');
  });

  it('passes through a provided avatar URL map, including TikTok', () => {
    const streams: StreamRef[] = [
      { id: 'twitch:shroud', platform: 'twitch', channel: 'shroud', muted: true, orientation: 'landscape' },
      { id: 'tiktok:creator', platform: 'tiktok', channel: 'creator', muted: true, orientation: 'portrait' },
    ];
    const avatars = new Map([
      ['twitch:shroud', 'https://static-cdn.jtvnw.net/shroud.png'],
      ['tiktok:creator', '/api/tiktok-avatar.php?u=creator'],
    ]);
    const data = buildShareCardData(streams, 'https://multistream.cc', avatars);
    expect(data.entries[0].avatarUrl).toBe('https://static-cdn.jtvnw.net/shroud.png');
    expect(data.entries[1].avatarUrl).toBe('/api/tiktok-avatar.php?u=creator');
  });

  it('uses cached creator avatars even when the lineup entries are otherwise unchanged', () => {
    const streams: StreamRef[] = [
      { id: 'twitch:shroud', platform: 'twitch', channel: 'shroud', muted: true, orientation: 'landscape' },
      { id: 'kick:deen', platform: 'kick', channel: 'deen', muted: true, orientation: 'landscape' },
      { id: 'youtube:handle:off', platform: 'youtube', channel: 'handle:off', muted: true, orientation: 'landscape' },
    ];
    const avatars = new Map([
      ['twitch:shroud', 'https://static-cdn.jtvnw.net/shroud.png'],
      ['kick:deen', 'https://files.kick.com/deen.webp'],
      ['youtube:handle:off', 'https://yt3.ggpht.com/off.jpg'],
    ]);
    const data = buildShareCardData(streams, 'https://multistream.cc', avatars);
    expect(data.entries.map((entry) => entry.avatarUrl)).toEqual([
      'https://static-cdn.jtvnw.net/shroud.png',
      'https://files.kick.com/deen.webp',
      'https://yt3.ggpht.com/off.jpg',
    ]);
  });
});

/**
 * Deterministic stand-in for canvas.measureText. 0.58em is a conservative
 * average for system-ui URL characters — slightly wider than typical, so
 * wrapping is not under-estimated relative to a real canvas.
 */
function measureUrl(text: string, fontSize: number): number {
  return text.length * fontSize * 0.58;
}

function twitchStreams(count: number): StreamRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `twitch:channel${i}`,
    platform: 'twitch' as const,
    channel: `channel${i}`,
    muted: true,
    orientation: 'landscape' as const,
  }));
}

function watchUrlFor(count: number): string {
  return `https://multistream.cc${buildPathFromStreams(twitchStreams(count))}`;
}

function assertFits(count: number): { fontSize: number; lineCount: number; truncated: boolean } {
  const url = watchUrlFor(count);
  const { box } = shareCardUrlBox(count);
  const layout = fitWatchUrl(url, measureUrl, box);
  expect(box.maxWidth).toBe(SHARE_CARD_WIDTH - SHARE_CARD_SAFE_MARGIN * 2);
  for (const line of layout.lines) {
    expect(measureUrl(line, layout.fontSize)).toBeLessThanOrEqual(box.maxWidth + 0.5);
  }
  expect(layout.lines.length * layout.fontSize * 1.28).toBeLessThanOrEqual(box.maxHeight + layout.fontSize);
  expect(layout.fontSize).toBeGreaterThanOrEqual(SHARE_URL_FONT_MIN);
  expect(layout.fontSize).toBeLessThanOrEqual(SHARE_URL_FONT_MAX);
  return { fontSize: layout.fontSize, lineCount: layout.lines.length, truncated: layout.truncated };
}

describe('fitWatchUrl', () => {
  it('keeps a 1-stream URL on one comfortable line', () => {
    const result = assertFits(1);
    expect(result.fontSize).toBe(SHARE_URL_FONT_MAX);
    expect(result.lineCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('fits a 5-stream URL inside the footer box', () => {
    const result = assertFits(5);
    expect(result.truncated).toBe(false);
    expect(result.lineCount).toBeGreaterThanOrEqual(1);
  });

  it('fits a 10-stream URL inside the footer box', () => {
    const result = assertFits(10);
    expect(result.truncated).toBe(false);
  });

  it('fits a 16-stream URL inside the footer box', () => {
    const result = assertFits(16);
    expect(result.truncated).toBe(false);
  });

  it('fits a >16-stream stress URL inside the footer box', () => {
    const result = assertFits(24);
    expect(result.truncated).toBe(false);
  });

  it('prefers wrapping at URL separators rather than mid-token when both would fit', () => {
    const url = 'https://multistream.cc/t:shroud/k:trainwreckstv/y:video:abcdefghijk';
    const layout = fitWatchUrl(url, measureUrl, { maxWidth: 280, maxHeight: 200 });
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.truncated).toBe(false);
    const joined = layout.lines.join('');
    expect(joined).toBe('multistream.cc/t:shroud/k:trainwreckstv/y:video:abcdefghijk');
    expect(layout.lines.some((line) => line.startsWith('/') || line.startsWith(':') || line.includes('/t:'))).toBe(
      true,
    );
  });

  it('does not silently truncate without a fallback reason when the URL cannot stay legible', () => {
    const huge = `https://multistream.cc/${'t:averylongchannelname'.repeat(80)}`;
    const layout = fitWatchUrl(huge, measureUrl, { maxWidth: 200, maxHeight: 40 });
    if (layout.truncated) {
      expect(layout.fallbackReason).toMatch(/ellipsized/i);
      expect(layout.lines.at(-1)).toMatch(/…$/);
    } else {
      for (const line of layout.lines) {
        expect(measureUrl(line, layout.fontSize)).toBeLessThanOrEqual(200.5);
      }
    }
  });
});

describe('story layout metrics', () => {
  it('centers the header block and LIVE NOW pill', () => {
    expect(STORY_CENTER_X).toBe(SHARE_CARD_WIDTH / 2);
    expect(STORY_PILL_X).toBe((SHARE_CARD_WIDTH - STORY_PILL_W) / 2);
  });

  it('keeps avatars at the same start Y and drops the top block into the Story viewport', () => {
    expect(STORY_SAFE_TOP).toBe(269);
    expect(STORY_GRID_START_Y).toBe(600);
    expect(STORY_BRAND_BASELINE_Y).toBe(320);
    expect(STORY_TAGLINE_BASELINE_Y).toBe(354);
    expect(STORY_PILL_Y).toBe(400);
    expect(STORY_HEADLINE_BASELINE_Y).toBe(528);
    expect(STORY_COUNT_BASELINE_Y).toBe(578);
    expect(STORY_GRID_START_Y - STORY_COUNT_BASELINE_Y).toBe(22);
    expect(STORY_COUNT_BASELINE_Y - STORY_HEADLINE_BASELINE_Y).toBe(50);
    expect(STORY_HEADLINE_BASELINE_Y - STORY_GRID_START_Y).toBeLessThan(0);
    expect(STORY_BRAND_BASELINE_Y - 44).toBeGreaterThanOrEqual(STORY_SAFE_TOP);
  });

  it('leaves at least 10px between a compact platform label and the next avatar', () => {
    const handleFontSize = 22;
    const platformFontSize = 18;
    const platformBelowAvatar = handleFontSize + platformFontSize + 24;
    const gap = STORY_COMPACT_ROW_EXTRA - platformBelowAvatar;
    expect(gap).toBeGreaterThanOrEqual(10);
    expect(STORY_ROOMY_ROW_EXTRA - (30 + 24 + 24)).toBeGreaterThanOrEqual(10);
  });

  it('doubles the disclosure caption and sits it above the old 1860 baseline', () => {
    expect(STORY_CAPTION_FONT_SIZE).toBe(44);
    expect(STORY_CAPTION_BASELINE_Y).toBe(1820);
  });

  it('uses the compact row extra in shareCardUrlBox geometry', () => {
    const { gridBottom } = shareCardUrlBox(13);
    const columns = 4;
    const cellSize = 190;
    const rows = Math.ceil(13 / columns);
    expect(gridBottom).toBe(STORY_GRID_START_Y + rows * (cellSize + STORY_COMPACT_ROW_EXTRA));
  });
});
