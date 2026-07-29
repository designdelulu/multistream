import { embedDebugEnabled, logEmbedEvent, reportEmbedRecovery } from '../lib/embedDebug';
import { isStackedStreamLayout } from '../lib/viewport';
import { getAdapter, buildEmbedUrl } from '../platforms';
import { twitchParentList } from '../platforms/twitch';
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

/**
 * Twitch.Player (dev.twitch.tv/docs/embed/video-and-clips/) gives real
 * play/pause/offline events instead of the blind watchdog Kick still relies
 * on — but it always builds its own iframe, so a card only reaches 'api'
 * mode once the wrapper script has actually loaded. Ad-blockers catch that
 * script more often than a bare video iframe, so 'fallback' mode (today's
 * exact bare-iframe path) is the required safety net, not an edge case.
 */
const twitchPlayers = new Map<string, Twitch.Player>();
const twitchStallCounts = new Map<string, number>();
const twitchExceptionCounts = new Map<string, number>();
/**
 * Twitch's own isPaused() docs: "buffering or seeking is considered
 * playing" — meaning a stream stuck on a loading spinner reads as NOT
 * paused and is invisible to isPaused()-based recovery no matter how long
 * it spins. Tracked separately: last time PLAYING actually fired, and
 * whether the channel is legitimately offline (so a real offline channel
 * never gets mistaken for a stuck one).
 */
const twitchLastPlayingAt = new Map<string, number>();
const twitchOffline = new Map<string, boolean>();
let twitchMountSeq = 0;
let twitchScriptPromise: Promise<boolean> | null = null;
const TWITCH_SCRIPT_TIMEOUT_MS = 4000;

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

/**
 * Lazily loads Twitch's embed script once, shared by every Twitch card, so a
 * Kick-only session never pays for it. Resolves true only if the script
 * actually loaded AND window.Twitch.Player is really there — some
 * ad-blockers let the request "succeed" with an empty stub.
 */
function ensureTwitchEmbedScript(): Promise<boolean> {
  if (twitchScriptPromise) return twitchScriptPromise;

  twitchScriptPromise = new Promise<boolean>((resolve) => {
    if (window.Twitch?.Player) {
      resolve(true);
      return;
    }

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (!ok) {
        logEmbedEvent('script-fallback', { platform: 'twitch' });
        reportEmbedRecovery('script-fallback', { platform: 'twitch' });
      }
      resolve(ok);
    };

    const timer = window.setTimeout(() => finish(false), TWITCH_SCRIPT_TIMEOUT_MS);

    const script = document.createElement('script');
    script.src = 'https://player.twitch.tv/js/embed/v1.js';
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      finish(Boolean(window.Twitch?.Player));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      finish(false);
    };
    document.head.append(script);
  });

  return twitchScriptPromise;
}

/** Only place a bare Twitch iframe gets built now — the script-load-failed path. */
function createTwitchFallbackIframe(channel: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'stream-card__iframe';
  iframe.allowFullscreen = true;
  iframe.title = `Twitch stream: ${channel}`;
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-popups allow-presentation allow-modals',
  );
  return iframe;
}

function replaceWithFallbackIframe(card: HTMLElement): void {
  const placeholder = card.querySelector<HTMLElement>('.stream-card__iframe');
  const iframe = createTwitchFallbackIframe(card.dataset.channel ?? '');
  placeholder?.replaceWith(iframe);
  card.dataset.twitchMode = 'fallback';
}

