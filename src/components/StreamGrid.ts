import {
  embedDebugEnabled,
  logEmbedEvent,
  logPlayerEvent,
  logStatsSample,
  reportEmbedRecovery,
  statsDebugEnabled,
} from '../lib/embedDebug';
import { createPlaybackRecovery, type RecoveryTarget } from '../lib/playbackRecovery';
import { isStackedStreamLayout } from '../lib/viewport';
import { getAdapter, buildEmbedUrl } from '../platforms';
import { twitchParentList } from '../platforms/twitch';
import type { StreamRef } from '../types';
import type { StreamStore } from '../state/streams';

/**
 * Kick only mounts desktop chrome (volume, quality) when the iframe's layout
 * width is >= 769px (measured empirically). MultiTwitch-style optimize_size
 * often makes cells smaller than that — so Kick iframes are rendered wide and
 * CSS-scaled down into the cell. Kick sees a wide player; the grid still fits
 * every stream on-screen.
 *
 * Confirmed on production: 640 drops below Kick's real breakpoint — the mute
 * control disappears entirely (not just shrinks). Do not lower this without
 * a live check; 769 is the last known-good floor.
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
/** Spreads the watchdog's per-card checks so several stalled cards don't confirm/escalate in the same instant. */
const RECOVERY_SPREAD_MAX_MS = 2000;

/*
 * Headers-hidden toolbar icons. Both are drawn in the same 16×16 box, with the
 * same 1.5 stroke and round joins, and both are optically centred on (8, 8):
 * the magnifier's artwork spans 1.5–14.5 and the cross spans 3.25–12.75, so
 * each is symmetric about the middle and they sit on the same baseline inside
 * identical 26px buttons. The cross is the smaller of the two on purpose —
 * that size ratio is what makes a close control read as lighter than a
 * primary action rather than as a misaligned one.
 *
 * These replaced a 🔍 emoji and a × character. Both rendered at whatever size
 * and vertical offset the user's emoji/text font happened to choose, which is
 * why they never lined up with each other.
 */
const ICON_MAGNIFIER =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="7" cy="7" r="4.75" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M11.1 11.1 13.75 13.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '</svg>';

const ICON_CLOSE =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M4 4 12 12M12 4 4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '</svg>';

/** Same artwork as the header reload button (14x14, +1/+1 offset into the shared 16x16 box). */
const ICON_RELOAD =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M13 8A5 5 0 1 1 11.5 4.4M13 2.5V5.5H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

/**
 * The header's own drag handle has no icon — the entire header row is the
 * grab target (see .stream-card__header { cursor: grab }), so there is
 * nothing to literally copy. This is a standard six-dot grip drawn in the
 * same 16x16 box as the other toolbar icons, filled rather than stroked
 * (the usual convention for a grip glyph) so it still reads at this size.
 */
const ICON_DRAG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="6" cy="4" r="1.3" fill="currentColor"/><circle cx="10" cy="4" r="1.3" fill="currentColor"/>' +
  '<circle cx="6" cy="8" r="1.3" fill="currentColor"/><circle cx="10" cy="8" r="1.3" fill="currentColor"/>' +
  '<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="10" cy="12" r="1.3" fill="currentColor"/>' +
  '</svg>';

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
let twitchMountSeq = 0;
let twitchScriptPromise: Promise<boolean> | null = null;
const TWITCH_SCRIPT_TIMEOUT_MS = 4000;

/**
 * Latched playback state per api-mode player, driven purely by Twitch's own
 * events. This exists so "was this stream playing before I touched the grid?"
 * is an observation rather than a guess.
 *
 * 'playing' is only ever set by a real PLAYING event ("player started video
 * playback"). PLAYING is an EDGE event — it fires once and never repeats —
 * so it is latched into this map and never used as a "time since" measure.
 * That distinction is the whole reason 180f12e's detector misfired on every
 * healthy stream.
 *
 * Fail-safe direction: if Twitch ever stopped emitting these, every card
 * would stay 'unknown', the pre-mutation snapshot would come back empty and
 * add/remove recovery would quietly do nothing. It cannot fail towards
 * playing streams nobody asked for.
 */
