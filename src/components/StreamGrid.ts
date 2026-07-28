import { embedDebugEnabled, logEmbedEvent } from '../lib/embedDebug';
import { isStackedStreamLayout } from '../lib/viewport';
import { getAdapter, buildEmbedUrl } from '../platforms';
import type { StreamRef } from '../types';
import type { StreamStore } from '../state/streams';

/**
 * Kick only mounts desktop chrome (volume, quality) when the iframe's layout
 * width is >= 769px. MultiTwitch-style optimize_size often makes cells smaller
 * than that — so Kick iframes are rendered at ≥769px and CSS-scaled down into
 * the cell. Kick sees a wide player; the grid still fits every stream on-screen.
 *
 * Twitch Requirement 1.3: never obscure the embed. Headers-hidden keeps the
 * video alone at rest; on card hover the player shrinks and a toolbar opens
 * BELOW the iframe (not over it). Kick re-scales on hover so bottom chrome
 * still fits. No mouseleave remount — entering the iframe fires leave on the
 * parent and would reload mute controls in a loop.
 */
const MIN_KICK_VIEWPORT_WIDTH = 769;
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

function streamIframe(card: HTMLElement): HTMLIFrameElement | null {
  return card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
}

/** Per-card mute preference stored on the card DOM (survives blank/remount). */
function preferredMuted(card: HTMLElement): boolean {
  return card.dataset.embedMuted !== '0';
}

function mountTwitchIframe(
  card: HTMLElement,
  muted: boolean,
  reason: 'mount' | 'tab-resume' | 'focus-resume' | 'focus-unmute' = 'mount',
): void {
  const iframe = streamIframe(card);
  const channel = card.dataset.channel;
  if (!iframe || !channel) return;
  if (iframe.dataset.tabFrozen === '1') return;

  const nextSrc = buildEmbedUrl({ platform: 'twitch', channel }, muted, { autoplay: true });

  delete iframe.dataset.focusFrozen;
  iframe.dataset.embedMuted = muted ? '1' : '0';
  card.dataset.embedMuted = muted ? '1' : '0';

  if (!isBlankIframeSrc(iframe.src)) {
    try {
      if (new URL(iframe.src).href === new URL(nextSrc).href) {
        if (embedDebugEnabled) {
          logEmbedEvent(reason, {
            platform: 'twitch',
            channel,
            action: 'skip-same-url',
            muted,
            card,
          });
        }
        return;
      }
    } catch {
      // Fall through to assign src.
    }
  }

  logEmbedEvent(reason, {
    platform: 'twitch',
    channel,
    action: 'src',
    muted,
    card,
  });
  iframe.src = nextSrc;
}

function mountTwitchIframeForced(
  card: HTMLElement,
  muted: boolean,
  reason: 'headers-recover' | 'watchdog' = 'headers-recover',
): void {
  const iframe = streamIframe(card);
  const channel = card.dataset.channel;
  if (!iframe || !channel) return;
  if (iframe.dataset.tabFrozen === '1') return;

  const nextSrc = buildEmbedUrl({ platform: 'twitch', channel }, muted, { autoplay: true });

  delete iframe.dataset.focusFrozen;
  iframe.dataset.embedMuted = muted ? '1' : '0';
  card.dataset.embedMuted = muted ? '1' : '0';

  logEmbedEvent(reason, {
    platform: 'twitch',
    channel,
    action: 'blank',
    muted,
    card,
  });
  iframe.src = 'about:blank';
  logEmbedEvent('mount-forced', {
    platform: 'twitch',
    channel,
    action: 'src',
    muted,
    card,
  });
  iframe.src = nextSrc;
}