function constructTwitchPlayer(card: HTMLElement, muted: boolean): void {
  const streamId = card.dataset.streamId ?? '';
  const channel = card.dataset.channel ?? '';
  const mountEl = card.querySelector<HTMLElement>('.stream-card__iframe');
  if (!mountEl || !channel || !streamId) return;

  const player = new Twitch.Player(mountEl.id, {
    width: '100%',
    height: '100%',
    channel,
    parent: twitchParentList(window.location.hostname),
    muted,
    autoplay: true,
  });

  twitchPlayers.set(streamId, player);
  card.dataset.twitchMode = 'api';
  card.dataset.embedMuted = muted ? '1' : '0';
  twitchLastPlayingAt.set(streamId, Date.now());
  twitchOffline.set(streamId, false);

  logEmbedEvent('player-ready', { platform: 'twitch', channel, action: 'src', muted, card });

  player.addEventListener(Twitch.Player.PLAYING, () => {
    twitchLastPlayingAt.set(streamId, Date.now());
  });
  player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
    logEmbedEvent('player-blocked', { platform: 'twitch', channel, card });
    reportEmbedRecovery('playback-blocked', { platform: 'twitch' });
    player.play();
  });
  player.addEventListener(Twitch.Player.OFFLINE, () => {
    logEmbedEvent('player-offline', { platform: 'twitch', channel, card });
    twitchOffline.set(streamId, true);
  });
  player.addEventListener(Twitch.Player.ONLINE, () => {
    logEmbedEvent('player-online', { platform: 'twitch', channel, card });
    twitchOffline.set(streamId, false);
    twitchLastPlayingAt.set(streamId, Date.now());
    player.play();
  });
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
  reportEmbedRecovery('forced-remount', { platform: 'twitch', reason });
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
  if (card.dataset.platform === 'kick') {
    mountKickIframe(card, muted, reason);
    return;
  }
  if (card.dataset.platform !== 'twitch') return;
  if (card.dataset.tabFrozen === '1') return;

  const mode = card.dataset.twitchMode;

  if (mode === 'api') {
    const player = twitchPlayers.get(card.dataset.streamId ?? '');
    player?.setMuted(muted);
    player?.play();
    card.dataset.embedMuted = muted ? '1' : '0';
    return;
  }

  if (mode === 'fallback') {
    mountTwitchIframe(card, muted, reason);
    return;
  }

  // 'pending' or first mount — (re)attempt once the shared script load settles.
  card.dataset.twitchMode = 'pending';
  card.dataset.embedMuted = muted ? '1' : '0';
  void ensureTwitchEmbedScript().then((available) => {
    if (!card.isConnected) return;
    if (card.dataset.tabFrozen === '1') return; // re-frozen mid-await; next resume retries
    if (card.dataset.twitchMode !== 'pending') return; // already resolved by a concurrent call

    const currentMuted = preferredMuted(card);
    if (available) {
      constructTwitchPlayer(card, currentMuted);
    } else {
      replaceWithFallbackIframe(card);
      mountTwitchIframe(card, currentMuted, reason);
    }
  });
}

/** Unload streams hidden by focus mode (Kick keeps playing audio if left loaded). */
function freezeFocusHiddenPlayers(container: HTMLElement, focusedId: string): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.streamId === focusedId) continue;
    if (card.dataset.focusFrozen === '1') continue;

    card.dataset.focusFrozen = '1';
    if (card.dataset.tabFrozen === '1') continue;

    if (card.dataset.platform === 'twitch') {
      if (card.dataset.twitchMode === 'pending') continue; // nothing mounted yet
      if (card.dataset.twitchMode === 'api') {
        const player = twitchPlayers.get(card.dataset.streamId ?? '');
        if (!player) continue;
        logEmbedEvent('focus-freeze', {
          platform: 'twitch',
          channel: card.dataset.channel,
          action: 'blank',
          card,
        });
        player.pause();
        continue;
      }
    }

    const iframe = streamIframe(card);
    if (!iframe) continue;
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
    const mode = focusedCard.dataset.twitchMode;
    if (mode === 'api') {
      const player = twitchPlayers.get(streamId);
      player?.setMuted(false);
      player?.play();
    } else if (mode === 'fallback') {
      mountTwitchIframe(focusedCard, false, 'focus-unmute');
    }
    // mode === 'pending': the in-flight construction reads embedMuted once
    // the script settles — nothing to do here.
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

