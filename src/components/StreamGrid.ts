import { isStackedStreamLayout } from '../lib/viewport';
import { getAdapter, buildEmbedUrl } from '../platforms';
import {
  createTwitchPlayer,
  destroyTwitchPlayer,
  hostElementId,
  setTwitchPlayerMuted,
  type TwitchPlayerInstance,
} from '../platforms/twitchPlayer';
import type { StreamRef } from '../types';
import type { StreamStore } from '../state/streams';

/**
 * Kick only mounts desktop chrome (volume, quality) when the iframe's layout
 * width is >= 769px. MultiTwitch-style optimize_size often makes cells smaller
 * than that — so Kick iframes are rendered at ≥769px and CSS-scaled down into
 * the cell. Kick sees a wide player; the grid still fits every stream on-screen.
 */
const MIN_KICK_VIEWPORT_WIDTH = 769;
/** Twitch docs: embedded windows must be at least 400×300 for reliable autoplay. */
const MIN_TWITCH_WIDTH = 400;
const MIN_TWITCH_HEIGHT = 300;
const GRID_GAP = 12;
const GRID_PADDING = 24;
const CARD_HEADER_HEIGHT = 42;

type FocusChangeHandler = (focused: boolean, streamId: string | null) => void;

let focusedStreamId: string | null = null;
let focusSessionActive = false;
let focusChangeHandler: FocusChangeHandler | null = null;
let escapeBound = false;
let layoutFrame = 0;
let layoutRetries = 0;
const MAX_LAYOUT_RETRIES = 8;

const twitchPlayers = new Map<string, TwitchPlayerInstance>();
const twitchMountInFlight = new Set<string>();

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

function isBlankIframeSrc(src: string): boolean {
  return !src || src === 'about:blank' || src.endsWith('about:blank');
}

function applyKickAllowPolicy(iframe: HTMLIFrameElement, muted: boolean): void {
  // Unmuted Kick needs allow=autoplay after a user gesture (focus click).
  // Muted Kick omits it so the browser blocks accidental unmuted audio.
  iframe.setAttribute(
    'allow',
    muted ? 'fullscreen; picture-in-picture' : 'autoplay; fullscreen; picture-in-picture',
  );
}

function twitchHost(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>('.stream-card__twitch-host');
}

function kickIframe(card: HTMLElement): HTMLIFrameElement | null {
  return card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
}

function destroyTwitchCardPlayer(card: HTMLElement): void {
  const streamId = card.dataset.streamId;
  if (!streamId) return;
  twitchPlayers.delete(streamId);
  twitchMountInFlight.delete(streamId);
  const host = twitchHost(card);
  if (host) {
    destroyTwitchPlayer(host);
  }
}

async function mountTwitchCard(card: HTMLElement, muted: boolean): Promise<void> {
  const streamId = card.dataset.streamId;
  const channel = card.dataset.channel;
  const host = twitchHost(card);
  if (!streamId || !channel || !host) return;
  if (card.dataset.tabFrozen === '1') return;
  if (twitchMountInFlight.has(streamId)) return;

  const existing = twitchPlayers.get(streamId);
  if (existing) {
    setTwitchPlayerMuted(existing, muted);
    card.dataset.embedMuted = muted ? '1' : '0';
    delete card.dataset.focusFrozen;
    return;
  }

  const rect = host.getBoundingClientRect();
  // Wait until layout has given the host real size (avoids Twitch autoplay
  // failing on a 0×0 first paint). Prefer docs minimum; still mount if smaller
  // once width/height are non-zero so chat-open grids keep working.
  if (rect.width <= 0 || rect.height <= 0) {
    card.dataset.twitchPending = '1';
    return;
  }

  card.dataset.twitchPending = '1';
  twitchMountInFlight.add(streamId);

  try {
    // Remounts assign a unique id; first mounts use the stable host id.
    if (!host.id) {
      host.id = hostElementId(streamId);
    }
    const player = await createTwitchPlayer(host, channel, muted);
    if (!player) return;
    // Card may have been removed while the script loaded.
    if (!card.isConnected || card.dataset.streamId !== streamId) {
      destroyTwitchPlayer(host);
      return;
    }
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') {
      destroyTwitchPlayer(host);
      return;
    }
    twitchPlayers.set(streamId, player);
    card.dataset.embedMuted = muted ? '1' : '0';
    delete card.dataset.focusFrozen;
    delete card.dataset.twitchPending;
  } finally {
    twitchMountInFlight.delete(streamId);
  }
}