type PlaybackState = 'unknown' | 'playing' | 'paused' | 'blocked' | 'offline';
const twitchPlayback = new Map<string, PlaybackState>();

function setPlaybackState(streamId: string, state: PlaybackState, channel?: string): void {
  twitchPlayback.set(streamId, state);
  logPlayerEvent('state', { streamId, channel, state });
}

/**
 * Drop every trace of one player. Any recovery run still pointed at this id
 * stops on its own at the next pass — its isEligible() fails once the player
 * is out of twitchPlayers — so runs for other cards are left alone.
 */
function forgetTwitchPlayer(streamId: string): void {
  twitchPlayers.delete(streamId);
  twitchStallCounts.delete(streamId);
  twitchExceptionCounts.delete(streamId);
  twitchPlayback.delete(streamId);
}

/**
 * Add/remove recovery. Deliberately scoped: this runs for stream add and
 * remove transactions and for a freshly constructed player, and for nothing
 * else. It is not wired to ResizeObserver, window resize, focus changes or the
 * toolbar transition — those already have their own, older handling, and
 * attaching a play()-capable mechanism to high-frequency events is how the
 * grid-wide overlay flashing got introduced the first time.
 */
const playbackRecovery = createPlaybackRecovery({
  timers: {
    setTimeout: (handler, ms) => window.setTimeout(handler, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
  },
  log: (event, detail) => logPlayerEvent(`recovery:${event}`, detail),
});

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
  twitchPlayback.set(streamId, 'unknown');
  card.dataset.twitchMode = 'api';
  card.dataset.embedMuted = muted ? '1' : '0';

  logEmbedEvent('player-ready', { platform: 'twitch', channel, action: 'src', muted, card });
  logPlayerEvent('construct', { streamId, channel, mountId: mountEl.id, muted });

  player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
    logEmbedEvent('player-blocked', { platform: 'twitch', channel, card });
    logPlayerEvent('event:PLAYBACK_BLOCKED', { streamId, channel });
    reportEmbedRecovery('playback-blocked', { platform: 'twitch' });
    setPlaybackState(streamId, 'blocked', channel);
    // Autoplay policy, not a stall — retrying play() cannot clear it, so stop
    // any recovery run chasing this card and let it be reported on its own.
    playbackRecovery.markBlocked(streamId);
    player.play();
  });
  player.addEventListener(Twitch.Player.OFFLINE, () => {
    logEmbedEvent('player-offline', { platform: 'twitch', channel, card });
    logPlayerEvent('event:OFFLINE', { streamId, channel });
    setPlaybackState(streamId, 'offline', channel);
  });
  player.addEventListener(Twitch.Player.ONLINE, () => {
    logEmbedEvent('player-online', { platform: 'twitch', channel, card });
    logPlayerEvent('event:ONLINE', { streamId, channel });
    if (twitchPlayback.get(streamId) === 'offline') {
      setPlaybackState(streamId, 'unknown', channel);
    }
    player.play();
  });

  player.addEventListener(Twitch.Player.PLAY, () => {
    // Unpaused — playback may still only be buffering. Not confirmation.
    logPlayerEvent('event:PLAY', { streamId, channel });
  });
  player.addEventListener(Twitch.Player.PLAYING, () => {
    logPlayerEvent('event:PLAYING', { streamId, channel });
    setPlaybackState(streamId, 'playing', channel);
    playbackRecovery.confirmPlaying(streamId);
  });
  player.addEventListener(Twitch.Player.PAUSE, () => {
    logPlayerEvent('event:PAUSE', { streamId, channel });
    setPlaybackState(streamId, 'paused', channel);
  });
  player.addEventListener(Twitch.Player.ENDED, () => {
    logPlayerEvent('event:ENDED', { streamId, channel });
    setPlaybackState(streamId, 'paused', channel);
  });

  player.addEventListener(Twitch.Player.READY, () => {
    logPlayerEvent('event:READY', { streamId, channel });
    // A brand-new card is expected to autoplay by itself. Watch that it
    // actually does, on a later-starting schedule than the transaction run so
    // a player that was going to start anyway is never interrupted by a
    // needless play(). Set once per constructed player, so this covers the
    // initial page load as well as streams added later — both are the same
    // "did autoplay actually take?" question.
    if (card.dataset.recoveryWatchNew !== '1') return;
    delete card.dataset.recoveryWatchNew;
    playbackRecovery.track(createTwitchRecoveryTarget(streamId, Date.now()), 'new-player');
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
  // Stable per-card jitter so the watchdog sweep doesn't act on every stalled
  // card in the same instant — see recoverStalledTwitchPlayers.
  card.dataset.recoverySpreadMs = String(Math.floor(Math.random() * RECOVERY_SPREAD_MAX_MS));
  // Consumed once by the player's READY handler: a freshly mounted card is
  // expected to autoplay, and this asks for that to be verified rather than
  // assumed. Cleared there so a later rebuild doesn't re-arm it.
  card.dataset.recoveryWatchNew = '1';

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

  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.className = 'stream-card__reload';
  reloadButton.title = 'Reload stream';
  reloadButton.setAttribute('aria-label', 'Reload stream');
  reloadButton.innerHTML =
    '<span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 7A5 5 0 1 1 10.5 3.4M12 1.5V4.5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  reloadButton.addEventListener('click', () => reloadStreamCard(card));

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

  /*
   * Headers-hidden identity on the left, actions on the right: Drag, Focus,
   * Reload, Close. Reload reuses reloadStreamCard — the exact function the
   * header's own reload button calls — so the two controls can never drift
   * apart in behavior. The drag handle reuses StreamReorder's existing
   * SortableJS instance unchanged; only its `handle` option now points here
   * instead of `.stream-card__header` while headers are hidden (see
   * StreamReorder.sync), so this button is the ONLY element that can start a
   * drag in that mode — Focus/Reload/Close are siblings, not descendants of
   * it, so a click on them can never be mistaken for a drag start.
   *
   * Despite the name, nothing in `__overlay-*` overlays anything: this whole
   * subtree lives in `.stream-card__toolbar`, a flex sibling BELOW
   * `.stream-card__player`. Painting controls over a live Twitch iframe was
   * confirmed to pause it on hover — keep them out of the player subtree.
   */
  const nameBadge = document.createElement('div');
  nameBadge.className = 'stream-card__name-badge';

  const nameDot = document.createElement('span');
  nameDot.className = 'stream-card__name-badge-dot';
  nameDot.setAttribute('aria-hidden', 'true');

  const nameChannel = document.createElement('span');
  nameChannel.className = 'stream-card__name-badge-channel';
  nameChannel.textContent = adapter.displayName(stream);

  const namePlatform = document.createElement('span');
  namePlatform.className = `stream-card__name-badge-platform stream-card__name-badge-platform--${stream.platform}`;
  namePlatform.textContent = adapter.label;

  nameBadge.append(nameDot, nameChannel, namePlatform);

  const overlayControls = document.createElement('div');
  overlayControls.className = 'stream-card__overlay-controls';

  const overlayDrag = document.createElement('button');
  overlayDrag.type = 'button';
  overlayDrag.className = 'stream-card__overlay-drag';
  overlayDrag.title = 'Drag to reorder';
  overlayDrag.setAttribute('aria-label', 'Drag to reorder');
  overlayDrag.innerHTML = ICON_DRAG;
  // No click handler: SortableJS binds its own pointerdown/touch listeners
  // to this element (see StreamReorder's `handle` option) and drives the
  // drag itself. A stray click after a drag ends has nothing to do here.

  const overlayFocus = document.createElement('button');
  overlayFocus.type = 'button';
  overlayFocus.className = 'stream-card__overlay-focus';
  overlayFocus.title = 'Focus stream';
  overlayFocus.setAttribute('aria-label', 'Focus stream in browser window');
  overlayFocus.setAttribute('aria-pressed', 'false');
  overlayFocus.innerHTML = ICON_MAGNIFIER;
  overlayFocus.addEventListener('click', () => toggleStreamFocus(container, stream.id));

  const overlayReload = document.createElement('button');
  overlayReload.type = 'button';
  overlayReload.className = 'stream-card__overlay-reload';
  overlayReload.title = 'Reload stream';
  overlayReload.setAttribute('aria-label', 'Reload stream');
  overlayReload.innerHTML = ICON_RELOAD;
  // Same function the header reload button calls — one implementation, so
  // the two controls cannot behave differently. Reloads only this card: see
  // reloadStreamCard/rebuildTwitchPlayer, neither touches any other player.
  overlayReload.addEventListener('click', () => reloadStreamCard(card));

  const overlayRemove = document.createElement('button');
  overlayRemove.type = 'button';
  overlayRemove.className = 'stream-card__overlay-remove';
  overlayRemove.title = 'Remove stream';
  overlayRemove.setAttribute('aria-label', 'Remove stream');
  overlayRemove.innerHTML = ICON_CLOSE;
  overlayRemove.addEventListener('click', () => {
    if (focusedStreamId === stream.id) {
      setFocusedStream(container, null);
      return;
    }
    store.removeStream(stream.id);
  });

  overlayControls.append(overlayDrag, overlayFocus, overlayReload, overlayRemove);

  toolbar.append(nameBadge, overlayControls);
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

/** Destroy and reconstruct from scratch — for when the instance itself can't be trusted. */
function rebuildTwitchPlayer(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';

  logPlayerEvent('rebuild', { streamId, channel: card.dataset.channel });
  twitchPlayers.get(streamId)?.destroy();
  forgetTwitchPlayer(streamId);

  const placeholder = card.querySelector<HTMLElement>('.stream-card__iframe');
  placeholder?.replaceWith(createTwitchMountPoint());

  constructTwitchPlayer(card, preferredMuted(card));
}

/**
 * Force-remount, ignoring the same-URL dedup mountKickIframe uses — for the
 * manual reload button only. No periodic watchdog calls this: an automatic
 * blind reload on a timer was confirmed to reset Kick's volume back to muted
 * far more often than it fixed anything (removed entirely in e1799f8 for
 * that reason). A user explicitly clicking reload is a different case —
 * they're choosing to accept losing a manually-adjusted volume in exchange
 * for un-sticking the stream right now.
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
 * Manual per-stream reload — the last-resort escape hatch for anything
 * automatic recovery can't catch. Fixes just this one card instead of a
 * full-page refresh that would disrupt every other stream.
 *
 * Deliberately skips none of the usual guards: unlike the automatic paths,
 * reloading the focused stream is exactly what's wanted when a user asks,
 * and no rate limit applies to a deliberate click.
 */
function reloadStreamCard(card: HTMLElement): void {
  if (card.dataset.platform === 'kick') {
    reloadKickPlayer(card);
    return;
  }
  if (card.dataset.platform !== 'twitch') return;

  const mode = card.dataset.twitchMode;

  if (mode === 'api') {
    logEmbedEvent('player-recover', { platform: 'twitch', channel: card.dataset.channel, card });
    reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'manual' });
    rebuildTwitchPlayer(card);
    return;
  }

  if (mode === 'fallback') {
    reportEmbedRecovery('forced-remount', { platform: 'twitch', reason: 'manual' });
    mountTwitchIframeForced(card, preferredMuted(card));
    return;
  }

  // 'pending' (or unset): the script load never resolved, so nothing is
  // mounted to reload. Clear the flag and re-run the mount so a card stuck
  // waiting on a blocked/slow script gets a genuine retry instead of a no-op.
  delete card.dataset.twitchMode;
  reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'manual-retry' });
  mountStreamMedia(card, preferredMuted(card));
}

