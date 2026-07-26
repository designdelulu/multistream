import { isStackedStreamLayout } from '../lib/viewport';
import { getAdapter, buildEmbedUrl } from '../platforms';
import type { Platform, StreamRef } from '../types';
import type { StreamStore } from '../state/streams';

/**
 * Kick only mounts desktop chrome (volume, quality) when the iframe's layout
 * width is >= 769px. MultiTwitch-style optimize_size often makes cells smaller
 * than that — so Kick iframes are rendered at ≥769px and CSS-scaled down into
 * the cell. Kick sees a wide player; the grid still fits every stream on-screen.
 */
const MIN_KICK_VIEWPORT_WIDTH = 769;
const GRID_GAP = 12;
const GRID_PADDING = 24;
const CARD_HEADER_HEIGHT = 42;

function clearLayoutVars(container: HTMLElement): void {
  container.style.removeProperty('--grid-columns');
  container.style.removeProperty('--player-height');
  container.style.removeProperty('--player-width');
  container.style.removeProperty('--kick-col-min');
  container.style.removeProperty('--kick-render-width');
  container.style.removeProperty('--kick-scale');
}

function setKickScaleVars(container: HTMLElement, cellWidth: number): void {
  const renderWidth = Math.max(MIN_KICK_VIEWPORT_WIDTH, Math.floor(cellWidth));
  const scale = cellWidth / renderWidth;
  container.style.setProperty('--kick-render-width', `${renderWidth}px`);
  container.style.setProperty('--kick-scale', String(scale));
  container.style.setProperty('--kick-col-min', `${Math.floor(cellWidth)}px`);
}

function createPlayerElement(stream: StreamRef, store: StreamStore): HTMLElement {
  const adapter = getAdapter(stream.platform);

  const card = document.createElement('article');
  card.className = `stream-card stream-card--${stream.platform}`;
  card.dataset.streamId = stream.id;
  card.dataset.platform = stream.platform;
  card.dataset.channel = stream.channel;

  const header = document.createElement('div');
  header.className = 'stream-card__header';

  const badge = document.createElement('span');
  badge.className = `stream-card__badge stream-card__badge--${stream.platform}`;
  badge.textContent = adapter.label;

  const title = document.createElement('span');
  title.className = 'stream-card__title';
  title.textContent = adapter.displayName(stream);

  const controls = document.createElement('div');
  controls.className = 'stream-card__controls';

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'stream-card__btn stream-card__btn--danger';
  removeButton.title = 'Remove stream';
  removeButton.setAttribute('aria-label', 'Remove stream');
  removeButton.textContent = 'Remove';
  removeButton.addEventListener('click', () => store.removeStream(stream.id));

  controls.append(removeButton);
  header.append(badge, title, controls);

  const player = document.createElement('div');
  player.className = 'stream-card__player';

  const iframe = document.createElement('iframe');
  iframe.className = 'stream-card__iframe';
  iframe.allowFullscreen = true;
  iframe.title = `${adapter.label} stream: ${stream.channel}`;
  iframe.referrerPolicy = 'no-referrer-when-downgrade';

  if (stream.platform === 'kick') {
    // Kick ignores muted=true once the page has autoplay permission. Omit
    // allow=autoplay so the browser blocks unmuted audio. credentialless
    // avoids Kick restoring a prior unmuted volume from iframe storage.
    iframe.setAttribute('allow', 'fullscreen; picture-in-picture');
    iframe.setAttribute('credentialless', '');
    try {
      (iframe as HTMLIFrameElement & { credentialless?: boolean }).credentialless = true;
    } catch {
      // Older browsers ignore this.
    }

    const kickFrame = document.createElement('div');
    kickFrame.className = 'stream-card__kick-frame';
    kickFrame.append(iframe);
    player.append(kickFrame);
  } else {
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    player.append(iframe);
  }

  // Kick keeps playing in background tabs; unload while hidden (Twitch pauses itself).
  if (document.hidden) {
    iframe.dataset.tabFrozen = '1';
    iframe.src = 'about:blank';
  } else {
    iframe.src = buildEmbedUrl(stream, true, {
      autoplay: stream.platform === 'kick' ? true : undefined,
    });
  }

  card.append(header, player);
  return card;
}

