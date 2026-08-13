import {
  embedDebugEnabled,
  logEmbedEvent,
  logPlayerEvent,
  logStatsSample,
  reportEmbedRecovery,
  statsDebugEnabled,
} from '../lib/embedDebug';
import { createPlaybackRecovery, type RecoveryTarget } from '../lib/playbackRecovery';
import { formatTwitchLiveDuration } from '../lib/twitchDuration';
import { formatTwitchViewerCount } from '../lib/twitchViewerCount';
import {
  createTwitchStatusCoordinator,
  type TwitchStatusRefreshReason,
  type TwitchStatusRefreshResult,
} from '../lib/twitchStatusCoordinator';
import {
  createYouTubeStatusCoordinator,
  type YouTubeStatsRefreshReason,
  type YouTubeStatsRefreshResult,
} from '../lib/youtubeStatusCoordinator';
import { isStackedStreamLayout } from '../lib/viewport';
import mpegts from 'mpegts.js';
import { getAdapter, buildEmbedUrl } from '../platforms';
import {
  describeTikTokState,
  resolveTikTokLive,
  TIKTOK_LIVE_ENABLED,
  type TikTokQuality,
  type TikTokResolveResult,
} from '../platforms/tiktok';
import { twitchParentList } from '../platforms/twitch';
import { parseYouTubeToken, type YouTubeParsedToken } from '../platforms/youtube';
import {
  resolveYouTubeChannelLive,
  type YouTubeResolveMode,
  type YouTubeResolveResult,
} from '../platforms/youtubeResolver';
import { checkTwitchStatus, type TwitchStatusResult } from '../platforms/twitchStatus';
import { checkYouTubeStats, type YouTubeStatsResult } from '../platforms/youtubeStats';
import {
  computeFocusViewLayout,
  computeWeightedGridLayout,
  targetVisibleTrayCount,
  GRID_GAP,
  GRID_PADDING,
  CARD_HEADER_HEIGHT,
  MAX_GRID_COLUMNS,
  type WeightedGridItem,
} from '../lib/gridLayout';
import type { StreamRef, StreamOrientation } from '../types';
import type { StreamStore } from '../state/streams';
import type { ViewMode } from '../state/viewMode';

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

/**
 * External YouTube volume control icons (see createYouTubeVolumeControl).
 * Same 16x16 box and stroke weight as the other toolbar glyphs so the
 * control reads as part of the same icon set, not a bolted-on import.
 */
const ICON_VOLUME_ON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M2 6.25h2.4L8 3.25v9.5L4.4 9.75H2v-3.5Z" fill="currentColor"/>' +
  '<path d="M10.3 5.3c.9.75 1.4 1.7 1.4 2.7s-.5 1.95-1.4 2.7M12 3.6c1.4 1.2 2.2 2.75 2.2 4.4s-.8 3.2-2.2 4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '</svg>';

const ICON_VOLUME_OFF =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M2 6.25h2.4L8 3.25v9.5L4.4 9.75H2v-3.5Z" fill="currentColor"/>' +
  '<path d="M10.6 5.4 14 8.8M14 5.4l-3.4 3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '</svg>';

type FocusChangeHandler = (focused: boolean, streamId: string | null) => void;

let focusedStreamId: string | null = null;
let focusSessionActive = false;
let focusChangeHandler: FocusChangeHandler | null = null;
/**
 * Focus View's primary stream — distinct from focusedStreamId (the solo
 * fullscreen "Focus" feature above). Focus View never hides or freezes other
 * streams; it just resizes the whole grid into one large primary plus a
 * scrollable tray of the rest, via CSS vars (see updateFocusViewLayout) —
 * same "JS computes px, CSS consumes vars" approach updateGridLayout already
 * uses, so no player is ever remounted by switching modes or promoting a
 * different stream to primary.
 */
let focusViewPrimaryId: string | null = null;
/**
 * Api-mode Twitch players confirmed playing right before the current focus
 * session started, captured before freezeFocusHiddenPlayers pauses anything —
 * the only moment "should still be playing after exit" can be read. Cleared
 * the instant it's consumed (or superseded by a new focus transaction), so it
 * never outlives the session it describes.
 */
let focusEntrySnapshot: { ids: readonly string[]; startedAt: number } | null = null;
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
 * YouTube state. Deliberately minimal compared to Twitch's — YouTube has a
 * real pause API (no Kick-style blank-src hack needed) and this app adds no
 * watchdog/recovery loop for it at all (see the autoplay policy note above
 * mountYouTubeMedia): a player is constructed once, paused on freeze, and
 * only ever resumed by a genuine user gesture. There is nothing here for a
 * timer to check.
 */
const youtubePlayers = new Map<string, YT.Player>();
const youtubeResolveControllers = new Map<string, AbortController>();
let youtubeScriptPromise: Promise<boolean> | null = null;
const YOUTUBE_SCRIPT_TIMEOUT_MS = 4000;

/**
 * TikTok LIVE state — experimental, not an official TikTok integration (see
 * platforms/tiktok.ts's module doc comment). No iframe, no Twitch-style
 * watchdog/recovery loop: a resolve either succeeds once (mpegts.js attaches
 * to a plain <video>, and stays attached — pause/resume via the video
 * element's own native API, exactly like YouTube's real pause API) or fails
 * into a distinct, non-retrying error state (see describeTikTokState). A
 * failed resolve never auto-retries — see mountTikTokMedia.
 */
const tiktokPlayers = new Map<string, { player: ReturnType<typeof mpegts.createPlayer>; video: HTMLVideoElement }>();
const tiktokResolveControllers = new Map<string, AbortController>();

/**
 * External volume control state, tracked locally rather than re-read from
 * the player after every change. The IFrame API's mute()/unMute()/setVolume()
 * are fire-and-forget postMessage calls to the embed's own document —
 * isMuted()/getVolume() reflect the reply, which has not necessarily arrived
 * yet in the same tick a click handler calls mute() and then immediately
 * wants to paint the new state. Since this app is the only thing that ever
 * calls these setters, our own intent is authoritative and reading it back
 * from the map avoids that race entirely. The one place a live read is
 * trustworthy is the player's onReady — its first, definitive state.
 */
const youtubeVolumeState = new Map<string, { muted: boolean; volume: number }>();

/**
 * Each card renders up to two independent volume-panel instances (header,
 * headers-hidden hover toolbar — see createYouTubeVolumeControl), each with
 * its own closePanel() closure. Entering Focus mode must force both closed
 * if either was left open from grid view, so the header doesn't get stuck in
 * is-volume-mode once the focused-card trigger stops opening it at all (see
 * toggleStreamFocus). Calling closePanel() itself (rather than toggling the
 * class directly) matters — it also detaches that instance's own outside-
 * pointerdown listener, which a direct class removal would leak.
 */
const youtubeVolumePanelClosers = new Map<string, Array<() => void>>();

/**
 * Exactly one YouTube player, ever, per page session, may be constructed
 * with autoplay requested: the very first one mounted. YouTube's own policy
 * forbids multiple simultaneously autoplaying embeds, and the only way to
 * guarantee that deterministically — without inventing a "was this the one
 * that was supposed to keep playing" bookkeeping system like Twitch's — is
 * to grant the privilege exactly once and never again automatically. Every
 * later start (additional adds, focus-exit, tab-resume) requires a real
 * click; see mountYouTubeMedia and toggleStreamFocus's youtube branch.
 */
let youtubeAutoplayGranted = false;

function grantYouTubeAutoplayOnce(): boolean {
  if (youtubeAutoplayGranted) return false;
  youtubeAutoplayGranted = true;
  return true;
}

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
  syncTwitchMutePollTimer();
}

let twitchMutePollTimerId = 0;
/** Frequent enough that the header icon feels live, cheap enough not to matter — every check below is a local getter, no network. */
const TWITCH_MUTE_POLL_INTERVAL_MS = 1500;

/** Test-only: mirrors __resetYouTubeDurationTimerForTests. Not called anywhere in production code. */
export function __resetTwitchMutePollTimerForTests(): void {
  if (twitchMutePollTimerId) {
    window.clearInterval(twitchMutePollTimerId);
    twitchMutePollTimerId = 0;
  }
}

/**
 * Twitch's own player chrome (visible on hover/click inside the embed) has
 * its own mute/volume slider, entirely internal to the iframe — the Player
 * JS API fires no event when the viewer touches it, only getMuted() and
 * getVolume() getters exist. Unlike YouTube's mute()/unMute() (see
 * youtubeVolumeState's own doc comment on why a read right after our own
 * write races the postMessage reply), this only ever *reads* — there's
 * nothing here for our own writes to race — so getMuted() is safe to poll
 * and trust outright. One shared timer for every api-mode Twitch player,
 * started on the first one and stopped once none remain, exactly mirroring
 * syncYouTubeDurationTimer's shared-timer shape.
 */
function syncTwitchMutePollTimer(): void {
  if (twitchPlayers.size === 0) {
    if (twitchMutePollTimerId) {
      window.clearInterval(twitchMutePollTimerId);
      twitchMutePollTimerId = 0;
    }
    return;
  }

  if (twitchMutePollTimerId) return;
  twitchMutePollTimerId = window.setInterval(() => {
    if (document.hidden) return;
    for (const [streamId, player] of twitchPlayers) {
      const liveMuted = safeCall(() => player.getMuted());
      if (liveMuted === undefined) continue;
      const card = cardForStream(streamId);
      if (!card || liveMuted === preferredMuted(card)) continue;
      card.dataset.embedMuted = liveMuted ? '1' : '0';
      syncTwitchMuteUi(card);
    }
  }, TWITCH_MUTE_POLL_INTERVAL_MS);
}

let youtubeFocusMutePollTimerId = 0;
let youtubeFocusMutePollStreamId: string | null = null;

/**
 * YouTube's own player chrome has the same limitation Twitch's does (see
 * syncTwitchMutePollTimer just above) — isMuted()/getVolume() getters, no
 * change event — so the focused card's compact toggle needs the same
 * polling to catch a viewer adjusting YouTube's native volume control
 * directly. Deliberately scoped to only the focused stream: only the
 * focused card's trigger acts as a plain toggle (see
 * createYouTubeVolumeControl) — grid tiles still use the open-a-panel flow,
 * where every change already goes through our own mute()/unMute()/
 * setVolume() calls and youtubeVolumeState is authoritative (see that map's
 * own doc comment), so polling there would be pointless.
 */
function syncYouTubeFocusMutePollTimer(): void {
  const shouldRunFor =
    focusedStreamId && youtubePlayers.has(focusedStreamId) ? focusedStreamId : null;

  if (youtubeFocusMutePollTimerId && youtubeFocusMutePollStreamId !== shouldRunFor) {
    window.clearInterval(youtubeFocusMutePollTimerId);
    youtubeFocusMutePollTimerId = 0;
    youtubeFocusMutePollStreamId = null;
  }

  if (!shouldRunFor || youtubeFocusMutePollTimerId) return;

  youtubeFocusMutePollStreamId = shouldRunFor;
  youtubeFocusMutePollTimerId = window.setInterval(() => {
    if (document.hidden) return;
    const streamId = youtubeFocusMutePollStreamId;
    const player = streamId ? youtubePlayers.get(streamId) : undefined;
    if (!streamId || !player) return;
    const liveMuted = safeCall(() => player.isMuted());
    if (liveMuted === undefined) return;
    const state = youtubeVolumeState.get(streamId) ?? { muted: true, volume: 0 };
    if (liveMuted === state.muted) return;
    const liveVolume = safeCall(() => player.getVolume());
    youtubeVolumeState.set(streamId, {
      muted: liveMuted,
      volume: liveVolume !== undefined ? Math.round(liveVolume) : state.volume,
    });
    const card = cardForStream(streamId);
    if (card) syncYouTubeVolumeUi(card);
  }, TWITCH_MUTE_POLL_INTERVAL_MS);
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
  container.style.removeProperty('--portrait-row-span');
  container.style.removeProperty('--portrait-content-width');
  container.style.removeProperty('--portrait-content-height');
  container.style.removeProperty('--kick-col-min');
  container.style.removeProperty('--kick-render-width');
  container.style.removeProperty('--kick-scale');
  clearFocusViewVars(container);
}