/**
 * Real recovery for one 'api'-mode card: check isPaused(), confirm it's
 * still paused after a short delay, and only then act. `allowReconnect`
 * gates both the escalation to setChannel() (a real, visibly-slow reconnect)
 * and the full rebuild below — only the 90s watchdog is allowed those,
 * since its own cadence naturally rate-limits them. Hover/interaction-
 * triggered calls pass false: a quick play() nudge for the pause a resize
 * or backgrounding can cause, never the heavier actions. Without this
 * split, ordinary mouse movement could hit the same escalation threshold
 * the watchdog needed 90s+ to reach, turning a brief pause into a visible
 * reload or rebuild.
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
  if (!paused) {
    twitchStallCounts.delete(streamId);
    return;
  }

  window.setTimeout(() => {
    if (twitchPlayers.get(streamId) !== player) return; // removed/replaced meanwhile
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return;
    if (focusedStreamId !== null && card.dataset.streamId === focusedStreamId) return;

    const stillPaused = checkPaused(player, streamId);
    if (stillPaused === null) return;
    if (!stillPaused) {
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

    if (count >= 2) {
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'reconnect' });
      player.setChannel(card.dataset.channel ?? '');
      twitchStallCounts.set(streamId, 0);
    } else {
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'replay' });
      player.play();
    }
  }, STALL_CONFIRM_DELAY_MS);
}

function cardForStream(streamId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.stream-card[data-stream-id="${CSS.escape(streamId)}"]`,
  );
}

/**
 * Bridges one api-mode player to the recovery coordinator.
 *
 * Everything is resolved lazily by stream id rather than captured, so a card
 * that gets removed, rebuilt, or replaced mid-run is picked up correctly at
 * the next pass instead of leaving the run holding a stale node or a
 * destroyed player.
 *
 * `startedAt` is the moment the run was created, and exists only for the
 * user-engagement check below.
 */