/** Stop all stream embeds (Kick ignores tab backgrounding and keeps playing audio). */
export function freezeStreamPlayers(container: HTMLElement): void {
  for (const iframe of container.querySelectorAll<HTMLIFrameElement>('.stream-card__iframe')) {
    if (iframe.dataset.tabFrozen === '1') continue;
    iframe.dataset.tabFrozen = '1';
    iframe.src = 'about:blank';
  }
}

/** Reload muted embeds after the tab is visible again. */
export function resumeStreamPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
    const platform = card.dataset.platform as Platform | undefined;
    const channel = card.dataset.channel;
    if (!iframe || !platform || !channel) continue;
    if (iframe.dataset.tabFrozen !== '1') continue;

    delete iframe.dataset.tabFrozen;
    iframe.src = buildEmbedUrl(
      { platform, channel },
      true,
      platform === 'kick' ? { autoplay: true } : undefined,
    );
  }
}

export function bindTabVisibilityPlayers(container: HTMLElement): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      freezeStreamPlayers(container);
    } else {
      resumeStreamPlayers(container);
    }
  });
}

export function syncStreamGrid(container: HTMLElement, store: StreamStore): void {
  const streams = store.getStreams();
  const existing = new Map(
    Array.from(container.querySelectorAll<HTMLElement>('.stream-card')).map((card) => [
      card.dataset.streamId ?? '',
      card,
    ]),
  );

  const nextIds = new Set(streams.map((stream) => stream.id));
  for (const [id, card] of existing) {
    if (!nextIds.has(id)) {
      card.remove();
      existing.delete(id);
    }
  }

  for (const stream of streams) {
    let card = existing.get(stream.id);
    if (!card) {
      card = createPlayerElement(stream, store);
      existing.set(stream.id, card);
    }
    container.append(card);
  }

  container.dataset.count = String(streams.length);
  container.dataset.hasKick = streams.some((stream) => stream.platform === 'kick')
    ? '1'
    : '0';
}

/**
 * Port of MultiTwitch optimize_size: choose columns/size so every player
 * fits in the streams pane at the largest possible 16:9 size. Resize only —
 * do not remount iframes (keeps Twitch playing across chat toggles).
 */
export function updateGridLayout(container: HTMLElement): void {
  const count = Number(container.dataset.count ?? '0');
  if (count === 0) {
    clearLayoutVars(container);
    return;
  }

  const streamArea = container.closest('.stream-area');
  if (!streamArea) {
    clearLayoutVars(container);
    return;
  }

  const hasKick = container.dataset.hasKick === '1';
  const areaWidth = streamArea.clientWidth - GRID_PADDING;

  if (isStackedStreamLayout()) {
    // Phone: natural 16:9 stack (CSS). Still set Kick scale from column width.
    container.style.setProperty('--grid-columns', '1');
    container.style.removeProperty('--player-height');
    container.style.removeProperty('--player-width');
    if (hasKick && areaWidth > 0) {
      setKickScaleVars(container, areaWidth);
    } else {
      container.style.removeProperty('--kick-col-min');
      container.style.removeProperty('--kick-render-width');
      container.style.removeProperty('--kick-scale');
    }
    return;
  }

  const areaHeight = streamArea.clientHeight - GRID_PADDING;

  if (areaWidth <= 0 || areaHeight <= 0) {
    return;
  }

  let bestColumns = 1;
  let bestWidth = 0;
  let bestHeight = 0;

  for (let columns = 1; columns <= Math.min(count, 4); columns += 1) {
    const rows = Math.ceil(count / columns);
    let maxWidth = Math.floor((areaWidth - GRID_GAP * (columns - 1)) / columns);
    let maxHeight =
      Math.floor((areaHeight - GRID_GAP * (rows - 1)) / rows) - CARD_HEADER_HEIGHT;

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

  if (bestWidth <= 0 || bestHeight <= 0) {
    container.style.setProperty('--grid-columns', '1');
    container.style.removeProperty('--player-height');
    container.style.removeProperty('--player-width');
    return;
  }

  container.style.setProperty('--grid-columns', String(bestColumns));
  container.style.setProperty('--player-width', `${Math.floor(bestWidth)}px`);
  container.style.setProperty('--player-height', `${Math.floor(bestHeight)}px`);

  if (hasKick) {
    setKickScaleVars(container, bestWidth);
  } else {
    container.style.removeProperty('--kick-col-min');
    container.style.removeProperty('--kick-render-width');
    container.style.removeProperty('--kick-scale');
  }
}