function clearFocusViewVars(container: HTMLElement): void {
  container.style.removeProperty('--focus-primary-width');
  container.style.removeProperty('--focus-primary-height');
  container.style.removeProperty('--focus-primary-row-height');
  container.style.removeProperty('--focus-tray-height');
  container.style.removeProperty('--focus-tray-row-height');
  container.style.removeProperty('--focus-tray-column-width');
  container.style.removeProperty('--focus-tray-count');
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
  syncTwitchMuteUi(card);
  syncTwitchMutePollTimer();

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
  syncTwitchMuteUi(card);

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
  syncTwitchMuteUi(card);

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

let youtubeMountTargetSeq = 0;

function createYouTubeMountTarget(): HTMLDivElement {
  const target = document.createElement('div');
  target.id = `youtube-embed-${++youtubeMountTargetSeq}`;
  target.className = 'stream-card__youtube-target';
  return target;
}

/**
 * Persistent, positioned wrapper — carries `.stream-card__iframe` (the
 * shared absolute/full-size CSS rule) so sizing never depends on what's
 * currently mounted inside it: a bare target div awaiting construction, a
 * constructed YT.Player's own iframe, or a status message. Only this
 * wrapper's *children* are ever swapped; the wrapper itself is created once
 * and never replaced, so generic per-card lookups (`.stream-card__iframe`)
 * keep working exactly as they do for Twitch/Kick.
 */
function createYouTubePlayerWrap(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'stream-card__iframe stream-card__youtube-wrap';
  wrap.append(createYouTubeMountTarget());
  return wrap;
}

function ensureYouTubeMountTarget(card: HTMLElement): HTMLElement | null {
  const wrap = card.querySelector<HTMLElement>('.stream-card__youtube-wrap');
  if (!wrap) return null;
  wrap.replaceChildren();
  const target = createYouTubeMountTarget();
  wrap.append(target);
  return target;
}

/** Placeholder / offline / error text — replaces the wrap's children, never stacks over a live player. */
function showYouTubeMessage(card: HTMLElement, text: string): void {
  const wrap = card.querySelector<HTMLElement>('.stream-card__youtube-wrap');
  if (!wrap) return;
  wrap.replaceChildren();
  const message = document.createElement('div');
  message.className = 'stream-card__youtube-status';
  message.textContent = text;
  wrap.append(message);
}

/** developers.google.com/youtube/iframe_api_reference#onError */
function mapYouTubeErrorCode(code: number): string {
  switch (code) {
    case 2:
      return "That doesn't look like a valid YouTube video.";
    case 5:
      return "This video can't be played right now.";
    case 100:
      return 'This video is unavailable or private.';
    case 101:
    case 150:
      return 'The channel owner has disabled embedding for this video.';
    default:
      return "This YouTube video couldn't be loaded.";
  }
}

/** developers.google.com/youtube/iframe_api_reference#onStateChange */
const YT_STATE_NAMES: Record<number, string> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
};

/** Diagnostic-only: a getter can throw mid-teardown; never let that break playback. */
function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Lazily loads YouTube's IFrame Player API once, shared by every YouTube
 * card, mirroring ensureTwitchEmbedScript exactly (including the ad-blocker
 * fallback path below).
 */
function ensureYouTubeIframeApi(): Promise<boolean> {
  if (youtubeScriptPromise) return youtubeScriptPromise;

  youtubeScriptPromise = new Promise<boolean>((resolve) => {
    if (window.YT?.Player) {
      resolve(true);
      return;
    }

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (!ok) {
        logEmbedEvent('script-fallback', { platform: 'youtube' });
        reportEmbedRecovery('script-fallback', { platform: 'youtube' });
      }
      resolve(ok);
    };

    const timer = window.setTimeout(() => finish(false), YOUTUBE_SCRIPT_TIMEOUT_MS);

    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      window.clearTimeout(timer);
      finish(Boolean(window.YT?.Player));
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      finish(false);
    };
    document.head.append(script);
  });

  return youtubeScriptPromise;
}

/** Only place a bare YouTube iframe gets built — the script-load-failed path. No onError detection in this mode (same limitation Twitch's fallback mode already accepts). */
function mountYouTubeFallbackIframe(
  mountTarget: HTMLElement,
  videoId: string,
  autoplay: boolean,
): void {
  const iframe = document.createElement('iframe');
  iframe.className = 'stream-card__youtube-target';
  iframe.allowFullscreen = true;
  iframe.title = `YouTube video: ${videoId}`;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.setAttribute(
    'allow',
    autoplay
      ? 'autoplay; fullscreen; picture-in-picture; encrypted-media'
      : 'fullscreen; picture-in-picture; encrypted-media',
  );
  iframe.src = buildEmbedUrl({ platform: 'youtube', channel: `video:${videoId}` }, true, {
    autoplay,
  });
  mountTarget.replaceWith(iframe);
}

function constructYouTubePlayer(
  card: HTMLElement,
  mountTarget: HTMLElement,
  videoId: string,
  autoplay: boolean,
): void {
  const streamId = card.dataset.streamId ?? '';
  if (!streamId) return;

  const player = new YT.Player(mountTarget.id, {
    width: '100%',
    height: '100%',
    videoId,
    playerVars: {
      autoplay: autoplay ? 1 : 0,
      mute: 1,
      playsinline: 1,
      modestbranding: 1,
      rel: 0,
      origin: window.location.origin,
    },
    events: {
      onReady: () => {
        // The one point a live read is trustworthy — see youtubeVolumeState.
        try {
          youtubeVolumeState.set(streamId, {
            muted: player.isMuted(),
            volume: Math.round(player.getVolume()),
          });
        } catch {
          // Leave unset; syncYouTubeVolumeUi treats a missing entry as
          // "not available yet" and disables the control.
        }
        syncYouTubeVolumeUi(card);
        syncYouTubeFocusMutePollTimer();
      },
      onStateChange: (event) => {
        // Diagnostic-only: never call playVideo()/pauseVideo() from here —
        // this handler only observes and logs, it must not react.
        logPlayerEvent('yt-state', {
          streamId,
          state: YT_STATE_NAMES[event.data] ?? event.data,
          currentTime: safeCall(() => player.getCurrentTime()),
          duration: safeCall(() => player.getDuration()),
          muted: safeCall(() => player.isMuted()),
          volume: safeCall(() => player.getVolume()),
          iframeId: mountTarget.id,
          visibility: document.visibilityState,
          hasFocus: document.hasFocus(),
          fullscreen: Boolean(document.fullscreenElement),
          cardFocused: card.matches(':focus-within'),
          headersHidden: document.documentElement.classList.contains('headers-hidden'),
          tileSize: `${Math.round(card.clientWidth)}x${Math.round(card.clientHeight)}`,
          playerCount: youtubePlayers.size,
        });
      },
      onError: (event) => {
        logEmbedEvent('player-blocked', { platform: 'youtube', channel: card.dataset.channel, card });
        youtubePlayers.delete(streamId);
        youtubeVolumeState.delete(streamId);
        showYouTubeMessage(card, mapYouTubeErrorCode(event.data));
        // Otherwise the mute/volume control is left showing stale state and
        // silently ignores clicks forever — syncYouTubeVolumeUi's `available`
        // check reads youtubePlayers.has(streamId), false again now.
        syncYouTubeVolumeUi(card);
        syncYouTubeFocusMutePollTimer();
      },
    },
  });

  youtubePlayers.set(streamId, player);
  card.dataset.embedMuted = '1';
}

/**
 * Reflects live player state (or a disabled placeholder while no player is
 * attached yet) into every external volume control rendered for this card —
 * there are up to two: the header's and the headers-hidden hover toolbar's,
 * only one of which is ever visible at a time, but both must stay correct
 * since either can become visible without a remount (Show headers toggle).
 *
 * Reads from youtubeVolumeState, never the live player — see that map's own
 * comment for why a synchronous re-read right after our own mute()/unMute()/
 * setVolume() call would race the postMessage round trip. Never touches
 * playback either way. The slider always displays 0 while muted
 * (independent of the underlying volume level YouTube remembers), which is
 * the conventional "muted reads as silent" meter behavior and avoids
 * implying a click on the slider will unmute.
 */
function syncYouTubeVolumeUi(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';
  const state = youtubeVolumeState.get(streamId);
  const available = state !== undefined && youtubePlayers.has(streamId);
  const muted = state?.muted ?? true;
  const displayedVolume = muted ? 0 : (state?.volume ?? 0);

  // Up to 4 buttons per card: header/toolbar triggers (open the panel, keep
  // a static "open controls" label — see createYouTubeVolumeControl) and
  // header/toolbar panel mute buttons (a real toggle, label follows state).
  for (const button of card.querySelectorAll<HTMLButtonElement>('.stream-card__mute-btn')) {
    button.disabled = !available;
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
    if (button.dataset.role === 'trigger') continue;
    const label = muted ? 'Unmute YouTube video' : 'Mute YouTube video';
    button.title = muted ? 'Unmute' : 'Mute';
    button.setAttribute('aria-label', label);
  }

  for (const slider of card.querySelectorAll<HTMLInputElement>('.stream-card__youtube-volume-slider')) {
    slider.disabled = !available;
    slider.value = String(displayedVolume);
    slider.setAttribute('aria-valuenow', String(displayedVolume));
    slider.setAttribute('aria-valuetext', `${displayedVolume}%`);
  }
}

/**
 * Twitch-style toggle: flips mute only, keeps the stored volume level intact
 * for later unmute. Shared by the panel's own mute button and the focused-
 * card trigger (see createYouTubeVolumeControl) so the two paths can never
 * drift from each other.
 */
function toggleYouTubeMute(streamId: string): void {
  const player = youtubePlayers.get(streamId);
  if (!player) return;
  const state = youtubeVolumeState.get(streamId) ?? { muted: true, volume: 0 };
  const nextMuted = !state.muted;
  if (nextMuted) {
    player.mute();
  } else {
    player.unMute();
  }
  youtubeVolumeState.set(streamId, { muted: nextMuted, volume: state.volume });
  const card = cardForStream(streamId);
  if (card) syncYouTubeVolumeUi(card);
}