function createTwitchRecoveryTarget(streamId: string, startedAt: number): RecoveryTarget {
  return {
    id: streamId,

    isEligible() {
      const card = cardForStream(streamId);
      if (!card?.isConnected) return false;
      if (card.dataset.platform !== 'twitch' || card.dataset.twitchMode !== 'api') return false;
      if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return false;
      if (focusedStreamId !== null && streamId === focusedStreamId) return false;
      if (!twitchPlayers.has(streamId)) return false;
      // Nothing to resume on a channel that is off the air.
      if (twitchPlayback.get(streamId) === 'offline') return false;
      /*
       * The only way a user can pause a cross-origin Twitch player is to click
       * inside its iframe, which moves focus into that iframe and is visible
       * to us (see bindPlaybackRecovery). If that happened after this run
       * started, the pause is theirs, not the resize's — leave it alone. A
       * click from before the run does not disqualify the card, so recovery is
       * never permanently disabled just because someone once clicked in to
       * unmute.
       */
      if (Number(card.dataset.userEngagedAt ?? '0') >= startedAt) return false;
      return true;
    },

    isPaused() {
      const player = twitchPlayers.get(streamId);
      if (!player) return null;
      return checkPaused(player, streamId);
    },

    play() {
      const player = twitchPlayers.get(streamId);
      if (!player) return;
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'add-remove' });
      player.play();
    },
  };
}