function mountKickIframe(
  card: HTMLElement,
  muted: boolean,
  reason: 'mount' | 'tab-resume' | 'focus-resume' | 'focus-unmute' = 'mount',
): void {
  const iframe = streamIframe(card);
  const channel = card.dataset.channel;
  if (!iframe || !channel) return;
  if (iframe.dataset.tabFrozen === '1') return;

  applyKickAllowPolicy(iframe, muted);

  const nextSrc = buildEmbedUrl({ platform: 'kick', channel }, muted, { autoplay: true });

  delete iframe.dataset.focusFrozen;
  iframe.dataset.embedMuted = muted ? '1' : '0';
  card.dataset.embedMuted = muted ? '1' : '0';

  if (!isBlankIframeSrc(iframe.src)) {
    try {
      if (new URL(iframe.src).href === new URL(nextSrc).href) {
        if (embedDebugEnabled) {
          logEmbedEvent(reason, {
            platform: 'kick',
            channel,
            action: 'skip-same-url',
            muted,
            card,
          });
        }
        return;
      }
    } catch {
      // Fall through to assign src.
    }
  }

  logEmbedEvent(reason, {
    platform: 'kick',
    channel,
    action: 'src',
    muted,
    card,
  });
  iframe.src = nextSrc;
}

function mountStreamMedia(
  card: HTMLElement,
  muted: boolean,
  reason: 'mount' | 'tab-resume' | 'focus-resume' | 'focus-unmute' = 'mount',
): void {
  if (card.dataset.platform === 'twitch') {
    mountTwitchIframe(card, muted, reason);
    return;
  }
  if (card.dataset.platform === 'kick') {
    mountKickIframe(card, muted, reason);
  }
}

/** Unload streams hidden by focus mode (Kick keeps playing audio if left loaded). */
function freezeFocusHiddenPlayers(container: HTMLElement, focusedId: string): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.streamId === focusedId) continue;
    if (card.dataset.focusFrozen === '1') continue;

    card.dataset.focusFrozen = '1';

    const iframe = streamIframe(card);
    if (!iframe || iframe.dataset.tabFrozen === '1') continue;
    iframe.dataset.focusFrozen = '1';
    logEmbedEvent('focus-freeze', {
      platform: card.dataset.platform,
      channel: card.dataset.channel,
      action: 'blank',
      card,
    });
    iframe.src = 'about:blank';
  }
}

/** Reload streams that were unloaded while another stream was focused. */
function resumeFocusHiddenPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.focusFrozen !== '1') continue;
    delete card.dataset.focusFrozen;
    mountStreamMedia(card, preferredMuted(card), 'focus-resume');
  }
}