/**
 * External YouTube volume control for one card footer (header or the
 * headers-hidden hover toolbar): a compact status/trigger button that sits
 * among the footer's other action buttons, plus a full-width adjustment
 * panel that takes over the whole footer while open. Only mute()/unMute()/
 * setVolume()/getVolume() are ever called here — deliberately never
 * playVideo/pauseVideo/cueVideoById/loadVideoById/destroy, and never the
 * iframe's src — so adjusting volume, or opening/closing the panel, can
 * never pause, restart, or reconstruct the player.
 *
 * `footer` is the caller's `.stream-card__header` or `.stream-card__toolbar`
 * element. Open/close state lives on it as an `is-volume-mode` class (see
 * main.css) rather than in a JS map — the caller appends `panel` as an
 * extra direct child of `footer`, and CSS hides `footer`'s other children
 * while that class is present, so there's nothing to keep in sync beyond
 * the DOM itself.
 *
 * Disabled (and left at 0%) until a live player is actually attached for
 * this stream — see syncYouTubeVolumeUi, called on the player's onReady and
 * after every mute/unmute/volume change so both rendered copies (header,
 * hover toolbar) never drift out of sync with each other or the player.
 */
function createYouTubeVolumeControl(
  streamId: string,
  footer: HTMLElement,
): { trigger: HTMLButtonElement; panel: HTMLDivElement; closePanel: () => void } {
  function currentState(): { muted: boolean; volume: number } {
    return youtubeVolumeState.get(streamId) ?? { muted: true, volume: 0 };
  }

  function syncCard(): void {
    const card = cardForStream(streamId);
    if (card) syncYouTubeVolumeUi(card);
  }

  // --- trigger: compact status button, opens the panel ---------------

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'stream-card__mute-btn';
  trigger.dataset.role = 'trigger';
  trigger.title = 'Volume';
  trigger.setAttribute('aria-label', 'Open YouTube volume controls');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.disabled = true;
  trigger.innerHTML = ICON_VOLUME_OFF;
  // Mirrors the panel controls' own stopPropagation below — without this, a
  // pointerdown-then-move on the trigger (not just a click) is unprotected
  // against SortableJS's drag-start detection in headers-visible mode,
  // since the trigger lives inside the header (the drag handle there) and
  // isn't in Sortable's `filter` list.
  trigger.addEventListener('pointerdown', (event) => event.stopPropagation());
  trigger.addEventListener('mousedown', (event) => event.stopPropagation());
  trigger.addEventListener('touchstart', (event) => event.stopPropagation());
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    // Focused (Focus mode): behave like Twitch's mute button — a plain
    // toggle, no panel takeover. The full-width panel exists for dense grid
    // tiles that have no room for a slider next to the other controls; a
    // focused card has plenty of room, and the takeover was confusing there.
    if (focusedStreamId === streamId) {
      toggleYouTubeMute(streamId);
      return;
    }
    openPanel();
  });

  // --- panel: mute button, full-width slider, close ------------------

  const panel = document.createElement('div');
  panel.className = 'stream-card__youtube-volume-panel';

  const panelButton = document.createElement('button');
  panelButton.type = 'button';
  panelButton.className = 'stream-card__mute-btn';
  panelButton.title = 'Mute';
  panelButton.setAttribute('aria-label', 'Mute YouTube video');
  panelButton.setAttribute('aria-pressed', 'true');
  panelButton.disabled = true;
  panelButton.innerHTML = ICON_VOLUME_OFF;
  panelButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  panelButton.addEventListener('mousedown', (event) => event.stopPropagation());
  panelButton.addEventListener('touchstart', (event) => event.stopPropagation());
  panelButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleYouTubeMute(streamId);
  });

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'stream-card__youtube-volume-slider';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = '0';
  slider.disabled = true;
  slider.setAttribute('aria-label', 'YouTube volume');
  slider.setAttribute('aria-valuemin', '0');
  slider.setAttribute('aria-valuemax', '100');
  slider.setAttribute('aria-valuenow', '0');
  slider.setAttribute('aria-valuetext', '0%');
  // Reordering (SortableJS) and card-level pointer handling live above this
  // control in the tree — stop propagation so a drag never starts, and a
  // click never bubbles into anything else, while dragging the thumb.
  // Pointer capture keeps input/pointerup targeting the slider even if a
  // fast or sloppy drag carries the pointer outside its bounding box.
  slider.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    try {
      slider.setPointerCapture(event.pointerId);
    } catch {
      // Not supported for this pointer type — drag still works via normal
      // event bubbling, capture is a reliability improvement, not a
      // requirement.
    }
  });
  slider.addEventListener('mousedown', (event) => event.stopPropagation());
  slider.addEventListener('touchstart', (event) => event.stopPropagation());
  slider.addEventListener('click', (event) => event.stopPropagation());
  slider.addEventListener('input', (event) => {
    event.stopPropagation();
    const player = youtubePlayers.get(streamId);
    if (!player) return;
    const value = Number(slider.value);
    const state = currentState();
    const nextMuted = value === 0;
    player.setVolume(value);
    if (nextMuted !== state.muted) {
      if (nextMuted) {
        player.mute();
      } else {
        player.unMute();
      }
    }
    // Dragging to 0 mutes but must not forget the level to restore on
    // unmute — only a genuine nonzero position updates the stored volume.
    const nextVolume = value === 0 ? state.volume : value;
    youtubeVolumeState.set(streamId, { muted: nextMuted, volume: nextVolume });
    syncCard();
  });

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'stream-card__youtube-volume-panel-close';
  closeButton.title = 'Close volume controls';
  closeButton.setAttribute('aria-label', 'Close volume controls');
  closeButton.innerHTML = ICON_CLOSE;
  closeButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  closeButton.addEventListener('mousedown', (event) => event.stopPropagation());
  closeButton.addEventListener('touchstart', (event) => event.stopPropagation());
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    closePanel();
  });

  panel.append(panelButton, slider, closeButton);

  // --- open/close state, kept on the DOM via `is-volume-mode` ---------

  let outsidePointerDownTimer: ReturnType<typeof setTimeout> | undefined;

  function onOutsidePointerDown(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (target && footer.contains(target)) return;
    closePanel();
  }

  function openPanel(): void {
    if (footer.classList.contains('is-volume-mode')) return;
    footer.classList.add('is-volume-mode');
    trigger.setAttribute('aria-expanded', 'true');
    slider.focus();
    // Deferred so the same click that opened the panel (still bubbling to
    // `document` at this point) doesn't immediately close it again.
    outsidePointerDownTimer = setTimeout(() => {
      document.addEventListener('pointerdown', onOutsidePointerDown, true);
    }, 0);
  }

  function closePanel(): void {
    if (!footer.classList.contains('is-volume-mode')) return;
    footer.classList.remove('is-volume-mode');
    trigger.setAttribute('aria-expanded', 'false');
    clearTimeout(outsidePointerDownTimer);
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    trigger.focus();
  }

  // Bubble-phase listener on the footer itself: fires regardless of which
  // element inside the panel has focus, and stopPropagation here keeps
  // Escape from also reaching any card/global Escape handler (e.g.
  // exit-focus-mode) while the panel is open.
  footer.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!footer.classList.contains('is-volume-mode')) return;
    event.stopPropagation();
    closePanel();
  });

  return { trigger, panel, closePanel };
}

/**
 * Plain Twitch mute toggle: button only, no slider/panel — setMuted()/
 * getMuted() cover mute, and there's no adjustable-volume API to expose the
 * way YouTube's is. Shares .stream-card__mute-btn (and its icon set) with
 * the YouTube volume trigger so a muted/unmuted stream reads identically
 * across platforms, including at a glance across several streams left
 * unmuted at once.
 */
function createTwitchMuteButton(streamId: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'stream-card__mute-btn';
  // Mirrors the YouTube trigger's own stopPropagation — the button lives in
  // the header, Sortable's drag handle in headers-visible mode.
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('mousedown', (event) => event.stopPropagation());
  button.addEventListener('touchstart', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const card = cardForStream(streamId);
    if (card) toggleTwitchMute(card);
  });
  return button;
}

/**
 * Toggles the current card's Twitch mute state. 'api' mode mutes live via
 * the player, no reload; 'fallback' (embed script blocked) has no such API,
 * so it goes through mountTwitchIframe's normal reload-with-new-mute-param
 * path instead — the same mechanism focus-unmute already uses for fallback
 * mode. 'pending' just records the preference for the in-flight mount to
 * read once it resolves (see mountStreamMedia).
 */
function toggleTwitchMute(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';
  const nextMuted = !preferredMuted(card);
  const mode = card.dataset.twitchMode;

  if (mode === 'fallback') {
    mountTwitchIframe(card, nextMuted, 'focus-unmute');
  } else {
    twitchPlayers.get(streamId)?.setMuted(nextMuted);
    card.dataset.embedMuted = nextMuted ? '1' : '0';
  }
  syncTwitchMuteUi(card);
}

/** Keeps every rendered copy of the Twitch mute button (header, headers-hidden hover toolbar) in sync with card.dataset.embedMuted. */
function syncTwitchMuteUi(card: HTMLElement): void {
  const muted = preferredMuted(card);
  const label = muted ? 'Unmute stream' : 'Mute stream';
  for (const button of card.querySelectorAll<HTMLButtonElement>('.stream-card__mute-btn')) {
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
    button.title = label;
    button.setAttribute('aria-label', label);
  }
}

/** Ends the async chain from mountYouTubeMedia's first-ever-mount branch, for both a direct video and a resolved-live channel. */
async function startYouTubePlayer(card: HTMLElement, videoId: string, autoplay: boolean): Promise<void> {
  const available = await ensureYouTubeIframeApi();
  if (!card.isConnected) return;
  if (card.dataset.youtubeMountState !== 'pending') return; // superseded meanwhile (removed/reloaded)

  const mountTarget = ensureYouTubeMountTarget(card);
  if (!mountTarget) return;

  // The videoId a periodic stats refresh polls for this card — see
  // refreshAllYouTubeStats, which reads this dataset attribute rather than
  // re-deriving it from the stream's token (a channel token's live videoId
  // can change between refreshes; a direct-video token's cannot).
  card.dataset.youtubeVideoId = videoId;

  if (!available) {
    mountYouTubeFallbackIframe(mountTarget, videoId, autoplay);
    card.dataset.youtubeMode = 'fallback';
    card.dataset.youtubeMountState = 'mounted';
    card.dataset.embedMuted = '1';
    return;
  }

  constructYouTubePlayer(card, mountTarget, videoId, autoplay);
  card.dataset.youtubeMode = 'api';
  card.dataset.youtubeMountState = 'mounted';
}

/**
 * Channel/handle/username tokens need a live-video lookup before anything
 * can be mounted — this is the one place in the whole YouTube path that
 * calls the network (public/api/youtube-resolve.php). Direct video tokens
 * never reach this function.
 */