/**
 * Ids of api-mode Twitch players that Twitch itself has confirmed are playing
 * right now. Must be called BEFORE the grid is mutated: it is the entire
 * definition of "should still be playing afterwards", and a stream the user
 * had already paused is simply absent from it.
 */
export function snapshotPlayingTwitchPlayers(container: HTMLElement): string[] {
  const ids: string[] = [];
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch' || card.dataset.twitchMode !== 'api') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    const streamId = card.dataset.streamId ?? '';
    if (!streamId || twitchPlayback.get(streamId) !== 'playing') continue;
    ids.push(streamId);
  }
  logPlayerEvent('snapshot', { playing: ids });
  return ids;
}

/**
 * Start the bounded post-mutation checks. Call once the final grid layout has
 * settled — every surviving player has its new box by then, which is the
 * resize Twitch reacts to.
 *
 * Only ids from the pre-mutation snapshot are considered, and each is checked
 * independently; see lib/playbackRecovery.ts for the pass schedule and the
 * reasoning behind it.
 */
export function beginAddRemoveRecovery(
  container: HTMLElement,
  snapshotIds: readonly string[],
  cause: 'add' | 'remove' | 'add-remove' = 'add-remove',
): void {
  const startedAt = Date.now();
  const targets = snapshotIds
    .filter((streamId) => {
      const card = cardForStream(streamId);
      return Boolean(card?.isConnected) && container.contains(card);
    })
    .map((streamId) => createTwitchRecoveryTarget(streamId, startedAt));

  logPlayerEvent('layout-settled', {
    cause,
    survivors: targets.map((target) => target.id),
    dropped: snapshotIds.filter((id) => !targets.some((target) => target.id === id)),
  });

  playbackRecovery.begin(targets, cause);
}

