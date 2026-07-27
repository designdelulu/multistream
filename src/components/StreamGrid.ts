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

type FocusChangeHandler = (focused: boolean, streamId: string | null) => void;

let focusedStreamId: string | null = null;
let focusChangeHandler: FocusChangeHandler | null = null;
let escapeBound = false;
let layoutFrame = 0;
let layoutRetries = 0;
const MAX_LAYOUT_RETRIES = 8;

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

function reloadStreamIframe(card: HTMLElement): void {
  const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
  const platform = card.dataset.platform as Platform | undefined;
  const channel = card.dataset.channel;
  if (!iframe || !platform || !channel) return;
  if (iframe.dataset.tabFrozen === '1') return;

  delete iframe.dataset.focusFrozen;
  iframe.src = buildEmbedUrl(
    { platform, channel },
    true,
    platform === 'kick' ? { autoplay: true } : undefined,
  );
}

/** Unload streams hidden by focus mode (Twitch pauses; Kick keeps playing audio). */
function freezeFocusHiddenPlayers(container: HTMLElement, focusedId: string): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.streamId === focusedId) continue;

    const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
    if (!iframe || iframe.dataset.tabFrozen === '1' || iframe.dataset.focusFrozen === '1') continue;

    iframe.dataset.focusFrozen = '1';
    iframe.src = 'about:blank';
  }
}

/** Reload streams that were unloaded while another stream was focused. */
function resumeFocusHiddenPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
    if (!iframe || iframe.dataset.focusFrozen !== '1') continue;
    reloadStreamIframe(card);
  }
}

function syncFocusPlayers(container: HTMLElement, prevFocusedId: string | null): void {
  if (focusedStreamId) {
    const focusedCard = container.querySelector<HTMLElement>(
      `.stream-card[data-stream-id="${CSS.escape(focusedStreamId)}"]`,
    );
    const focusedIframe = focusedCard?.querySelector<HTMLIFrameElement>('.stream-card__iframe');
    if (focusedCard && focusedIframe?.dataset.focusFrozen === '1') {
      reloadStreamIframe(focusedCard);
    }
    freezeFocusHiddenPlayers(container, focusedStreamId);
    return;
  }

  if (prevFocusedId === null) return;

  resumeFocusHiddenPlayers(container);

  const prevFocusedCard = container.querySelector<HTMLElement>(
    `.stream-card[data-stream-id="${CSS.escape(prevFocusedId)}"]`,
  );
  if (prevFocusedCard?.dataset.platform === 'twitch') {
    reloadStreamIframe(prevFocusedCard);
  }
}

function syncFocusDom(container: HTMLElement): void {
  const cards = container.querySelectorAll<HTMLElement>('.stream-card');
  if (focusedStreamId) {
    container.dataset.focusId = focusedStreamId;
  } else {
    delete container.dataset.focusId;
  }

  for (const card of cards) {
    const isFocused = card.dataset.streamId === focusedStreamId;
    card.classList.toggle('is-focused', isFocused);

    const focusButton = card.querySelector<HTMLButtonElement>('.stream-card__focus');
    if (focusButton) {
      focusButton.hidden = isFocused;
      focusButton.setAttribute('aria-pressed', isFocused ? 'true' : 'false');
      focusButton.title = 'Focus stream';
      focusButton.setAttribute('aria-label', 'Focus stream in browser window');
    }

    const closeButton = card.querySelector<HTMLButtonElement>('.stream-card__close');
    if (closeButton) {
      if (isFocused) {
        closeButton.title = 'Minimize';
        closeButton.setAttribute('aria-label', 'Minimize focused stream');
      } else {
        closeButton.title = 'Remove stream';
        closeButton.setAttribute('aria-label', 'Remove stream');
      }
    }
  }
}

function scheduleGridLayout(container: HTMLElement): void {
  layoutRetries = 0;
  if (layoutFrame) {
    cancelAnimationFrame(layoutFrame);
  }
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      updateGridLayout(container);
    });
  });
}

function notifyFocusChange(prevFocusedId: string | null): void {
  const isFocused = focusedStreamId !== null;
  if (!isFocused && prevFocusedId !== null) {
    focusChangeHandler?.(false, null);
    return;
  }
  if (isFocused && focusedStreamId) {
    focusChangeHandler?.(true, focusedStreamId);
  }
}

function setFocusedStream(container: HTMLElement, streamId: string | null): void {
  const prevFocusedId = focusedStreamId;
  focusedStreamId = streamId;
  syncFocusDom(container);
  syncFocusPlayers(container, prevFocusedId);

  const focusChanged =
    (prevFocusedId === null) !== (focusedStreamId === null) ||
    (focusedStreamId !== null && prevFocusedId !== focusedStreamId);

  if (focusChanged) {
    notifyFocusChange(prevFocusedId);
  }

  scheduleGridLayout(container);
}