async function resolveAndMountYouTubeChannel(
  card: HTMLElement,
  token: Extract<YouTubeParsedToken, { resolutionType: 'channel' }>,
  autoplay: boolean,
): Promise<void> {
  const streamId = card.dataset.streamId ?? '';
  showYouTubeMessage(card, 'Checking for live stream…');

  const controller = new AbortController();
  youtubeResolveControllers.set(streamId, controller);

  const mode: YouTubeResolveMode = token.kind;
  const value =
    token.kind === 'handle' ? token.handle : token.kind === 'username' ? token.username : token.channelId;

  let result: YouTubeResolveResult;
  try {
    result = await resolveYouTubeChannelLive(mode, value, controller.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return; // card removed meanwhile
    result = {
      status: 'error',
      code: 'network_error',
      message: "Couldn't reach the stream lookup service.",
    };
  }

  youtubeResolveControllers.delete(streamId);
  if (!card.isConnected) return;
  if (card.dataset.youtubeMountState !== 'pending') return; // superseded meanwhile

  if (result.status === 'live') {
    if (result.channelTitle) {
      // Two independent instances per card (header + hover toolbar) — update both.
      for (const nameChannel of card.querySelectorAll<HTMLElement>('.stream-card__name-badge-channel')) {
        nameChannel.textContent = result.channelTitle;
      }
    }

    // First paint of viewer count/duration — this same request already
    // fetched them (see resolve_live_video's follow-up in
    // youtube-resolve.php), so there's no reason to wait for the periodic
    // scheduler's next tick just to show them. Set videoId synchronously
    // (ahead of startYouTubePlayer's own, later, identical assignment) so a
    // stats refresh racing this mount always has something to match against.
    card.dataset.youtubeVideoId = result.videoId;
    if (result.viewerCount != null) {
      card.dataset.youtubeViewerCount = String(result.viewerCount);
    }
    if (result.startedAt) {
      card.dataset.youtubeStartedAt = result.startedAt;
    }
    const gridContainer = card.closest<HTMLElement>('#stream-grid');
    if (gridContainer) {
      renderYouTubeCardMeta(card, Date.now());
      syncYouTubeDurationTimer(gridContainer);
    }

    void startYouTubePlayer(card, result.videoId, autoplay);
    return;
  }

  if (result.status === 'offline') {
    showYouTubeMessage(card, "This channel isn't live right now.");
    card.dataset.youtubeMountState = 'offline';
    return;
  }

  showYouTubeMessage(card, result.message);
  card.dataset.youtubeMountState = 'error';
}

function forgetYouTubePlayer(streamId: string): void {
  youtubeResolveControllers.get(streamId)?.abort();
  youtubeResolveControllers.delete(streamId);
  youtubePlayers.get(streamId)?.destroy();
  youtubePlayers.delete(streamId);
  youtubeVolumeState.delete(streamId);
  youtubeVolumePanelClosers.delete(streamId);
  syncYouTubeFocusMutePollTimer();
}

/**
 * Dispatcher mirroring mountTwitchIframe/mountKickIframe's role, but with a
 * genuinely different shape: a YouTube card is only ever *constructed* once
 * ('mount', wherever it's first triggered from — fresh add, page-load
 * restore, or a delayed first tab-resume for a card that started hidden).
 * Every subsequent call for an already-mounted card is either a no-op
 * ('tab-resume'/'focus-resume' — see the autoplay policy above) or a real
 * user gesture ('focus-unmute').
 */
function mountYouTubeMedia(
  card: HTMLElement,
  reason: 'mount' | 'tab-resume' | 'focus-resume' | 'focus-unmute' = 'mount',
): void {
  const streamId = card.dataset.streamId ?? '';
  if (!streamId) return;
  if (card.dataset.tabFrozen === '1') return;

  const alreadyMounted =
    card.dataset.youtubeMountState === 'mounted' || card.dataset.youtubeMountState === 'pending';

  if (!alreadyMounted) {
    card.dataset.youtubeMountState = 'pending';
    const token = parseYouTubeToken(card.dataset.channel ?? '');
    if (!token) {
      showYouTubeMessage(card, "This YouTube link couldn't be understood.");
      card.dataset.youtubeMountState = 'error';
      return;
    }

    const autoplay = grantYouTubeAutoplayOnce();
    if (token.resolutionType === 'video') {
      // A direct video link never touches youtube-resolve.php (see the
      // module doc comment on parseYouTubeToken), so unlike the channel
      // path above there's no free viewer-count/duration data to seed from —
      // fire the same one-off stats check refreshAllYouTubeStats' periodic
      // tick would eventually make anyway, just sooner. Set videoId
      // synchronously first so that request has something to match once it
      // resolves, same reasoning as resolveAndMountYouTubeChannel's.
      card.dataset.youtubeVideoId = token.videoId;
      void startYouTubePlayer(card, token.videoId, autoplay);
      const gridContainer = card.closest<HTMLElement>('#stream-grid');
      if (gridContainer) refreshYouTubeStats(gridContainer, [token.videoId]);
      return;
    }
    void resolveAndMountYouTubeChannel(card, token, autoplay);
    return;
  }

  if (reason !== 'focus-unmute') {
    // 'tab-resume' / 'focus-resume': deliberate no-op. Resuming every
    // backgrounded YouTube card at once would itself be a simultaneous-
    // autoplay violation, so paused stays paused until a real click.
    return;
  }

  if (card.dataset.youtubeMode === 'fallback') {
    const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__youtube-wrap iframe');
    const match = iframe?.src.match(/\/embed\/([^?]+)/);
    if (iframe && match) {
      iframe.src = buildEmbedUrl({ platform: 'youtube', channel: `video:${match[1]}` }, false, {
        autoplay: true,
      });
    }
    card.dataset.embedMuted = '0';
    return;
  }

  const player = youtubePlayers.get(streamId);
  player?.unMute();
  player?.playVideo();
  card.dataset.embedMuted = '0';
  if (player) {
    const prevVolume = youtubeVolumeState.get(streamId)?.volume ?? 100;
    youtubeVolumeState.set(streamId, { muted: false, volume: prevVolume });
  }
  syncYouTubeVolumeUi(card);
}

/**
 * Manual per-card reload — always takes effect immediately (a real click),
 * unlike the autoplay-once policy above: it does not consume or check
 * youtubeAutoplayGranted, exactly mirroring reloadKickPlayer's "an explicit
 * user action is a different case" reasoning.
 */
function reloadYouTubePlayer(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';
  const token = parseYouTubeToken(card.dataset.channel ?? '');
  if (!streamId || !token) return;

  forgetYouTubePlayer(streamId);
  delete card.dataset.youtubeMode;
  card.dataset.youtubeMountState = 'pending';
  syncYouTubeVolumeUi(card); // no player until the new one's onReady fires

  reportEmbedRecovery('forced-remount', { platform: 'youtube', reason: 'manual' });

  if (token.resolutionType === 'video') {
    void startYouTubePlayer(card, token.videoId, true);
    return;
  }
  void resolveAndMountYouTubeChannel(card, token, true);
}

/**
 * Persistent wrapper, same role/shape as createYouTubePlayerWrap: carries
 * `.stream-card__iframe` (shared absolute/full-size CSS rule, including the
 * portrait 2-row Grid View sizing) so generic per-card lookups and layout
 * keep working exactly as they do for every iframe-based platform. Only
 * this wrapper's children (a status message, or the live <video>) are ever
 * swapped — the wrapper itself is created once and never replaced.
 */
function createTikTokPlayerWrap(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'stream-card__iframe stream-card__tiktok-wrap';
  return wrap;
}

function tiktokWrap(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>('.stream-card__tiktok-wrap');
}

/**
 * Placeholder / offline / invalid-creator / error text — never stacks over a
 * live video. `linkUsername`, when given, adds a plain "Open on TikTok" link
 * so a viewer can still reach the stream directly when resolve/playback
 * fails here — never shown for the loading state itself.
 */
function showTikTokMessage(card: HTMLElement, text: string, linkUsername?: string): void {
  const wrap = tiktokWrap(card);
  if (!wrap) return;
  wrap.replaceChildren();
  const message = document.createElement('div');
  message.className = 'stream-card__tiktok-status';
  message.textContent = text;
  wrap.append(message);

  if (linkUsername) {
    const link = document.createElement('a');
    link.className = 'stream-card__tiktok-status-link';
    link.href = `https://www.tiktok.com/@${linkUsername}/live`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open on TikTok';
    message.append(document.createElement('br'), link);
  }
}

/** Drops every trace of one TikTok player: in-flight resolve, mpegts player, video element. Safe to call on a card with none of those. */
function forgetTikTokPlayer(streamId: string): void {
  tiktokResolveControllers.get(streamId)?.abort();
  tiktokResolveControllers.delete(streamId);
  const entry = tiktokPlayers.get(streamId);
  if (entry) {
    safeCall(() => entry.player.pause());
    safeCall(() => entry.player.unload());
    safeCall(() => entry.player.detachMediaElement());
    safeCall(() => entry.player.destroy());
  }
  tiktokPlayers.delete(streamId);
}

/**
 * First-and-only construction of a TikTok card's player, mirroring
 * mountYouTubeMedia's shape: 'mount' resolves once and attaches; every
 * later call for an already-mounted card is either a no-op resume
 * ('tab-resume'/'focus-resume' — never re-resolves, so backgrounding and
 * returning cannot accumulate resolver requests) or a real user gesture
 * ('focus-unmute'). A failed resolve shows a distinct error state and does
 * NOT retry on its own — matching the "no retry loops" requirement; only a
 * manual reload (reloadTikTokPlayer) or reason 'mount' after that (e.g. a
 * remove+re-add, which creates a fresh card) tries again.
 */
function mountTikTokMedia(
  card: HTMLElement,
  reason: 'mount' | 'tab-resume' | 'focus-resume' | 'focus-unmute' = 'mount',
): void {
  const streamId = card.dataset.streamId ?? '';
  const username = card.dataset.channel ?? '';
  if (!streamId || !username) return;
  if (card.dataset.tabFrozen === '1') return;

  const state = card.dataset.tiktokMountState;
  const alreadyAttempted = state === 'mounted' || state === 'pending' || state === 'error';

  if (!TIKTOK_LIVE_ENABLED) {
    if (!alreadyAttempted) {
      card.dataset.tiktokMountState = 'error';
      showTikTokMessage(card, 'TikTok LIVE is unavailable right now.', username);
    }
    return;
  }

  if (!alreadyAttempted) {
    card.dataset.tiktokMountState = 'pending';
    showTikTokMessage(card, 'Loading TikTok LIVE…');

    const controller = new AbortController();
    tiktokResolveControllers.set(streamId, controller);

    void resolveTikTokLive(username, controller.signal)
      .then((result) => {
        tiktokResolveControllers.delete(streamId);
        if (!card.isConnected) return;
        if (card.dataset.tiktokMountState !== 'pending') return; // superseded (removed/reloaded)
        handleTikTokResolveResult(card, result);
      })
      .catch((err: unknown) => {
        tiktokResolveControllers.delete(streamId);
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!card.isConnected) return;
        if (card.dataset.tiktokMountState !== 'pending') return;
        card.dataset.tiktokMountState = 'error';
        showTikTokMessage(card, 'TikTok LIVE is unavailable right now.', username);
        logEmbedEvent('tiktok-resolve-error', { platform: 'tiktok', channel: username, card });
      });
    return;
  }

  if (reason === 'tab-resume' || reason === 'focus-resume') {
    // Deliberate no-op — same policy as YouTube's mountYouTubeMedia: resuming
    // every backgrounded card at once would itself be a simultaneous-autoplay
    // violation, so paused stays paused until a real click. Also means a
    // failed/pending card is never retried just because the tab regained
    // visibility — no resolver requests fire here at all.
    return;
  }

  if (reason === 'focus-unmute') {
    const entry = tiktokPlayers.get(streamId);
    if (entry) {
      entry.video.muted = false;
      card.dataset.embedMuted = '0';
      safeCall(() => void entry.video.play());
      syncTikTokMuteUi(card);
    }
  }
}