function mountKickIframe(card: HTMLElement, muted: boolean): void {
  const iframe = kickIframe(card);
  const channel = card.dataset.channel;
  if (!iframe || !channel) return;
  if (iframe.dataset.tabFrozen === '1') return;

  applyKickAllowPolicy(iframe, muted);

  const nextSrc = buildEmbedUrl(
    { platform: 'kick', channel },
    muted,
    { autoplay: true },
  );

  delete iframe.dataset.focusFrozen;
  iframe.dataset.embedMuted = muted ? '1' : '0';
  card.dataset.embedMuted = muted ? '1' : '0';

  if (!isBlankIframeSrc(iframe.src)) {
    try {
      if (new URL(iframe.src).href === new URL(nextSrc).href) {
        return;
      }
    } catch {
      // Fall through to assign src.
    }
  }

  iframe.src = nextSrc;
}

function mountStreamMedia(card: HTMLElement, muted: boolean): void {
  if (card.dataset.platform === 'twitch') {
    void mountTwitchCard(card, muted);
    return;
  }
  if (card.dataset.platform === 'kick') {
    mountKickIframe(card, muted);
  }
}

/** After grid sizing settles, mount any Twitch hosts that were waiting for dimensions. */
function mountPendingTwitchPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card[data-platform="twitch"]')) {
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    const streamId = card.dataset.streamId;
    if (!streamId || twitchPlayers.has(streamId) || twitchMountInFlight.has(streamId)) continue;

    const host = twitchHost(card);
    if (!host) continue;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const muted = card.dataset.embedMuted !== '0';
    const meetsDocsMin =
      rect.width >= MIN_TWITCH_WIDTH && rect.height >= MIN_TWITCH_HEIGHT;
    // Mount when docs minimum is met, or when we already marked pending after layout.
    if (meetsDocsMin || card.dataset.twitchPending === '1' || rect.width >= 200) {
      void mountTwitchCard(card, muted);
    } else {
      card.dataset.twitchPending = '1';
    }
  }
}

/** Unload streams hidden by focus mode (Twitch pauses; Kick keeps playing audio). */
function freezeFocusHiddenPlayers(container: HTMLElement, focusedId: string): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.streamId === focusedId) continue;
    if (card.dataset.focusFrozen === '1') continue;

    card.dataset.focusFrozen = '1';
    card.dataset.embedMuted = '1';

    if (card.dataset.platform === 'twitch') {
      destroyTwitchCardPlayer(card);
      continue;
    }

    const iframe = kickIframe(card);
    if (!iframe || iframe.dataset.tabFrozen === '1') continue;
    iframe.dataset.focusFrozen = '1';
    iframe.dataset.embedMuted = '1';
    iframe.src = 'about:blank';
  }
}

/** Reload streams that were unloaded while another stream was focused. */
function resumeFocusHiddenPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.focusFrozen !== '1') continue;
    delete card.dataset.focusFrozen;
    if (card.dataset.platform === 'twitch') {
      card.dataset.twitchPending = '1';
    }
    mountStreamMedia(card, true);
  }
}