function toggleStreamFocus(container: HTMLElement, streamId: string): void {
  if (focusedStreamId === streamId) {
    setFocusedStream(container, null);
    return;
  }
  setFocusedStream(container, streamId);
}

function handleFocusEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !focusedStreamId) return;
  const container = document.querySelector<HTMLElement>('#stream-grid');
  if (!container) return;
  setFocusedStream(container, null);
}

function bindFocusEscape(): void {
  if (escapeBound) return;
  document.addEventListener('keydown', handleFocusEscape);
  escapeBound = true;
}

function createPlayerElement(
  stream: StreamRef,
  store: StreamStore,
  container: HTMLElement,
): HTMLElement {
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

  const focusButton = document.createElement('button');
  focusButton.type = 'button';
  focusButton.className = 'stream-card__focus';
  focusButton.title = 'Focus stream';
  focusButton.setAttribute('aria-label', 'Focus stream in browser window');
  focusButton.setAttribute('aria-pressed', 'false');
  focusButton.innerHTML =
    '<span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 5V1.5H5M9 1.5H12.5V5M12.5 9V12.5H9M5 12.5H1.5V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  focusButton.addEventListener('click', () => toggleStreamFocus(container, stream.id));

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'stream-card__close';
  removeButton.title = 'Remove stream';
  removeButton.setAttribute('aria-label', 'Remove stream');
  removeButton.innerHTML = '<span aria-hidden="true">×</span>';
  removeButton.addEventListener('click', () => {
    if (focusedStreamId === stream.id) {
      setFocusedStream(container, null);
      return;
    }
    store.removeStream(stream.id);
  });

  controls.append(focusButton, removeButton);
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

export function bindStreamFocus(handler: FocusChangeHandler): void {
  focusChangeHandler = handler;
  bindFocusEscape();
}

export function isStreamFocused(): boolean {
  return focusedStreamId !== null;
}

export function syncStreamGrid(container: HTMLElement, store: StreamStore): void {
  const streams = store.getStreams();
  const nextIds = new Set(streams.map((stream) => stream.id));

  // Drop stale/duplicate cards so hidden focus-mode streams cannot orphan in the DOM.
  const seenIds = new Set<string>();
  for (const card of [...container.querySelectorAll<HTMLElement>('.stream-card')]) {
    const id = card.dataset.streamId ?? '';
    if (!id || !nextIds.has(id) || seenIds.has(id)) {
      card.remove();
      continue;
    }
    seenIds.add(id);
  }

  const existing = new Map(
    Array.from(container.querySelectorAll<HTMLElement>('.stream-card')).map((card) => [
      card.dataset.streamId ?? '',
      card,
    ]),
  );

  if (focusedStreamId && !nextIds.has(focusedStreamId)) {
    const prevFocusedId = focusedStreamId;
    focusedStreamId = null;
    syncFocusDom(container);
    notifyFocusChange(prevFocusedId);
    scheduleGridLayout(container);
  }

  for (const stream of streams) {
    let card = existing.get(stream.id);
    if (!card) {
      card = createPlayerElement(stream, store, container);
      existing.set(stream.id, card);
    }
    container.append(card);
  }

  container.dataset.count = String(streams.length);
  container.dataset.hasKick = streams.some((stream) => stream.platform === 'kick')
    ? '1'
    : '0';

  syncFocusDom(container);
}

/**
 * Port of MultiTwitch optimize_size: choose columns/size so every player
 * fits in the streams pane at the largest possible 16:9 size. Resize only —
 * do not remount iframes (keeps Twitch playing across chat toggles).
 */
export function updateGridLayout(container: HTMLElement): void {
  const totalCount = Number(container.dataset.count ?? '0');
  if (totalCount === 0) {
    clearLayoutVars(container);
    return;
  }

  const streamArea = container.closest('.stream-area');
  if (!streamArea) {
    clearLayoutVars(container);
    return;
  }

  const count = focusedStreamId ? 1 : totalCount;
  const hasKick =
    focusedStreamId !== null
      ? container.querySelector<HTMLElement>(`.stream-card[data-stream-id="${focusedStreamId}"]`)
          ?.dataset.platform === 'kick'
      : container.dataset.hasKick === '1';
  const areaWidth = streamArea.clientWidth - GRID_PADDING;

  if (isStackedStreamLayout() && !focusedStreamId) {
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
    if (layoutRetries < MAX_LAYOUT_RETRIES) {
      layoutRetries += 1;
      requestAnimationFrame(() => updateGridLayout(container));
    }
    return;
  }

  layoutRetries = 0;

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