function handleTikTokResolveResult(card: HTMLElement, result: TikTokResolveResult): void {
  const streamId = card.dataset.streamId ?? '';

  if (!result.live || result.qualities.length === 0) {
    card.dataset.tiktokMountState = 'error';
    showTikTokMessage(card, describeTikTokState(result.state), result.username);
    logEmbedEvent('tiktok-not-live', {
      platform: 'tiktok',
      channel: `${card.dataset.channel ?? ''} (${result.state})`,
      card,
    });
    return;
  }

  const wrap = tiktokWrap(card);
  if (!wrap) return;

  const quality =
    result.qualities.find((q: TikTokQuality) => q.id === 'hd') ?? result.qualities[0];
  if (!mpegts.isSupported()) {
    card.dataset.tiktokMountState = 'error';
    showTikTokMessage(card, "This browser can't play TikTok LIVE's video format.", result.username);
    return;
  }

  wrap.replaceChildren();
  const video = document.createElement('video');
  video.className = 'stream-card__tiktok-video';
  video.muted = card.dataset.embedMuted !== '0';
  video.autoplay = true;
  video.playsInline = true;
  wrap.append(video);

  const player = mpegts.createPlayer(
    { type: 'flv', isLive: true, url: quality.url, cors: true },
    // enableWorker: mpegts.js's worker-mode blob script fails ("is not a
    // constructor") when bundled through Vite — main-thread demuxing is the
    // only mode that actually works here, and is fine for a single stream.
    { enableWorker: false },
  );
  player.on(mpegts.Events.ERROR, (type: unknown, detail: unknown) => {
    logEmbedEvent('tiktok-player-error', {
      platform: 'tiktok',
      channel: `${card.dataset.channel ?? ''} (${String(type)}:${String(detail)})`,
      card,
    });
    // A playback-time error (e.g. the CDN URL going stale after the
    // broadcast ends) is reported, not retried — matches "no retry loops".
    // A manual reload (reloadTikTokPlayer) re-resolves if the user wants
    // to try again.
    card.dataset.tiktokMountState = 'error';
    forgetTikTokPlayer(streamId);
    showTikTokMessage(card, 'TikTok LIVE playback stopped.', card.dataset.channel);
  });
  player.attachMediaElement(video);
  player.load();
  safeCall(() => void player.play());

  tiktokPlayers.set(streamId, { player, video });
  card.dataset.tiktokMountState = 'mounted';
  logEmbedEvent('tiktok-mounted', { platform: 'tiktok', channel: card.dataset.channel, card });
}

/** Manual per-card reload — forces a fresh resolve, discarding any cached error/mounted state. */
function reloadTikTokPlayer(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';
  if (!streamId) return;
  forgetTikTokPlayer(streamId);
  delete card.dataset.tiktokMountState;
  reportEmbedRecovery('forced-remount', { platform: 'tiktok', reason: 'manual' });
  mountTikTokMedia(card, 'mount');
}

function createTikTokMuteButton(streamId: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'stream-card__mute-btn';
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('mousedown', (event) => event.stopPropagation());
  button.addEventListener('touchstart', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const card = cardForStream(streamId);
    if (card) toggleTikTokMute(card);
  });
  return button;
}

function toggleTikTokMute(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';
  const nextMuted = !preferredMuted(card);
  const entry = tiktokPlayers.get(streamId);
  if (entry) {
    entry.video.muted = nextMuted;
    if (!nextMuted) safeCall(() => void entry.video.play());
  }
  card.dataset.embedMuted = nextMuted ? '1' : '0';
  syncTikTokMuteUi(card);
}

/** Keeps every rendered copy of the TikTok mute button (header, headers-hidden hover toolbar) in sync. */
function syncTikTokMuteUi(card: HTMLElement): void {
  const muted = preferredMuted(card);
  const label = muted ? 'Unmute stream' : 'Mute stream';
  for (const button of card.querySelectorAll<HTMLButtonElement>('.stream-card__mute-btn')) {
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
    button.title = label;
    button.setAttribute('aria-label', label);
  }
}

function mountStreamMedia(
  card: HTMLElement,
  muted: boolean,
  reason: 'mount' | 'tab-resume' | 'focus-resume' | 'focus-unmute' = 'mount',
): void {
  if (card.dataset.platform === 'youtube') {
    mountYouTubeMedia(card, reason);
    return;
  }
  if (card.dataset.platform === 'tiktok') {
    mountTikTokMedia(card, reason);
    return;
  }
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
    syncTwitchMuteUi(card);
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

    if (card.dataset.platform === 'youtube') {
      // YouTube has a real pause API — no Kick-style blank-src hack needed,
      // and pausing (not unmounting) is what keeps the iframe mounted per
      // the "recreate only on identity change" rule.
      const player = youtubePlayers.get(card.dataset.streamId ?? '');
      if (player) {
        logEmbedEvent('focus-freeze', { platform: 'youtube', channel: card.dataset.channel, card });
        player.pauseVideo();
        continue;
      }
      // Ad-blocked fallback mode has no pause API — reload muted/non-autoplay
      // instead of blanking, so the embed URL (and its videoId) survives for
      // a later focus-unmute to read back and resume from.
      if (card.dataset.youtubeMode === 'fallback') {
        const fallbackIframe = card.querySelector<HTMLIFrameElement>('.stream-card__youtube-wrap iframe');
        const match = fallbackIframe?.src.match(/\/embed\/([^?]+)/);
        if (fallbackIframe && match) {
          logEmbedEvent('focus-freeze', { platform: 'youtube', channel: card.dataset.channel, card });
          fallbackIframe.src = buildEmbedUrl(
            { platform: 'youtube', channel: `video:${match[1]}` },
            true,
            { autoplay: false },
          );
        }
      }
      continue;
    }

    if (card.dataset.platform === 'tiktok') {
      const entry = tiktokPlayers.get(card.dataset.streamId ?? '');
      if (entry) {
        logEmbedEvent('focus-freeze', { platform: 'tiktok', channel: card.dataset.channel, card });
        entry.video.pause();
      }
      continue;
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

function scheduleGridLayout(container: HTMLElement, onSettled?: () => void): void {
  layoutRetries = 0;
  if (layoutFrame) {
    cancelAnimationFrame(layoutFrame);
  }
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      updateGridLayout(container);
      // One more frame so the browser has applied the new box before anyone
      // acts on it — same reasoning as the extra frame beginAddRemoveRecovery
      // waits for after measureAndLayout.
      if (onSettled) {
        requestAnimationFrame(onSettled);
      }
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
  const isEntry = prevFocusedId === null && streamId !== null;
  const isExit = prevFocusedId !== null && streamId === null;

  // Must read "confirmed playing" here, before syncFocusPlayers below pauses
  // every other api-mode Twitch player for the focus session — that pause is
  // exactly what would make a later snapshot read empty.
  if (isEntry) {
    focusEntrySnapshot = {
      ids: snapshotPlayingTwitchPlayers(container).filter((id) => id !== streamId),
      startedAt: Date.now(),
    };
  }

  focusedStreamId = streamId;
  syncFocusDom(container);
  syncFocusPlayers(container, prevFocusedId);
  syncYouTubeFocusMutePollTimer();

  const focusChanged =
    (prevFocusedId === null) !== (focusedStreamId === null) ||
    (focusedStreamId !== null && prevFocusedId !== focusedStreamId);

  if (focusChanged) {
    notifyFocusChange(prevFocusedId);
  }

  // A genuine exit is the only transition that owes the snapshot a recovery
  // pass. Every other path through here — including the entry that just set
  // it above — leaves it alone or drops it, never acts on it.
  if (isExit && focusEntrySnapshot && focusEntrySnapshot.ids.length > 0) {
    const snapshot = focusEntrySnapshot;
    focusEntrySnapshot = null;
    logPlayerEvent('focus-exit-snapshot', { streamIds: snapshot.ids });
    scheduleGridLayout(container, () =>
      beginFocusExitRecovery(container, snapshot.ids, snapshot.startedAt),
    );
  } else {
    if (!isEntry) {
      // A new focus transaction (exit-with-nothing-to-restore, or a direct
      // switch to another stream) invalidates whatever the previous session
      // was still waiting to conclude.
      focusEntrySnapshot = null;
    }
    scheduleGridLayout(container);
  }
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
    syncTwitchMuteUi(focusedCard);
  }
  if (focusedCard?.dataset.platform === 'youtube') {
    mountYouTubeMedia(focusedCard, 'focus-unmute');
    // The trigger stops opening the panel while focused (see
    // createYouTubeVolumeControl) — close one left open from grid view so
    // the header doesn't get stuck in is-volume-mode.
    for (const close of youtubeVolumePanelClosers.get(streamId) ?? []) close();
  }
  if (focusedCard?.dataset.platform === 'tiktok') {
    mountTikTokMedia(focusedCard, 'focus-unmute');
  }
}

export function getFocusedStreamId(): string | null {
  return focusedStreamId;
}

function syncFocusViewDom(container: HTMLElement): void {
  const inFocusView = container.dataset.viewMode === 'focus';
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    const isPrimary = card.dataset.streamId === focusViewPrimaryId;
    card.classList.toggle('is-focus-primary', isPrimary);
    const header = card.querySelector<HTMLElement>('.stream-card__header');
    if (!header) continue;
    const promotable = inFocusView && !isPrimary;
    header.title = promotable ? 'Click to make primary' : '';
    if (promotable) {
      header.tabIndex = 0;
      header.setAttribute('role', 'button');
      header.setAttribute('aria-label', `Make ${card.dataset.channel ?? 'stream'} the primary stream`);
    } else {
      header.removeAttribute('tabindex');
      header.removeAttribute('role');
      header.removeAttribute('aria-label');
    }
  }
}

/**
 * Called whenever the view-mode store changes and whenever the stream list
 * changes (see syncStreamGrid) — picks/revalidates the primary so it's never
 * left pointing at a removed stream, and always writes data-view-mode so
 * updateGridLayout and the CSS know which layout to use.
 */
export function syncViewMode(container: HTMLElement, mode: ViewMode, streams: StreamRef[]): void {
  container.dataset.viewMode = mode;
  if (mode === 'focus' && (!focusViewPrimaryId || !streams.some((s) => s.id === focusViewPrimaryId))) {
    focusViewPrimaryId = streams[0]?.id ?? null;
  }
  syncFocusViewDom(container);
}

/** Promote a tray stream to primary — resize only, no remount (same CSS-var mechanism as any other layout change). */
export function setFocusViewPrimary(container: HTMLElement, streamId: string): void {
  if (focusViewPrimaryId === streamId) return;
  focusViewPrimaryId = streamId;
  syncFocusViewDom(container);
  scheduleGridLayout(container);
}

export function getFocusViewPrimaryId(): string | null {
  return focusViewPrimaryId;
}

/**
 * Click-to-promote: clicking a non-primary card's player area while in Focus
 * View swaps it to primary. Delegated (bound once) rather than per-card so it
 * keeps working across add/remove without rebinding. Buttons/links/inputs are
 * excluded so it never fights the header/overlay controls or SortableJS drag.
 */