function createKickIframe(
  stream: StreamRef,
  adapter: ReturnType<typeof getAdapter>,
): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'stream-card__iframe';
  iframe.allowFullscreen = true;
  iframe.title = `${adapter.label} stream: ${stream.channel}`;
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  applyKickAllowPolicy(iframe, true);
  iframe.setAttribute('credentialless', '');
  try {
    (iframe as HTMLIFrameElement & { credentialless?: boolean }).credentialless = true;
  } catch {
    // Older browsers ignore this.
  }
  return iframe;
}

/** Empty mount point — Twitch.Player (or the fallback iframe) attaches via mountStreamMedia. */
function createTwitchMountPoint(): HTMLDivElement {
  const mount = document.createElement('div');
  mount.className = 'stream-card__iframe';
  mount.id = `twitch-embed-${++twitchMountSeq}`;
  return mount;
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

  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.className = 'stream-card__reload';
  reloadButton.title = 'Reload stream';
  reloadButton.setAttribute('aria-label', 'Reload stream');
  reloadButton.innerHTML =
    '<span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 7A5 5 0 1 1 10.5 3.4M12 1.5V4.5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  reloadButton.addEventListener('click', () => reloadStreamCard(card));

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

  controls.append(focusButton, reloadButton, removeButton);
  header.append(badge, title, controls);

  const player = document.createElement('div');
  player.className = 'stream-card__player';

  if (stream.platform === 'kick') {
    const iframe = createKickIframe(stream, adapter);
    const kickFrame = document.createElement('div');
    kickFrame.className = 'stream-card__kick-frame';
    kickFrame.append(iframe);
    player.append(kickFrame);
  } else {
    player.append(createTwitchMountPoint());
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

  const overlayReload = document.createElement('button');
  overlayReload.type = 'button';
  overlayReload.className = 'stream-card__overlay-reload';
  overlayReload.title = 'Reload stream';
  overlayReload.setAttribute('aria-label', 'Reload stream');
  overlayReload.textContent = '⟳';
  overlayReload.addEventListener('click', () => reloadStreamCard(card));

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

  overlayControls.append(overlayFocus, overlayReload, overlayRemove);

  const dragHandle = document.createElement('div');
  dragHandle.className = 'stream-card__drag-handle';
  dragHandle.title = 'Drag to reorder';
  dragHandle.setAttribute('aria-label', 'Drag to reorder');
  dragHandle.textContent = '⠿ drag';

  toolbar.append(nameBadge, dragHandle, overlayControls);
  card.append(header, player, toolbar);

  if (stream.platform === 'twitch') {
    // Headers-hidden reveals this toolbar on hover by shrinking the player
    // box (main.css) — a real iframe resize we otherwise never observe.
    // Check once the shrink/grow settles instead of waiting on the watchdog.
    toolbar.addEventListener('transitionend', (event) => {
      if (event.propertyName !== 'height') return;
      verifyAndRecoverTwitchPlayer(card, false);
    });
  }

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

    if (card.dataset.platform === 'twitch') {
      if (card.dataset.twitchMode === 'pending') continue; // nothing mounted yet
      if (card.dataset.twitchMode === 'api') {
        const player = twitchPlayers.get(card.dataset.streamId ?? '');
        logEmbedEvent('tab-freeze', {
          platform: 'twitch',
          channel: card.dataset.channel,
          action: 'blank',
          card,
        });
        player?.pause();
        continue;
      }
    }

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
  /**
   * Kick has no pause API — freezing means blank+reload, and resuming means
   * remounting muted (no way to read back a live in-player unmute). At 250ms
   * this fired on almost any tab switch — alt-tabbing to answer a message,
   * checking chat elsewhere — turning ordinary multitasking into a visible
   * reload + remute on every return. 20s treats it as real backgrounding
   * instead of a brief glance away, while still silencing Kick's audio
   * (which ignores tab backgrounding on its own) after a genuine absence.
   */
  const HIDE_BLANK_DELAY_MS = 20_000;
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
        reportEmbedRecovery('tab-freeze');
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
 * Fallback-mode Twitch (bare iframe) can pause after headers-hidden layout
 * thrash with nothing to detect it — force-remount as before. 'api'-mode
 * cards are trusted to survive the CSS resize without a remount (this is
 * the one part of the swap that most needs live-browser confirmation).
 */
export function recoverTwitchPlayersAfterLayout(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    if (card.dataset.twitchMode !== 'fallback') continue;

    const isFocused =
      focusedStreamId !== null && card.dataset.streamId === focusedStreamId;
    mountTwitchIframeForced(card, isFocused ? false : preferredMuted(card));
  }
}

/**
 * Wait this long, then re-check isPaused(), before treating a pause as real.
 * With many concurrent streams competing for bandwidth, Twitch's own normal
 * rebuffering can read paused for a moment and resolve on its own — acting
 * on that single instantaneous read just adds our own play()-call flash on
 * top of a blip that was already clearing up by itself.
 */
const STALL_CONFIRM_DELAY_MS = 500;

/** isPaused() throwing this many checks in a row means the instance itself is broken. */
const MAX_CONSECUTIVE_EXCEPTIONS = 3;

/**
 * true/false is a real answer; null means isPaused() threw — the player
 * isn't ready yet, or (after MAX_CONSECUTIVE_EXCEPTIONS running total) is
 * broken. Exceptions must never be read as "confirmed not paused": a player
 * stuck throwing after a failed setChannel() would otherwise look
 * permanently healthy and never get recovered again.
 */
function checkPaused(player: Twitch.Player, streamId: string): boolean | null {
  try {
    const paused = player.isPaused();
    twitchExceptionCounts.delete(streamId);
    return paused;
  } catch {
    twitchExceptionCounts.set(streamId, (twitchExceptionCounts.get(streamId) ?? 0) + 1);
    return null;
  }
}

/**
 * isPaused() reads buffering as "playing", so a stuck loading spinner needs
 * its own signal: how long since PLAYING last actually fired. Long enough
 * to not fire on an ordinary ad transition or quality-switch rebuffer, short
 * enough to feel fast next to the old escalation path. Never true for a
 * channel that's legitimately offline — that's not stuck, retrying won't help.
 */
const STUCK_BUFFERING_MS = 8000;

function isStuckBuffering(streamId: string): boolean {
  if (twitchOffline.get(streamId)) return false;
  const lastPlaying = twitchLastPlayingAt.get(streamId);
  if (lastPlaying === undefined) return false;
  return Date.now() - lastPlaying > STUCK_BUFFERING_MS;
}

/** Destroy and reconstruct from scratch — for when the instance itself can't be trusted. */
function rebuildTwitchPlayer(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';

  twitchPlayers.get(streamId)?.destroy();
  twitchPlayers.delete(streamId);
  twitchStallCounts.delete(streamId);
  twitchExceptionCounts.delete(streamId);
  twitchLastPlayingAt.delete(streamId);
  twitchOffline.delete(streamId);

  const placeholder = card.querySelector<HTMLElement>('.stream-card__iframe');
  placeholder?.replaceWith(createTwitchMountPoint());

  constructTwitchPlayer(card, preferredMuted(card));
}

/**
 * Force-remount, ignoring the same-URL dedup mountKickIframe uses — for the
 * manual reload button only. No periodic watchdog calls this: an automatic
 * blind reload on a timer was confirmed to reset Kick's volume back to muted
 * far more often than it fixed anything (removed entirely for that reason).
 * A user explicitly clicking reload is a different case — they're choosing
 * to accept losing any manually-adjusted volume in exchange for un-sticking
 * the stream right now.
 */
function reloadKickPlayer(card: HTMLElement): void {
  const iframe = streamIframe(card);
  const channel = card.dataset.channel;
  if (!iframe || !channel) return;

  const muted = preferredMuted(card);
  applyKickAllowPolicy(iframe, muted);
  const nextSrc = buildEmbedUrl({ platform: 'kick', channel }, muted, { autoplay: true });

  delete iframe.dataset.focusFrozen;
  iframe.dataset.embedMuted = muted ? '1' : '0';
  card.dataset.embedMuted = muted ? '1' : '0';

  logEmbedEvent('mount-forced', { platform: 'kick', channel, action: 'blank', muted, card });
  reportEmbedRecovery('forced-remount', { platform: 'kick', reason: 'manual' });
  iframe.src = 'about:blank';
  iframe.src = nextSrc;
}

/**
 * Manual per-stream reload — the escape hatch for whatever automatic
 * recovery can't catch (e.g. a browser-level resource limit with many
 * concurrent streams open, outside anything play()/setChannel()/rebuild can
 * force past). Fixes just this one card instead of a full-page refresh that
 * would disrupt every other stream.
 */
function reloadStreamCard(card: HTMLElement): void {
  if (card.dataset.platform === 'kick') {
    reloadKickPlayer(card);
    return;
  }
  if (card.dataset.platform !== 'twitch') return;

  if (card.dataset.twitchMode === 'api') {
    logEmbedEvent('player-recover', { platform: 'twitch', channel: card.dataset.channel, card });
    reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'manual' });
    rebuildTwitchPlayer(card);
    return;
  }
  if (card.dataset.twitchMode === 'fallback') {
    reportEmbedRecovery('forced-remount', { platform: 'twitch', reason: 'manual' });
    mountTwitchIframeForced(card, preferredMuted(card), 'headers-recover');
  }
  // 'pending': script still loading — nothing to reload yet.
}