function syncFocusPlayers(container: HTMLElement, prevFocusedId: string | null): void {
  if (focusedStreamId) {
    focusSessionActive = true;
    freezeFocusHiddenPlayers(container, focusedStreamId);

    const focusedCard = container.querySelector<HTMLElement>(
      `.stream-card[data-stream-id="${CSS.escape(focusedStreamId)}"]`,
    );
    if (focusedCard?.dataset.platform === 'kick') {
      focusedCard.dataset.embedMuted = '0';
      mountStreamMedia(focusedCard, false, 'focus-unmute');
    }
    return;
  }

  if (prevFocusedId === null || !focusSessionActive) {
    return;
  }

  focusSessionActive = false;
  resumeFocusHiddenPlayers(container);
  // Previously focused stream keeps its unmuted iframe — no remount on exit.
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

    const overlayFocus = card.querySelector<HTMLElement>('.stream-card__overlay-focus');
    if (overlayFocus) {
      overlayFocus.setAttribute('aria-pressed', isFocused ? 'true' : 'false');
      if (isFocused) {
        overlayFocus.title = 'Minimize';
        overlayFocus.setAttribute('aria-label', 'Minimize focused stream');
      } else {
        overlayFocus.title = 'Focus stream';
        overlayFocus.setAttribute('aria-label', 'Focus stream in browser window');
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

  // Reload unmuted in the same click turn after layout expands (user gesture).
  const focusedCard = container.querySelector<HTMLElement>(
    `.stream-card[data-stream-id="${CSS.escape(streamId)}"]`,
  );
  if (focusedCard?.dataset.platform === 'twitch') {
    focusedCard.dataset.embedMuted = '0';
    mountTwitchIframe(focusedCard, false, 'focus-unmute');
  }
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

function createStreamIframe(
  stream: StreamRef,
  adapter: ReturnType<typeof getAdapter>,
): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'stream-card__iframe';
  iframe.allowFullscreen = true;
  iframe.title = `${adapter.label} stream: ${stream.channel}`;
  iframe.referrerPolicy = 'no-referrer-when-downgrade';

  if (stream.platform === 'kick') {
    applyKickAllowPolicy(iframe, true);
    iframe.setAttribute('credentialless', '');
    try {
      (iframe as HTMLIFrameElement & { credentialless?: boolean }).credentialless = true;
    } catch {
      // Older browsers ignore this.
    }
  } else {
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-popups allow-presentation allow-modals',
    );
  }

  return iframe;
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

  const iframe = createStreamIframe(stream, adapter);

  if (stream.platform === 'kick') {
    const kickFrame = document.createElement('div');
    kickFrame.className = 'stream-card__kick-frame';
    kickFrame.append(iframe);
    player.append(kickFrame);
  } else {
    player.append(iframe);
  }

  // Toolbar is a sibling BELOW the player — never stacked over the iframe.
  const toolbar = document.createElement('div');
  toolbar.className = 'stream-card__toolbar';

  const nameBadge = document.createElement('div');
  nameBadge.className = 'stream-card__name-badge';

  const liveDot = document.createElement('span');
  liveDot.className = 'stream-card__name-badge-dot';
  liveDot.setAttribute('aria-hidden', 'true');

  const badgeName = document.createElement('span');
  badgeName.className = 'stream-card__name-badge-channel';
  badgeName.textContent = adapter.displayName(stream);

  const badgePlatform = document.createElement('span');
  badgePlatform.className = `stream-card__name-badge-platform stream-card__name-badge-platform--${stream.platform}`;
  badgePlatform.textContent = stream.platform === 'twitch' ? 'TWITCH' : 'KICK';

  nameBadge.append(liveDot, badgeName, badgePlatform);

  const overlayControls = document.createElement('div');
  overlayControls.className = 'stream-card__overlay-controls';

  const overlayFocus = document.createElement('button');
  overlayFocus.type = 'button';
  overlayFocus.className = 'stream-card__overlay-focus';
  overlayFocus.title = 'Focus stream';
  overlayFocus.setAttribute('aria-label', 'Focus stream in browser window');
  overlayFocus.setAttribute('aria-pressed', 'false');
  overlayFocus.textContent = '🔍';
  overlayFocus.addEventListener('click', () => toggleStreamFocus(container, stream.id));

  const overlayRemove = document.createElement('button');
  overlayRemove.type = 'button';
  overlayRemove.className = 'stream-card__overlay-remove';
  overlayRemove.title = 'Remove stream';
  overlayRemove.setAttribute('aria-label', 'Remove stream');
  overlayRemove.textContent = '×';
  overlayRemove.addEventListener('click', () => {
    if (focusedStreamId === stream.id) {
      setFocusedStream(container, null);
      return;
    }
    store.removeStream(stream.id);
  });

  overlayControls.append(overlayFocus, overlayRemove);

  const dragHandle = document.createElement('div');
  dragHandle.className = 'stream-card__drag-handle';
  dragHandle.title = 'Drag to reorder';
  dragHandle.setAttribute('aria-label', 'Drag to reorder');
  dragHandle.textContent = '⠿ drag';

  toolbar.append(nameBadge, dragHandle, overlayControls);
  card.append(header, player, toolbar);

  if (document.hidden) {
    card.dataset.tabFrozen = '1';
  } else {
    mountStreamMedia(card, true);
  }

  return card;
}

/** Stop all stream embeds (Kick ignores tab backgrounding and keeps playing audio). */
export function freezeStreamPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.tabFrozen === '1') continue;
    card.dataset.tabFrozen = '1';

    const iframe = streamIframe(card);
    if (!iframe) continue;
    iframe.dataset.tabFrozen = '1';
    logEmbedEvent('tab-freeze', {
      platform: card.dataset.platform,
      channel: card.dataset.channel,
      action: 'blank',
      card,
    });
    iframe.src = 'about:blank';
  }
}