export function bindFocusViewPromotion(container: HTMLElement): void {
  container.addEventListener('click', (event) => {
    if (container.dataset.viewMode !== 'focus') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, a, input, select, textarea')) return;
    const card = target.closest<HTMLElement>('.stream-card');
    if (!card || card.classList.contains('is-focus-primary')) return;
    const streamId = card.dataset.streamId;
    if (!streamId) return;
    setFocusViewPrimary(container, streamId);
  });
  // Keyboard equivalent of the click-to-promote header above: the header
  // carries role="button"/tabindex when promotable (see syncFocusViewDom),
  // so Enter/Space needs to trigger the same promotion a click would.
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (container.dataset.viewMode !== 'focus') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const header = target.closest<HTMLElement>('.stream-card__header');
    if (!header) return;
    const card = header.closest<HTMLElement>('.stream-card');
    if (!card || card.classList.contains('is-focus-primary')) return;
    const streamId = card.dataset.streamId;
    if (!streamId) return;
    event.preventDefault();
    setFocusViewPrimary(container, streamId);
  });
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

/**
 * Dot + channel name + platform badge — the "who's broadcasting" identity
 * strip. Originally only the headers-hidden hover toolbar's look; now also
 * used in the header itself so both places read identically. Each card gets
 * two independent instances (header + toolbar), which is why every consumer
 * that needs to update one afterward (YouTube title resolution, Twitch status)
 * uses querySelectorAll and updates every match rather than assuming one.
 *
 * For Twitch the dot starts neutral (no status yet) and only becomes a real
 * live/offline/not-found/unavailable indicator once applyTwitchStatus runs —
 * see twitchStatusDotProps. Kick has no status system in this app, so its
 * dot keeps the original decorative always-pulsing look; YouTube's dot is
 * the same decorative always-pulsing look too — only its meta span is
 * populated, by applyYouTubeStats.
 *
 * `includeMeta` adds a trailing "· 12.4K viewers · 2h 14m" meta span,
 * populated only for the header instance — hidden below a width threshold
 * via the `@container stream-card` rule on `.stream-card__name-badge-meta`
 * in main.css. Category is deliberately left out (see twitchStatusText's
 * doc comment) — this is viewer count + duration only, same shape for
 * Twitch and YouTube. `.stream-card__header` itself never wraps (also
 * main.css): the identity strip shrinking, and this meta span truncating or
 * disappearing first, is what keeps the header controls pinned on one line.
 * The toolbar instance stays identity-only by design and never gets one.
 */