/**
 * Real recovery for one 'api'-mode card: check isPaused() and the
 * stuck-buffering signal (isPaused() alone reads buffering as "playing",
 * so a stuck loading spinner would otherwise never be seen), confirm it's
 * still stalled after a short delay, and only then act, escalating
 * play() -> setChannel() -> a full rebuild across repeated confirmed
 * stalls, so a reconnect that doesn't actually fix anything doesn't just
 * loop forever. `allowReconnect` gates all three of those — only
 * recoverStalledApiTwitchPlayers' own interval is allowed them, since its
 * cadence naturally rate-limits how often they can fire. Hover/interaction-
 * triggered calls pass false: a quick play() nudge for the pause a resize
 * or backgrounding can cause, never the heavier actions. Without this
 * split, ordinary mouse movement could hit the same escalation threshold
 * the interval needed several ticks to reach, turning a brief pause into a
 * visible reload or rebuild.
 */
function verifyAndRecoverTwitchPlayer(card: HTMLElement, allowReconnect = true): void {
  if (card.dataset.twitchMode !== 'api') return;
  if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return;
  if (focusedStreamId !== null && card.dataset.streamId === focusedStreamId) return;

  const streamId = card.dataset.streamId ?? '';
  const player = twitchPlayers.get(streamId);
  if (!player) return;

  const paused = checkPaused(player, streamId);

  if (allowReconnect && (twitchExceptionCounts.get(streamId) ?? 0) >= MAX_CONSECUTIVE_EXCEPTIONS) {
    logEmbedEvent('player-recover', {
      platform: 'twitch',
      channel: card.dataset.channel,
      card,
    });
    reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'rebuild' });
    rebuildTwitchPlayer(card);
    return;
  }

  if (paused === null) return; // unreadable for now — try again next check
  if (!paused && !isStuckBuffering(streamId)) {
    twitchStallCounts.delete(streamId);
    return;
  }

  window.setTimeout(() => {
    if (twitchPlayers.get(streamId) !== player) return; // removed/replaced meanwhile
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return;
    if (focusedStreamId !== null && card.dataset.streamId === focusedStreamId) return;

    const stillPaused = checkPaused(player, streamId);
    if (stillPaused === null) return;
    if (!stillPaused && !isStuckBuffering(streamId)) {
      twitchStallCounts.delete(streamId);
      return;
    }

    logEmbedEvent('player-recover', {
      platform: 'twitch',
      channel: card.dataset.channel,
      card,
    });

    if (!allowReconnect) {
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'replay' });
      player.play();
      return;
    }

    const count = (twitchStallCounts.get(streamId) ?? 0) + 1;
    twitchStallCounts.set(streamId, count);

    if (count >= 3) {
      // setChannel() didn't resolve it either — stop trying incremental
      // fixes on an instance that's proven it won't recover on its own.
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'rebuild' });
      twitchStallCounts.set(streamId, 0);
      rebuildTwitchPlayer(card);
    } else if (count === 2) {
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'reconnect' });
      player.setChannel(card.dataset.channel ?? '');
    } else {
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'replay' });
      player.play();
    }
  }, STALL_CONFIRM_DELAY_MS);
}