/** Reload muted embeds after the tab is visible again. */
export function resumeStreamPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.tabFrozen !== '1') continue;
    delete card.dataset.tabFrozen;

    const iframe = streamIframe(card);
    if (iframe) {
      delete iframe.dataset.tabFrozen;
    }

    const isFocused =
      focusedStreamId !== null && card.dataset.streamId === focusedStreamId;
    mountStreamMedia(card, isFocused ? false : preferredMuted(card), 'tab-resume');
  }
}

export function bindTabVisibilityPlayers(container: HTMLElement): void {
  /** Ignore brief hide flashes (app switch overlays, etc.) before blanking embeds. */
  const HIDE_BLANK_DELAY_MS = 250;
  let hideBlankTimer = 0;

  document.addEventListener('visibilitychange', () => {
    logEmbedEvent('visibility', {
      action: document.hidden ? 'blank' : 'src',
    });

    if (document.hidden) {
      window.clearTimeout(hideBlankTimer);
      hideBlankTimer = window.setTimeout(() => {
        hideBlankTimer = 0;
        if (!document.hidden) return;
        freezeStreamPlayers(container);
      }, HIDE_BLANK_DELAY_MS);
      return;
    }

    window.clearTimeout(hideBlankTimer);
    hideBlankTimer = 0;
    resumeStreamPlayers(container);
  });
}

export function bindStreamFocus(handler: FocusChangeHandler): void {
  focusChangeHandler = handler;
  bindFocusEscape();
}

export function isStreamFocused(): boolean {
  return focusedStreamId !== null;
}

/**
 * Twitch can pause after headers-hidden layout thrash. Force-remount with each
 * card's saved mute preference so stalled embeds autoplay again.
 */
export function recoverTwitchPlayersAfterLayout(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;

    const isFocused =
      focusedStreamId !== null && card.dataset.streamId === focusedStreamId;
    mountTwitchIframeForced(card, isFocused ? false : preferredMuted(card));
  }
}

/**
 * Bare Twitch iframe gives no play/pause/buffering signal, so a background
 * stream can silently stall with nothing to react to. Blind periodic
 * force-remount is the cheap stopgap until the JS Embed API replaces this.
 * Skips the focused stream — reloading the one stream someone is actively
 * watching (unmuted) is more disruptive than an occasional muted-tile stall.
 */
export function recoverStalledTwitchPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    if (focusedStreamId !== null && card.dataset.streamId === focusedStreamId) continue;

    mountTwitchIframeForced(card, preferredMuted(card), 'watchdog');
  }
}

export function syncStreamGrid(container: HTMLElement, store: StreamStore): void {
  const streams = store.getStreams();
  const nextIds = new Set(streams.map((stream) => stream.id));

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
    syncFocusPlayers(container, prevFocusedId);
    notifyFocusChange(prevFocusedId);
    scheduleGridLayout(container);
  }

  for (let i = 0; i < streams.length; i += 1) {
    const stream = streams[i];
    let card = existing.get(stream.id);
    if (!card) {
      card = createPlayerElement(stream, store, container);
      existing.set(stream.id, card);
    }

    const referenceNode = container.children[i] ?? null;
    if (card !== referenceNode) {
      container.insertBefore(card, referenceNode);
    }
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
 * do not remount players (keeps streams playing across chat toggles).
 */
export function updateGridLayout(container: HTMLElement): void {
  const totalCount = Number(container.dataset.count ?? '0');
  if (totalCount === 0) {
    clearLayoutVars(container);
    container.style.removeProperty('height');
    return;
  }

  container.style.removeProperty('height');

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

  const headersHidden = document.documentElement.classList.contains('headers-hidden');
  // Headers-hidden: video alone (no chrome height). Focused keeps header for ×.
  const chromeHeight =
    !headersHidden || focusedStreamId ? CARD_HEADER_HEIGHT : 0;

  for (let columns = 1; columns <= Math.min(count, 4); columns += 1) {
    const rows = Math.ceil(count / columns);
    let maxWidth = Math.floor((areaWidth - GRID_GAP * (columns - 1)) / columns);
    let maxHeight =
      Math.floor((areaHeight - GRID_GAP * (rows - 1)) / rows) - chromeHeight;

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