function createNameBadge(
  stream: StreamRef,
  adapter: ReturnType<typeof getAdapter>,
  includeMeta = false,
): { root: HTMLDivElement; dot: HTMLSpanElement; channel: HTMLSpanElement; meta?: HTMLSpanElement } {
  const root = document.createElement('div');
  root.className = 'stream-card__name-badge';

  const dot = document.createElement('span');
  dot.className = 'stream-card__name-badge-dot';
  dot.setAttribute('aria-hidden', 'true');
  if (stream.platform !== 'twitch') {
    dot.classList.add('stream-card__name-badge-dot--pulse');
  }

  const channel = document.createElement('span');
  channel.className = 'stream-card__name-badge-channel';
  channel.textContent = adapter.displayName(stream);

  const platform = document.createElement('span');
  platform.className = `stream-card__name-badge-platform stream-card__name-badge-platform--${stream.platform}`;
  platform.textContent = adapter.label;

  root.append(dot, channel, platform);

  // Non-intrusive experimental marker — see docs/TIKTOK.md. Deliberately
  // small and easy to ignore; never blocks or overlays the video itself.
  if (stream.platform === 'tiktok') {
    const experimental = document.createElement('span');
    experimental.className = 'stream-card__name-badge-experimental';
    experimental.textContent = 'Experimental';
    experimental.title = 'Experimental TikTok LIVE support — not an official TikTok integration.';
    root.append(experimental);
  }

  let meta: HTMLSpanElement | undefined;
  if (includeMeta) {
    meta = document.createElement('span');
    meta.className = 'stream-card__name-badge-meta';
    meta.hidden = true;
    root.append(meta);
  }

  return { root, dot, channel, meta };
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
  card.dataset.orientation = stream.orientation;
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

  // Twitch-only: category + "Live for…" duration, appended inline after the
  // platform badge once a live status check resolves — see
  // applyTwitchStatus/renderTwitchCardStatus. Hidden (no text) for every
  // other state; the dot itself plus its title/aria-label carry the full
  // status for offline/not_found/unavailable.
  const headerNameBadge = createNameBadge(
    stream,
    adapter,
    stream.platform === 'twitch' || stream.platform === 'youtube',
  );

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
  // Same icon and markup as the toolbar's overlayRemove below — one
  // mathematically symmetric SVG, no text glyph, no per-location offset.
  removeButton.innerHTML = ICON_CLOSE;
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

  let headerVolumePanel: HTMLDivElement | undefined;
  if (stream.platform === 'youtube') {
    youtubeVolumePanelClosers.set(stream.id, []);
    const { trigger, panel, closePanel } = createYouTubeVolumeControl(stream.id, header);
    controls.append(trigger);
    headerVolumePanel = panel;
    youtubeVolumePanelClosers.get(stream.id)!.push(closePanel);
  } else if (stream.platform === 'twitch') {
    controls.append(createTwitchMuteButton(stream.id));
  } else if (stream.platform === 'tiktok') {
    controls.append(createTikTokMuteButton(stream.id));
  }
  controls.append(focusButton, reloadButton, removeButton);
  header.append(headerNameBadge.root, controls);
  if (headerVolumePanel) header.append(headerVolumePanel);

  const player = document.createElement('div');
  player.className = 'stream-card__player';

  if (stream.platform === 'kick') {
    const iframe = createKickIframe(stream, adapter);
    const kickFrame = document.createElement('div');
    kickFrame.className = 'stream-card__kick-frame';
    kickFrame.append(iframe);
    player.append(kickFrame);
  } else if (stream.platform === 'youtube') {
    player.append(createYouTubePlayerWrap());
  } else if (stream.platform === 'tiktok') {
    player.append(createTikTokPlayerWrap());
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
  const toolbarNameBadge = createNameBadge(stream, adapter);

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

  let toolbarVolumePanel: HTMLDivElement | undefined;
  if (stream.platform === 'youtube') {
    const { trigger, panel, closePanel } = createYouTubeVolumeControl(stream.id, toolbar);
    overlayControls.append(trigger);
    toolbarVolumePanel = panel;
    youtubeVolumePanelClosers.get(stream.id)!.push(closePanel);
  } else if (stream.platform === 'twitch') {
    overlayControls.append(createTwitchMuteButton(stream.id));
  } else if (stream.platform === 'tiktok') {
    overlayControls.append(createTikTokMuteButton(stream.id));
  }
  overlayControls.append(overlayDrag, overlayFocus, overlayReload, overlayRemove);

  toolbar.append(toolbarNameBadge.root, overlayControls);
  if (toolbarVolumePanel) toolbar.append(toolbarVolumePanel);

  card.append(header, player, toolbar);

  if (stream.platform === 'tiktok') {
    syncTikTokMuteUi(card);
  }

  if (stream.platform === 'twitch') {
    syncTwitchMuteUi(card);

    /*
     * Headers-hidden reveals this toolbar on hover by shrinking the player
     * box (main.css) — a real iframe resize we otherwise never observe, on
     * both open and close. A single check at transitionend used to be the
     * only recovery for it, and that single 500ms window can race Twitch's
     * own asynchronous pause reaction to a resize (same lag documented in
     * lib/playbackRecovery.ts for add/remove) and miss it entirely. This
     * runs the identical bounded, multi-pass schedule used there instead,
     * gated the same way: only a card Twitch had itself confirmed playing
     * right before the transition started is ever eligible to be nudged.
     */
    let toolbarTransitionWasPlaying = false;
    toolbar.addEventListener('transitionstart', (event) => {
      if (event.propertyName !== 'height') return;
      toolbarTransitionWasPlaying = twitchPlayback.get(stream.id) === 'playing';
      logPlayerEvent('toolbar-transition-start', {
        streamId: stream.id,
        mountId: card.querySelector<HTMLElement>('.stream-card__iframe')?.id,
        wasPlaying: toolbarTransitionWasPlaying,
      });
    });
    toolbar.addEventListener('transitionend', (event) => {
      if (event.propertyName !== 'height') return;
      logPlayerEvent('toolbar-transition-end', {
        streamId: stream.id,
        mountId: card.querySelector<HTMLElement>('.stream-card__iframe')?.id,
      });
      if (!toolbarTransitionWasPlaying) return;
      playbackRecovery.hover(createTwitchRecoveryTarget(stream.id, Date.now()), 'toolbar-hover');
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

    if (card.dataset.platform === 'youtube') {
      const player = youtubePlayers.get(card.dataset.streamId ?? '');
      if (player) {
        logEmbedEvent('tab-freeze', { platform: 'youtube', channel: card.dataset.channel, card });
        player.pauseVideo();
        continue;
      }
      if (card.dataset.youtubeMode === 'fallback') {
        const fallbackIframe = card.querySelector<HTMLIFrameElement>('.stream-card__youtube-wrap iframe');
        const match = fallbackIframe?.src.match(/\/embed\/([^?]+)/);
        if (fallbackIframe && match) {
          logEmbedEvent('tab-freeze', { platform: 'youtube', channel: card.dataset.channel, card });
          fallbackIframe.src = buildEmbedUrl(
            { platform: 'youtube', channel: `video:${match[1]}` },
            true,
            { autoplay: false },
          );
        }
      }
      continue;
    }

    if (card.dataset.platform === 'tiktok') {
      // Real <video> element, not an iframe — pausing it (not the generic
      // blank-src hack below) is what keeps the mpegts player and its
      // MediaSource attached, so resuming later never needs a re-resolve.
      const entry = tiktokPlayers.get(card.dataset.streamId ?? '');
      if (entry) {
        logEmbedEvent('tab-freeze', { platform: 'tiktok', channel: card.dataset.channel, card });
        entry.video.pause();
      }
      continue;
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
  if (card.dataset.platform === 'youtube') {
    reloadYouTubePlayer(card);
    return;
  }
  if (card.dataset.platform === 'tiktok') {
    reloadTikTokPlayer(card);
    return;
  }
  if (card.dataset.platform !== 'twitch') return;

  // Advisory status re-check alongside (not instead of) the player reload
  // below — never touches twitchMode/twitchPlayers, purely updates the pill.
  const container = card.parentElement;
  if (container) refreshTwitchStatus(container, [card.dataset.channel ?? '']);

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
 * Pure status -> dot modifier/label mapping, kept separate from any DOM code
 * so it's unit-testable on its own. `null` means "no real status to show" —
 * currently only invalid_input, which the frontend already prevents from
 * ever being submitted, so it should never actually surface; the dot stays
 * in its neutral pending look in that case.
 */
const DOT_STATUS_MODIFIERS = ['live', 'offline', 'not_found', 'unavailable'] as const;
type TwitchDotModifier = (typeof DOT_STATUS_MODIFIERS)[number];

const DOT_STATUS_LABELS: Record<TwitchDotModifier, string> = {
  live: 'Live',
  offline: 'Offline',
  not_found: 'Not found',
  unavailable: 'Unavailable',
};

export function twitchStatusDotProps(
  result: TwitchStatusResult,
): { modifier: TwitchDotModifier; label: string } | null {
  if (result.status === 'invalid_input') return null;
  const modifier = result.status;
  return { modifier, label: DOT_STATUS_LABELS[modifier] };
}

/**
 * Builds the "Live · Category · 12.4K viewers · 2h 14m" tooltip text (the
 * dot's title/aria-label — always the full detail, category included, since
 * it costs no layout space there) and the shorter "12.4K viewers · 2h 14m"
 * inline meta span text. Category is deliberately left out of the visible
 * meta line — it rarely changes and isn't worth the header space — but stays
 * one hover away via the tooltip. Category/viewer count/duration only ever
 * apply to a live result.
 */
function twitchStatusText(
  props: ReturnType<typeof twitchStatusDotProps>,
  category: string | undefined,
  viewers: string | null,
  duration: string | null,
): { tooltip: string; meta: string } {
  if (!props) return { tooltip: '', meta: '' };
  if (props.modifier !== 'live') return { tooltip: props.label, meta: '' };
  const tooltipParts = [category, viewers, duration].filter((part): part is string => Boolean(part));
  const tooltip = tooltipParts.length ? `${props.label} · ${tooltipParts.join(' · ')}` : props.label;
  const meta = [viewers, duration].filter((part): part is string => Boolean(part)).join(' · ');
  return { tooltip, meta };
}

/**
 * Renders one card's already-known status (from its `data-twitch-*` dataset,
 * set by applyTwitchStatus) at the given point in time. Split out from
 * applyTwitchStatus so the shared minute timer can re-render just the
 * duration text without re-fetching or re-applying a status result.
 */
function isTwitchDotModifier(value: string | undefined): value is TwitchDotModifier {
  return !!value && (DOT_STATUS_MODIFIERS as readonly string[]).includes(value);
}

function renderTwitchCardStatus(card: HTMLElement, nowMs: number): void {
  const statusValue = card.dataset.twitchStatus;
  const props = isTwitchDotModifier(statusValue)
    ? { modifier: statusValue, label: DOT_STATUS_LABELS[statusValue] }
    : null;

  const category = card.dataset.twitchCategory;
  const viewers = formatTwitchViewerCount(
    card.dataset.twitchViewerCount === undefined ? undefined : Number(card.dataset.twitchViewerCount),
  );
  const duration = formatTwitchLiveDuration(card.dataset.twitchStartedAt, nowMs);
  const { tooltip, meta } = twitchStatusText(props, category, viewers, duration);

  for (const dot of card.querySelectorAll<HTMLElement>('.stream-card__name-badge-dot')) {
    for (const modifier of DOT_STATUS_MODIFIERS) {
      dot.classList.remove(`stream-card__name-badge-dot--${modifier}`);
    }
    dot.classList.remove('stream-card__name-badge-dot--pulse');

    if (props) {
      dot.classList.add(`stream-card__name-badge-dot--${props.modifier}`);
      if (props.modifier === 'live') dot.classList.add('stream-card__name-badge-dot--pulse');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-hidden', 'false');
      dot.setAttribute('aria-label', tooltip);
      dot.title = tooltip;
    } else {
      dot.removeAttribute('role');
      dot.removeAttribute('aria-label');
      dot.removeAttribute('title');
      dot.setAttribute('aria-hidden', 'true');
    }
  }

  const metaEl = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
  if (metaEl) {
    metaEl.textContent = meta ? `· ${meta}` : '';
    metaEl.hidden = meta.length === 0;
  }
}

let twitchDurationTimerId = 0;

/**
 * Test-only: clears the shared duration timer's handle between test cases so
 * one test's real-or-fake interval can't starve the next test's
 * syncTwitchDurationTimer call (which no-ops whenever a handle is already
 * set). Not called anywhere in production code.
 */
export function __resetTwitchDurationTimerForTests(): void {
  if (twitchDurationTimerId) {
    window.clearInterval(twitchDurationTimerId);
    twitchDurationTimerId = 0;
  }
}

/** One shared 60s timer for every live Twitch card's duration text — never one per card. */
function syncTwitchDurationTimer(container: HTMLElement): void {
  const hasLiveDuration =
    container.querySelector('.stream-card[data-platform="twitch"][data-twitch-started-at]') !== null;

  if (!hasLiveDuration) {
    if (twitchDurationTimerId) {
      window.clearInterval(twitchDurationTimerId);
      twitchDurationTimerId = 0;
    }
    return;
  }

  if (twitchDurationTimerId) return;
  twitchDurationTimerId = window.setInterval(() => {
    if (!container.isConnected) {
      window.clearInterval(twitchDurationTimerId);
      twitchDurationTimerId = 0;
      return;
    }
    const now = Date.now();
    for (const card of container.querySelectorAll<HTMLElement>(
      '.stream-card[data-platform="twitch"][data-twitch-started-at]',
    )) {
      renderTwitchCardStatus(card, now);
    }
  }, 60_000);
}

/**
 * Applies already-fetched status results to whatever matching Twitch cards
 * currently exist. Only ever touches `.stream-card__name-badge-dot`,
 * `.stream-card__name-badge-meta`, and `data-twitch-*` dataset attributes —
 * never mountStreamMedia, twitchPlayers, or any iframe/player state. A card
 * with no matching result (e.g. that one lookup failed on its own) is left
 * exactly as it was, not cleared — purely additive, purely advisory.
 */
export function applyTwitchStatus(
  container: HTMLElement,
  results: Map<string, TwitchStatusResult>,
): void {
  const nowMs = Date.now();

  for (const card of container.querySelectorAll<HTMLElement>('.stream-card[data-platform="twitch"]')) {
    const channel = card.dataset.channel ?? '';
    const result = results.get(channel);
    if (!result) continue;

    const props = twitchStatusDotProps(result);
    if (props) {
      card.dataset.twitchStatus = props.modifier;
    } else {
      delete card.dataset.twitchStatus;
    }

    if (result.status === 'live' && result.startedAt) {
      card.dataset.twitchStartedAt = result.startedAt;
    } else {
      delete card.dataset.twitchStartedAt;
    }
    if (result.status === 'live' && result.category) {
      card.dataset.twitchCategory = result.category;
    } else {
      delete card.dataset.twitchCategory;
    }
    if (result.status === 'live' && result.viewerCount !== undefined) {
      card.dataset.twitchViewerCount = String(result.viewerCount);
    } else {
      delete card.dataset.twitchViewerCount;
    }

    renderTwitchCardStatus(card, nowMs);
  }

  syncTwitchDurationTimer(container);
}

/**
 * Fire-and-forget: checks status for the given Twitch channels in one
 * batched request, then applies whatever comes back. Safe to call with any
 * number of channels — the add/reload paths call this with one. Never blocks
 * or delays anything else; `checkTwitchStatus` itself never throws except on
 * abort, which this doesn't use, so there's nothing here to catch.
 */
export function refreshTwitchStatus(container: HTMLElement, channels: string[]): void {
  const wanted = channels.filter(Boolean);
  if (wanted.length === 0) return;
  void checkTwitchStatus(wanted).then((results) => {
    if (!container.isConnected) return;
    applyTwitchStatus(container, results);
  });
}

const twitchStatusCoordinator = createTwitchStatusCoordinator({
  checkStatus: checkTwitchStatus,
  onResult: (results, _reason) => {
    const container = document.querySelector<HTMLElement>('#stream-grid');
    if (!container || !container.isConnected) return;
    applyTwitchStatus(container, results);
  },
});

/**
 * The single coordinator-backed entry point for "recheck every Twitch card at
 * once" — used by initial restore, the manual refresh button, the periodic
 * scheduler, and visibility-resume. Collects the current Twitch channels
 * straight from the store (source of truth), not the DOM, dedupes them, and
 * defers to the coordinator's in-flight gate so only one such batched request
 * is ever active app-wide. Does not touch any player/iframe — see
 * applyTwitchStatus's own doc comment for the boundary this respects.
 */
export function refreshAllTwitchStatuses(
  store: StreamStore,
  reason: TwitchStatusRefreshReason,
): Promise<TwitchStatusRefreshResult> {
  const channels = store
    .getStreams()
    .filter((stream) => stream.platform === 'twitch')
    .map((stream) => stream.channel);
  return twitchStatusCoordinator.refresh(channels, reason);
}

export function isTwitchStatusRefreshInFlight(): boolean {
  return twitchStatusCoordinator.isInFlight();
}

/**
 * Renders one YouTube card's already-known stats (from its `data-youtube-*`
 * dataset) into its header meta span — the same span Twitch uses for
 * "12.4K viewers · 2h 14m". Split out from applyYouTubeStats so the shared
 * minute timer can re-render just the duration text without re-fetching
 * anything, mirroring renderTwitchCardStatus.
 */
function renderYouTubeCardMeta(card: HTMLElement, nowMs: number): void {
  const viewers = formatTwitchViewerCount(
    card.dataset.youtubeViewerCount === undefined ? undefined : Number(card.dataset.youtubeViewerCount),
  );
  const duration = formatTwitchLiveDuration(card.dataset.youtubeStartedAt, nowMs);
  const meta = [viewers, duration].filter((part): part is string => Boolean(part)).join(' · ');

  const metaEl = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
  if (metaEl) {
    metaEl.textContent = meta ? `· ${meta}` : '';
    metaEl.hidden = meta.length === 0;
  }
}

let youtubeDurationTimerId = 0;

/** Test-only: mirrors __resetTwitchDurationTimerForTests. Not called anywhere in production code. */
export function __resetYouTubeDurationTimerForTests(): void {
  if (youtubeDurationTimerId) {
    window.clearInterval(youtubeDurationTimerId);
    youtubeDurationTimerId = 0;
  }
}

/** One shared 60s timer for every live YouTube card's duration text — never one per card. Mirrors syncTwitchDurationTimer. */
function syncYouTubeDurationTimer(container: HTMLElement): void {
  const hasLiveDuration =
    container.querySelector('.stream-card[data-platform="youtube"][data-youtube-started-at]') !== null;

  if (!hasLiveDuration) {
    if (youtubeDurationTimerId) {
      window.clearInterval(youtubeDurationTimerId);
      youtubeDurationTimerId = 0;
    }
    return;
  }

  if (youtubeDurationTimerId) return;
  youtubeDurationTimerId = window.setInterval(() => {
    if (!container.isConnected) {
      window.clearInterval(youtubeDurationTimerId);
      youtubeDurationTimerId = 0;
      return;
    }
    const now = Date.now();
    for (const card of container.querySelectorAll<HTMLElement>(
      '.stream-card[data-platform="youtube"][data-youtube-started-at]',
    )) {
      renderYouTubeCardMeta(card, now);
    }
  }, 60_000);
}

/**
 * Applies already-fetched stats to whatever currently-mounted YouTube cards
 * have a matching `data-youtube-video-id` (set by startYouTubePlayer/
 * resolveAndMountYouTubeChannel — see their own comments on why that, not
 * the stream's token, is the source of truth for "which video is this card
 * showing right now"). Only ever touches `.stream-card__name-badge-meta` and
 * `data-youtube-*` dataset attributes — never mountYouTubeMedia,
 * youtubePlayers, or any iframe/player state. Mirrors applyTwitchStatus.
 */
export function applyYouTubeStats(container: HTMLElement, results: Map<string, YouTubeStatsResult>): void {
  const nowMs = Date.now();

  for (const card of container.querySelectorAll<HTMLElement>('.stream-card[data-platform="youtube"]')) {
    const videoId = card.dataset.youtubeVideoId;
    const result = videoId ? results.get(videoId) : undefined;
    if (!result) continue;

    if (result.status === 'live' && result.viewerCount != null) {
      card.dataset.youtubeViewerCount = String(result.viewerCount);
    } else {
      delete card.dataset.youtubeViewerCount;
    }
    if (result.status === 'live' && result.startedAt) {
      card.dataset.youtubeStartedAt = result.startedAt;
    } else {
      delete card.dataset.youtubeStartedAt;
    }

    renderYouTubeCardMeta(card, nowMs);
  }

  syncYouTubeDurationTimer(container);
}

/**
 * Fire-and-forget single-batch stats check, mirroring refreshTwitchStatus —
 * used for a card's first paint right after mount, ahead of the periodic
 * scheduler's next tick.
 */
export function refreshYouTubeStats(container: HTMLElement, videoIds: string[]): void {
  const wanted = videoIds.filter(Boolean);
  if (wanted.length === 0) return;
  void checkYouTubeStats(wanted).then((results) => {
    if (!container.isConnected) return;
    applyYouTubeStats(container, results);
  });
}

const youtubeStatusCoordinator = createYouTubeStatusCoordinator({
  checkStats: checkYouTubeStats,
  onResult: (results, _reason) => {
    const container = document.querySelector<HTMLElement>('#stream-grid');
    if (!container || !container.isConnected) return;
    applyYouTubeStats(container, results);
  },
});

/**
 * The single coordinator-backed entry point for "recheck every mounted
 * YouTube card's stats at once" — used by initial restore and the periodic
 * scheduler. Unlike refreshAllTwitchStatuses, this reads videoIds from the
 * DOM (`container`), not the store: the store only knows each stream's
 * token (a channel handle, or a fixed video id), never the currently-live
 * videoId a channel token resolved to — that only exists once mounted.
 */
export function refreshAllYouTubeStats(
  container: HTMLElement,
  reason: YouTubeStatsRefreshReason,
): Promise<YouTubeStatsRefreshResult> {
  const videoIds: string[] = [];
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card[data-platform="youtube"]')) {
    const videoId = card.dataset.youtubeVideoId;
    if (videoId) videoIds.push(videoId);
  }
  return youtubeStatusCoordinator.refresh(videoIds, reason);
}

export function isYouTubeStatsRefreshInFlight(): boolean {
  return youtubeStatusCoordinator.isInFlight();
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
 *
 * Reads `player.isPaused()` directly (the same primitive the 90s watchdog
 * already trusts — see checkPaused/verifyAndRecoverTwitchPlayer) rather than
 * the `twitchPlayback` PLAYING-event latch. Confirmed live (?debug=all) that
 * PLAYING does not reliably fire for every stream Twitch is actually
 * playing — a channel `isPaused()` reported as running sat at `twitchPlayback
 * === 'unknown'` the whole time. Relying on the latch alone made this
 * snapshot come back empty even when real players were mid-playback, so
 * beginAddRemoveRecovery had nothing to act on and only the periodic
 * watchdog (up to ~90-180s later) ever brought the stream back. `offline`/
 * `blocked` are still excluded via the latch first — isPaused() alone can't
 * tell "genuinely stopped" from "buffering", but it CAN tell those two
 * definite non-playing states apart from everything else, cheaply.
 */
export function snapshotPlayingTwitchPlayers(container: HTMLElement): string[] {
  const ids: string[] = [];
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.dataset.platform !== 'twitch' || card.dataset.twitchMode !== 'api') continue;
    if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') continue;
    const streamId = card.dataset.streamId ?? '';
    if (!streamId) continue;
    const latched = twitchPlayback.get(streamId);
    if (latched === 'offline' || latched === 'blocked') continue;
    const player = twitchPlayers.get(streamId);
    if (!player) continue;
    if (checkPaused(player, streamId) !== false) continue;
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
 * Start the bounded post-focus-exit checks for exactly the api-mode Twitch
 * players that were confirmed playing before the focus session began. Call
 * once the grid has settled back into its pre-focus layout — that resize is
 * what Twitch reacts to, same as add/remove.
 *
 * `startedAt` is the pre-focus snapshot time, not this call's time: a card
 * clicked into (and thereby engaged) at any point during the focus session —
 * not just after exit — must be excluded, and isEligible()'s engagement
 * check compares against whatever startedAt it was given.
 */
export function beginFocusExitRecovery(
  container: HTMLElement,
  snapshotIds: readonly string[],
  startedAt: number,
): void {
  const targets = snapshotIds
    .filter((streamId) => {
      const card = cardForStream(streamId);
      return Boolean(card?.isConnected) && container.contains(card);
    })
    .map((streamId) => createTwitchRecoveryTarget(streamId, startedAt));

  logPlayerEvent('layout-settled', {
    cause: 'focus-exit',
    survivors: targets.map((target) => target.id),
    dropped: snapshotIds.filter((id) => !targets.some((target) => target.id === id)),
  });

  playbackRecovery.focusExit(targets, 'focus-exit');
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
      if (card.dataset.platform === 'youtube') {
        forgetYouTubePlayer(id);
      }
      if (card.dataset.platform === 'tiktok') {
        forgetTikTokPlayer(id);
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

  if (focusViewPrimaryId && !nextIds.has(focusViewPrimaryId)) {
    focusViewPrimaryId = streams[0]?.id ?? null;
  }
  syncFocusViewDom(container);
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

  if (container.dataset.viewMode === 'focus' && !focusedStreamId) {
    updateFocusViewLayout(container, streamArea, totalCount);
    return;
  }

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

  const headersHidden = document.documentElement.classList.contains('headers-hidden');
  // Headers-hidden: video alone (no chrome height). Focused keeps header for ×.
  const chromeHeight =
    !headersHidden || focusedStreamId ? CARD_HEADER_HEIGHT : 0;

  // Solo focus keeps its existing always-16:9 behavior (unrelated to the
  // portrait-aware weighting below, which only applies to the multi-stream
  // grid) — real per-card orientation is only read when nothing is focused.
  const items: WeightedGridItem[] = focusedStreamId
    ? [{ id: focusedStreamId, orientation: 'landscape' }]
    : Array.from(container.querySelectorAll<HTMLElement>('.stream-card')).map((card) => ({
        id: card.dataset.streamId ?? '',
        orientation: card.dataset.orientation === 'portrait' ? 'portrait' : 'landscape',
      }));

  const packed = computeWeightedGridLayout(items, areaWidth, areaHeight, {
    gap: GRID_GAP,
    maxColumns: MAX_GRID_COLUMNS,
    chromeHeightPerRow: chromeHeight,
  });

  if (packed.cellWidth <= 0 || packed.cellHeight <= 0) {
    container.style.setProperty('--grid-columns', '1');
    container.style.removeProperty('--player-height');
    container.style.removeProperty('--player-width');
    container.style.removeProperty('--portrait-row-span');
    container.style.removeProperty('--portrait-content-width');
    container.style.removeProperty('--portrait-content-height');
    return;
  }

  container.style.setProperty('--grid-columns', String(packed.columns));
  container.style.setProperty('--player-width', `${Math.floor(packed.cellWidth)}px`);
  container.style.setProperty('--player-height', `${Math.floor(packed.cellHeight)}px`);
  container.style.setProperty('--portrait-row-span', String(packed.portraitRowSpan));
  if (packed.portraitContentWidth > 0 && packed.portraitContentHeight > 0) {
    container.style.setProperty('--portrait-content-width', `${Math.floor(packed.portraitContentWidth)}px`);
    container.style.setProperty('--portrait-content-height', `${Math.floor(packed.portraitContentHeight)}px`);
  } else {
    container.style.removeProperty('--portrait-content-width');
    container.style.removeProperty('--portrait-content-height');
  }

  if (hasKick) {
    setKickScaleVars(container, packed.cellWidth);
  } else {
    container.style.removeProperty('--kick-col-min');
    container.style.removeProperty('--kick-render-width');
    container.style.removeProperty('--kick-scale');
  }
}

/**
 * Focus View sizing: one primary box (its own orientation respected — a
 * portrait primary is never stretched to 16:9, see computeFocusViewLayout)
 * plus a horizontal tray strip of the rest. Every stream stays mounted and
 * in the same flat DOM parent throughout — only CSS vars change, so
 * promoting a different stream to primary or toggling modes never remounts
 * a player (see setFocusViewPrimary/syncViewMode).
 */
function updateFocusViewLayout(container: HTMLElement, streamArea: Element, totalCount: number): void {
  const areaWidth = streamArea.clientWidth - GRID_PADDING;
  const areaHeight = streamArea.clientHeight - GRID_PADDING;

  if (areaWidth <= 0 || areaHeight <= 0) {
    if (layoutRetries < MAX_LAYOUT_RETRIES) {
      layoutRetries += 1;
      requestAnimationFrame(() => updateGridLayout(container));
    }
    return;
  }
  layoutRetries = 0;

  const primaryCard = focusViewPrimaryId
    ? container.querySelector<HTMLElement>(
        `.stream-card[data-stream-id="${CSS.escape(focusViewPrimaryId)}"]`,
      )
    : null;
  const primaryOrientation: StreamOrientation =
    primaryCard?.dataset.orientation === 'portrait' ? 'portrait' : 'landscape';

  // Same header-chrome reservation the ordinary grid makes (see
  // updateGridLayout) — each row (primary, tray) shows one card header, so
  // computeFocusViewLayout must leave that much room out of the pure player
  // math, and the row track itself (below) must add it back on top.
  const headersHidden = document.documentElement.classList.contains('headers-hidden');
  const chromeHeight = headersHidden ? 0 : CARD_HEADER_HEIGHT;

  const result = computeFocusViewLayout(areaWidth, areaHeight, primaryOrientation, {
    gap: GRID_GAP,
    chromeHeightPerRow: chromeHeight,
  });

  if (result.primaryWidth <= 0 || result.primaryHeight <= 0) {
    clearFocusViewVars(container);
    return;
  }

  const trayCount = Math.max(1, totalCount - 1);
  const visibleTrayCount = Math.max(1, Math.min(trayCount, targetVisibleTrayCount(areaWidth)));

  container.style.setProperty('--grid-columns', '1');
  container.style.setProperty('--focus-primary-width', `${Math.floor(result.primaryWidth)}px`);
  container.style.setProperty('--focus-primary-height', `${Math.floor(result.primaryHeight)}px`);
  container.style.setProperty(
    '--focus-primary-row-height',
    `${Math.floor(result.primaryHeight + chromeHeight)}px`,
  );
  container.style.setProperty('--focus-tray-height', `${Math.floor(result.trayHeight)}px`);
  container.style.setProperty(
    '--focus-tray-row-height',
    `${Math.floor(result.trayHeight + chromeHeight)}px`,
  );
  container.style.setProperty(
    '--focus-tray-column-width',
    `${Math.floor(result.trayColumnWidth)}px`,
  );
  container.style.setProperty('--focus-tray-count', String(visibleTrayCount));

  const hasKick = container.dataset.hasKick === '1';
  if (hasKick) {
    // Kick's width-dependent chrome only gets one shared scale per layout —
    // base it on whichever box a Kick card actually occupies most visibly:
    // the primary if it's Kick, otherwise the (smaller) tray tile size. If
    // both a primary and a tray tile are Kick at once, the tray wins the
    // shared scale — an accepted limitation, same as the ordinary grid
    // already sharing one scale across every card regardless of size.
    const basisWidth =
      primaryCard?.dataset.platform === 'kick' ? result.primaryWidth : result.trayColumnWidth;
    setKickScaleVars(container, basisWidth);
  } else {
    container.style.removeProperty('--kick-col-min');
    container.style.removeProperty('--kick-render-width');
    container.style.removeProperty('--kick-scale');
  }
}