/**
 * Fallback-mode cards (script blocked/failed) have no signal at all, so this
 * stays on the slow 90s cadence, unconditional force-remount — the only
 * option available for them. Never call this often: unlike the verified
 * api-mode path, there's no confirm-delay or check to filter out a stream
 * that's actually fine.
 */
export function recoverStalledFallbackTwitchPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch') continue;
    if (card.dataset.twitchMode !== 'fallback') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    if (focusedStreamId !== null && card.dataset.streamId === focusedStreamId) continue;

    mountTwitchIframeForced(card, preferredMuted(card), 'watchdog');
  }
}

/**
 * 'api'-mode cards get real, verified recovery via verifyAndRecoverTwitchPlayer
 * (isPaused() + the stuck-buffering signal, confirm-delay, escalation) — safe
 * to run on a much faster cadence than the fallback sweep above, since it
 * only ever acts on a confirmed stall. Skips the focused stream — reloading
 * the one stream someone is actively watching is more disruptive than a
 * muted-tile stall.
 */
export function recoverStalledApiTwitchPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch') continue;
    if (card.dataset.twitchMode !== 'api') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    if (focusedStreamId !== null && card.dataset.streamId === focusedStreamId) continue;

    verifyAndRecoverTwitchPlayer(card);
  }
}