function syncFocusPlayers(container: HTMLElement, prevFocusedId: string | null): void {
  if (focusedStreamId) {
    focusSessionActive = true;

    const focusedCard = container.querySelector<HTMLElement>(
      `.stream-card[data-stream-id="${CSS.escape(focusedStreamId)}"]`,
    );
    // Focus click is a user gesture — unmute via API when possible.
    if (focusedCard) {
      const streamId = focusedCard.dataset.streamId;
      const twitch = streamId ? twitchPlayers.get(streamId) : undefined;
      if (twitch) {
        setTwitchPlayerMuted(twitch, false);
        focusedCard.dataset.embedMuted = '0';
      } else {
        mountStreamMedia(focusedCard, false);
      }
    }
    freezeFocusHiddenPlayers(container, focusedStreamId);
    return;
  }

  if (prevFocusedId === null || !focusSessionActive) {
    return;
  }

  focusSessionActive = false;
  resumeFocusHiddenPlayers(container);

  // Remount muted so Twitch starts again after an unmuted focus session.
  // setMuted(true) alone often leaves the player paused.
  const prevFocusedCard = container.querySelector<HTMLElement>(
    `.stream-card[data-stream-id="${CSS.escape(prevFocusedId)}"]`,
  );
  if (prevFocusedCard) {
    if (prevFocusedCard.dataset.platform === 'twitch') {
      destroyTwitchCardPlayer(prevFocusedCard);
      prevFocusedCard.dataset.twitchPending = '1';
    }
    mountStreamMedia(prevFocusedCard, true);
  }
}