/**
 * One-time bindings the recovery path needs.
 *
 * Clicking into a cross-origin iframe blurs the parent window and leaves
 * document.activeElement pointing at that iframe — the only parent-side signal
 * that a user is driving a specific player, and therefore the only way to tell
 * a pause they chose from one the resize caused.
 */
let engagementBound = false;

export function bindPlaybackRecovery(): void {
  if (engagementBound) return;
  engagementBound = true;

  window.addEventListener('blur', () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLIFrameElement)) return;
    const card = active.closest<HTMLElement>('.stream-card');
    if (!card) return;
    card.dataset.userEngagedAt = String(Date.now());
    logPlayerEvent('user-engaged', { streamId: card.dataset.streamId });
  });
}

/**
 * 'api'-mode Twitch cards get real recovery via verifyAndRecoverTwitchPlayer.
 * Fallback-mode cards (script blocked/failed) keep the original blind
 * force-remount, since that's the only signal available for them. Skips the
 * focused stream either way — reloading the one stream someone is actively
 * watching is more disruptive than a muted-tile stall.
 */
export function recoverStalledTwitchPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    if (focusedStreamId !== null && card.dataset.streamId === focusedStreamId) continue;

    const spreadMs = Number(card.dataset.recoverySpreadMs ?? '0');

    window.setTimeout(() => {
      // Re-check: card state can change during the spread delay (tab hidden,
      // focused, removed) between when the sweep started and this fires.
      if (!card.isConnected) return;
      if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return;
      if (focusedStreamId !== null && card.dataset.streamId === focusedStreamId) return;

      if (card.dataset.twitchMode === 'fallback') {
        mountTwitchIframeForced(card, preferredMuted(card), 'watchdog');
        return;
      }

      verifyAndRecoverTwitchPlayer(card);
    }, spreadMs);
  }
}

const STATS_PROBE_INTERVAL_MS = 5000;

/**
 * Phase C2 diagnostic probe (see the plan) — samples every api-mode Twitch
 * card's isPaused()/getCurrentTime()/getPlaybackStats() every ~5s and logs
 * them via logStatsSample. Purpose: capture what a genuinely stuck player's
 * signals actually look like before writing a stuck-detector, instead of
 * guessing again. No-ops entirely unless ?debug=stats is active; read-only,
 * never calls play()/pause()/setChannel().
 */
export function startStatsProbe(container: HTMLElement): void {
  if (!statsDebugEnabled) return;

  window.setInterval(() => {
    for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
      if (card.dataset.platform !== 'twitch' || card.dataset.twitchMode !== 'api') continue;

      const streamId = card.dataset.streamId ?? '';
      const player = twitchPlayers.get(streamId);
      if (!player) continue;

      let isPaused: boolean | 'error' = 'error';
      let currentTime: number | 'error' = 'error';
      let stats: unknown = 'error';

      try {
        isPaused = player.isPaused();
      } catch {
        // Leave as 'error' — an exception is itself a signal worth logging.
      }
      try {
        currentTime = player.getCurrentTime();
      } catch {
        // Leave as 'error'.
      }
      try {
        stats = player.getPlaybackStats();
      } catch {
        // Leave as 'error'.
      }

      const iframe = streamIframe(card);
      const rect = iframe?.getBoundingClientRect();

      logStatsSample({
        streamId,
        channel: card.dataset.channel,
        isPaused,
        currentTime,
        stats,
        size: rect ? `${Math.round(rect.width)}×${Math.round(rect.height)}` : undefined,
      });
    }
  }, STATS_PROBE_INTERVAL_MS);
}

/**
 * Gentle, escalation-free sweep for api-mode cards — reused by any "user
 * just showed up" signal (mouse movement, pointer down). A visibilitychange
 * or timer-driven play() call isn't a genuine user gesture, and browsers can
 * silently ignore a resume request after a real background/throttled period
 * without one — a real mouse movement satisfies that requirement. Never
 * escalates to setChannel(): only the 90s watchdog's own slow cadence may.
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
        logPlayerEvent('destroy', { streamId: id, channel: card.dataset.channel });
        twitchPlayers.get(id)?.destroy();
        forgetTwitchPlayer(id);
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