/**
 * Gentle, escalation-free sweep for api-mode cards — reused by any "user
 * just showed up" signal (mouse movement, pointer down). A visibilitychange
 * or timer-driven play() call isn't a genuine user gesture, and browsers can
 * silently ignore a resume request after a real background/throttled period
 * without one — a real mouse movement satisfies that requirement. Never
 * escalates to setChannel() or rebuild: only recoverStalledApiTwitchPlayers'
 * own interval may, since allowReconnect=true there is what gates those.
 */
export function nudgeStalledTwitchPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch') continue;
    if (card.dataset.twitchMode !== 'api') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;

    verifyAndRecoverTwitchPlayer(card, false);
  }
}

export function syncStreamGrid(container: HTMLElement, store: StreamStore): void {
  const streams = store.getStreams();
  const nextIds = new Set(streams.map((stream) => stream.id));

  const seenIds = new Set<string>();
  for (const card of [...container.querySelectorAll<HTMLElement>('.stream-card')]) {
    const id = card.dataset.streamId ?? '';
    if (!id || !nextIds.has(id) || seenIds.has(id)) {
      if (card.dataset.platform === 'twitch') {
        twitchPlayers.get(id)?.destroy();
        twitchPlayers.delete(id);
        twitchStallCounts.delete(id);
        twitchExceptionCounts.delete(id);
        twitchLastPlayingAt.delete(id);
        twitchOffline.delete(id);
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