function syncFocusDom(container: HTMLElement): void {
  const cards = container.querySelectorAll<HTMLElement>('.stream-card');
  if (focusedStreamId) {
    container.dataset.focusId = focusedStreamId;
  } else {
    delete container.dataset.focusId;
  }
  document.documentElement.classList.toggle('stream-focused', focusedStreamId !== null);

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

    const dragHandle = card.querySelector<HTMLButtonElement>('.stream-card__drag-handle');
    if (dragHandle) {
      dragHandle.hidden = focusedStreamId !== null;
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

export function setFocusedStream(container: HTMLElement, streamId: string | null): void {
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

export function toggleStreamFocus(container: HTMLElement, streamId: string): void {
  if (focusedStreamId === streamId) {
    setFocusedStream(container, null);
    return;
  }
  setFocusedStream(container, streamId);
}

export function getFocusedStreamId(): string | null {
  return focusedStreamId;
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
  card.dataset.embedMuted = '1';

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

  if (stream.platform === 'kick') {
    const iframe = document.createElement('iframe');
    iframe.className = 'stream-card__iframe';
    iframe.allowFullscreen = true;
    iframe.title = `${adapter.label} stream: ${stream.channel}`;
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    // Kick ignores muted=true once the page has autoplay permission. Omit
    // allow=autoplay so the browser blocks unmuted audio. credentialless
    // avoids Kick restoring a prior unmuted volume from iframe storage.
    applyKickAllowPolicy(iframe, true);
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
    const host = document.createElement('div');
    host.className = 'stream-card__twitch-host';
    host.id = hostElementId(stream.id);
    host.dataset.twitchHost = '1';
    player.append(host);
    card.dataset.twitchPending = '1';
  }

  const dragHandle = document.createElement('button');
  dragHandle.type = 'button';
  dragHandle.className = 'stream-card__drag-handle';
  dragHandle.title = 'Drag to reorder';
  dragHandle.setAttribute('aria-label', 'Drag to reorder');
  dragHandle.innerHTML =
    '<span aria-hidden="true">⠿</span> drag to reorder';
  player.append(dragHandle);

  card.append(header, player);

  if (document.hidden) {
    card.dataset.tabFrozen = '1';
  } else if (stream.platform === 'kick') {
    mountKickIframe(card, true);
  }
  // Twitch mounts after updateGridLayout once the host has real dimensions.

  return card;
}

function recreateTwitchHost(card: HTMLElement): HTMLElement | null {
  const previous = twitchHost(card);
  const player = card.querySelector('.stream-card__player');
  if (!player) return null;

  const host = document.createElement('div');
  host.className = 'stream-card__twitch-host';
  host.dataset.twitchHost = '1';

  if (previous) {
    previous.replaceWith(host);
  } else {
    player.append(host);
  }
  return host;
}

/**
 * Nudge play() on mounted Twitch players, or mount if missing.
 * Used when hiding headers so we don't destroy living playback.
 */
export function nudgeTwitchPlay(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card[data-platform="twitch"]')) {
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    const streamId = card.dataset.streamId;
    if (!streamId) continue;
    const shouldUnmute = focusedStreamId !== null && streamId === focusedStreamId;
    const existing = twitchPlayers.get(streamId);
    if (existing) {
      setTwitchPlayerMuted(existing, !shouldUnmute);
      card.dataset.embedMuted = shouldUnmute ? '0' : '1';
      continue;
    }
    card.dataset.twitchPending = '1';
    card.dataset.embedMuted = shouldUnmute ? '0' : '1';
    void mountTwitchCard(card, !shouldUnmute);
  }
}

/**
 * Destroy and remount every visible Twitch player.
 * Used after header toggles / full-width boots so muted autoplay can succeed.
 */
export function remountTwitchPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card[data-platform="twitch"]')) {
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;

    const streamId = card.dataset.streamId;
    if (!streamId) continue;

    const shouldUnmute = focusedStreamId !== null && streamId === focusedStreamId;

    destroyTwitchCardPlayer(card);
    const host = recreateTwitchHost(card);
    if (!host) continue;

    host.id = `${hostElementId(streamId)}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    card.dataset.twitchPending = '1';
    card.dataset.embedMuted = shouldUnmute ? '0' : '1';
    void mountTwitchCard(card, !shouldUnmute);
  }
}

/** Stop all stream embeds (Kick ignores tab backgrounding and keeps playing audio). */
export function freezeStreamPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.tabFrozen === '1') continue;
    card.dataset.tabFrozen = '1';

    if (card.dataset.platform === 'twitch') {
      destroyTwitchCardPlayer(card);
      continue;
    }

    const iframe = kickIframe(card);
    if (!iframe) continue;
    iframe.dataset.tabFrozen = '1';
    iframe.src = 'about:blank';
  }
}

/** Reload muted embeds after the tab is visible again. */
export function resumeStreamPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.tabFrozen !== '1') continue;
    delete card.dataset.tabFrozen;

    const iframe = kickIframe(card);
    if (iframe) {
      delete iframe.dataset.tabFrozen;
    }

    const shouldUnmute =
      focusedStreamId !== null && card.dataset.streamId === focusedStreamId;
    if (card.dataset.platform === 'twitch') {
      card.dataset.twitchPending = '1';
    }
    mountStreamMedia(card, !shouldUnmute);
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

  const seenIds = new Set<string>();
  for (const card of [...container.querySelectorAll<HTMLElement>('.stream-card')]) {
    const id = card.dataset.streamId ?? '';
    if (!id || !nextIds.has(id) || seenIds.has(id)) {
      if (card.dataset.platform === 'twitch') {
        destroyTwitchCardPlayer(card);
      }
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
    syncFocusPlayers(container, prevFocusedId);
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
 * do not remount players (keeps Twitch playing across chat toggles).
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
    mountPendingTwitchPlayers(container);
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

  const headerHeight = document.documentElement.classList.contains('headers-hidden')
    ? 0
    : CARD_HEADER_HEIGHT;

  for (let columns = 1; columns <= Math.min(count, 4); columns += 1) {
    const rows = Math.ceil(count / columns);
    let maxWidth = Math.floor((areaWidth - GRID_GAP * (columns - 1)) / columns);
    let maxHeight =
      Math.floor((areaHeight - GRID_GAP * (rows - 1)) / rows) - headerHeight;

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
    mountPendingTwitchPlayers(container);
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

  mountPendingTwitchPlayers(container);
}
