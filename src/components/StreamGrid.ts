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
import { isPhoneViewport, isStackedStreamLayout } from '../lib/viewport';
import mpegts from 'mpegts.js';
import { getAdapter, buildEmbedUrl } from '../platforms';
import { checkKickStatus, type KickStatusResult } from '../platforms/kickStatus';
import {
  describeTikTokState,
  resolveTikTokLive,
  tiktokAvatarEndpoint,
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

/** Four-corner Full Window glyph — the Grid-mode Focus control. */
const ICON_FULL_WINDOW =
  '<span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 5V1.5H5M9 1.5H12.5V5M12.5 9V12.5H9M5 12.5H1.5V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

/** Film-strip / cinema glyph — Full Window → Theater affordance. */
const ICON_THEATER =
  '<span aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="2.5" y="3.5" width="11" height="9" rx="1.2" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M5 3.5v9M11 3.5v9M2.5 6.5h2.5M2.5 9.5h2.5M11 6.5h2.5M11 9.5h2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '</svg></span>';

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
/** Fired after a stream is removed via any of its remove buttons (header X, overlay X) — never for programmatic store.removeStream calls elsewhere, only user-initiated ones — so main.ts can offer Undo. */
type StreamRemovedHandler = (removed: StreamRef, previousIndex: number) => void;

let focusedStreamId: string | null = null;
let focusSessionActive = false;
let focusChangeHandler: FocusChangeHandler | null = null;
let streamRemovedHandler: StreamRemovedHandler | null = null;
/**
 * Fired when a card's own Focus control is clicked from Grid View — this is
 * Focus View's ONLY entry point (see bindFocusViewEntry's own doc comment):
 * main.ts's handler sets focusViewPrimaryId to this exact stream and flips
 * viewModeStore to 'focus' in one synchronous pair of calls, so the primary
 * is never ambiguous and there's no intermediate frame where it's anyone
 * else. Deliberately independent of focusedStreamId/setFocusedStream (the
 * older solo "expand" mechanism, now unused — see toggleStreamFocus's own
 * doc comment) so entering Focus View can never re-trigger that mechanism's
 * own side effects (chat-lock snapshot/restore in main.ts) mid-transition.
 */
let focusViewEntryHandler: ((streamId: string) => void) | null = null;
/** Fired when the primary's own X is clicked while in Theater/Focus — main.ts wires this to viewModeStore.setMode('grid'). It never removes the stream or touches the lineup, purely a mode change. */
let focusViewExitHandler: (() => void) | null = null;
/** Fired when the primary's repurposed Focus control is clicked while in Theater/Focus — main.ts wires this to toggling between 'theater' and 'focus', keeping the same primary. */
let focusViewToggleHandler: (() => void) | null = null;
/** Fired whenever focusViewPrimaryId changes (entry or promotion) — main.ts uses this to keep Theater/Focus chat locked to whichever stream is currently primary. */
let focusViewPrimaryChangedHandler: (() => void) | null = null;
/**
 * Focus View's primary stream — distinct from focusedStreamId (the solo
 * fullscreen "Focus" feature above). Shared by both Theater (no tray) and
 * Focus (tray visible) — they're the same primary/tray machinery, just with
 * the tray hidden or shown by CSS (see updateGridLayout's viewMode branch).
 * Neither mode hides or freezes other streams; layout just resizes via CSS
 * vars (see updateFocusViewLayout) — same "JS computes px, CSS consumes
 * vars" approach updateGridLayout already uses, so no player is ever
 * remounted by switching modes or promoting a different stream to primary.
 */
let focusViewPrimaryId: string | null = null;

/**
 * True for whichever stream the viewer is watching large right now — either
 * the old solo-focus card (focusedStreamId) or the current Theater/Focus
 * primary (focusViewPrimaryId). Hover/watchdog stall sweeps skip this
 * stream so a tray scroll or interaction-nudge cannot play() the primary.
 *
 * Operation-scoped recovery (createTwitchRecoveryTarget / beginAddRemoveRecovery)
 * does NOT use this guard: Full Window ↔ Theater resizes the primary on
 * purpose, and that primary must be eligible for the bounded play() pass.
 */
function isActivelyWatchedStream(streamId: string): boolean {
  return focusedStreamId === streamId || focusViewPrimaryId === streamId;
}

/**
 * Set whenever syncViewMode transitions INTO Focus View (grid -> focus, or
 * solo-focus -> focus), consumed the next time updateFocusViewLayout runs —
 * gates the one-time tray auto-nudge (see maybeNudgeFocusTray) so it fires
 * once per entry, not on every resize/promote while already in Focus View.
 */
let pendingTrayNudge = false;
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
// `player` is null when a card is playing HLS natively via the plain
// <video> element (Safari/iOS, which has no MSE — see handleTikTokResolveResult)
// instead of through mpegts.js's FLV-over-MSE path.
const tiktokPlayers = new Map<string, { player: ReturnType<typeof mpegts.createPlayer> | null; video: HTMLVideoElement }>();
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
 * Twitch and TikTok both already have a single source of truth for *muted*
 * (card.dataset.embedMuted, read via preferredMuted — every existing
 * mount/focus/watchdog call site already reads and writes it, unlike
 * YouTube's postMessage player which needed its own map to avoid a
 * read-after-write race). These two maps add only what's missing: the last
 * nonzero volume (0-100), so dragging to 0 and back restores where the user
 * left it instead of snapping to 100 — the same "remember where to bounce
 * back to" contract youtubeVolumeState's `volume` field gives YouTube.
 * 'api'-mode Twitch and mounted TikTok both support real setVolume(); Twitch
 * 'fallback' mode never populates its entry and keeps the plain mute-only
 * button (see createTwitchVolumeControl's canAdjustVolume).
 */
const twitchVolume = new Map<string, number>();
const tiktokVolume = new Map<string, number>();
const twitchVolumePanelClosers = new Map<string, Array<() => void>>();
const tiktokVolumePanelClosers = new Map<string, Array<() => void>>();
const twitchVolumeSyncers = new Map<string, Array<() => void>>();
const tiktokVolumeSyncers = new Map<string, Array<() => void>>();

/**
 * Twitch/YouTube/Kick are mute/unmute only — a fine-grained slider isn't
 * worth the extra state surface for embeds nobody asked to fine-tune, and
 * (for YouTube) the slider's optimistic local state could desync from the
 * postMessage-acked player state, leaving a click that looked like it
 * unmuted the stream doing nothing audible until a hard reload. TikTok keeps
 * a real slider (createTikTokVolumeControl) since it's a plain <video>
 * element with synchronous, race-free volume/mute properties. Every unmute
 * across all providers lands here — full blast on unmute was jarring with
 * several tiles playing at once. Header unmute lands at 25% (Twitch
 * setVolume(0.25), YouTube setVolume(25), TikTok video.volume = 0.25).
 * TikTok still restores a user-chosen slider level when one was stored.
 */
const DEFAULT_UNMUTE_VOLUME = 25;

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
  // Deliberately NOT touching twitchVolume/twitchVolumePanelClosers/
  // twitchVolumeSyncers here — this runs on every reconstruct (manual
  // reload, watchdog rebuild), not just true removal, and the volume
  // popover's DOM elements survive a rebuild untouched. Wiping the map
  // entries here would silently break syncTwitchMuteUi's slider updates
  // after the very next rebuild. Only syncStreamGrid's true-removal branch
  // clears them (a card that's actually gone needs no further syncing).
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
      /*
       * Twitch's embed remembers the last unmuted volume in its own storage
       * and can ignore our constructor `muted: true` on a full page load.
       * Until the user actually clicks this iframe (userEngagedAt), push
       * our mute preference into the player rather than adopting a stored
       * unmute — recovery/play() must never leak audio onto the next reload.
       */
      if (preferredMuted(card) && liveMuted === false && !card.dataset.userEngagedAt) {
        enforcePreferredMute(player, card);
        continue;
      }
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
 * Bounded play() recovery after an app-controlled layout mutation (add,
 * remove, reorder, chat, headers, view-mode). Not wired to ResizeObserver or
 * mousemove — those already have their own handling, and attaching a
 * play()-capable mechanism to high-frequency events is how the grid-wide
 * overlay flashing got introduced the first time.
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
  container.style.removeProperty('--grid-row-height');
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
  container.style.removeProperty('--focus-primary-offset-left');
  container.style.removeProperty('--focus-tray-height');
  container.style.removeProperty('--focus-tray-row-height');
  container.style.removeProperty('--focus-tray-column-width');
  container.style.removeProperty('--focus-tray-count');
  container.removeAttribute('data-tray-overflow');
}

/*
 * cellWidth is the grid TRACK; playerWidth is what .stream-card__player
 * actually gets after the card's own border. The scale must come from
 * playerWidth: scaling to the track instead rendered the Kick frame ~2px
 * wider and ~1px taller than its host, and the card's overflow: hidden then
 * clipped that overhang off the bottom — which is the edge of Kick's native
 * control bar. Defaults to cellWidth for callers with no card to measure
 * (phone stack), where the two are the same to within the border.
 */
function setKickScaleVars(
  container: HTMLElement,
  cellWidth: number,
  playerWidth: number = cellWidth,
): void {
  const renderWidth = Math.max(MIN_KICK_VIEWPORT_WIDTH, Math.floor(playerWidth));
  const scale = playerWidth / renderWidth;
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
 * Re-assert mute on a player that should be silent. Twitch's play() and its
 * embed-storage restore can unmute behind our back; recovery and page-load
 * must restore playback without restoring audio. Never calls setMuted(false).
 */
function enforcePreferredMute(player: Twitch.Player, card: HTMLElement): void {
  if (!preferredMuted(card)) return;
  try {
    player.setMuted(true);
  } catch {
    // Player not ready to accept mute — READY/poll will retry.
  }
}

/** Resume a paused Twitch player without changing audio state. */
function replayTwitchPlayback(player: Twitch.Player, card: HTMLElement): void {
  player.play();
  enforcePreferredMute(player, card);
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
    replayTwitchPlayback(player, card);
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
    replayTwitchPlayback(player, card);
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
    // Constructor `muted` is not authoritative — Twitch restores last volume
    // from embed storage. Full page load / shared URL must start silent.
    enforcePreferredMute(player, card);
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
          // isMuted()/getVolume() can throw if the postMessage channel isn't
          // fully hydrated the instant onReady fires — leaving the entry
          // unset used to disable the mute button forever (syncYouTubeVolumeUi
          // treats a missing entry as "not available", and nothing ever
          // retries it short of a full reload). Seed a safe default instead
          // so a real click still works; mute()/unMute() don't depend on this
          // read having succeeded.
          youtubeVolumeState.set(streamId, { muted: true, volume: DEFAULT_UNMUTE_VOLUME });
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
 * attached yet) into every external mute button rendered for this card —
 * there are up to two: the header's and the headers-hidden hover toolbar's,
 * only one of which is ever visible at a time, but both must stay correct
 * since either can become visible without a remount (Show headers toggle).
 *
 * Reads from youtubeVolumeState, never the live player — see that map's own
 * comment for why a synchronous re-read right after our own mute()/unMute()
 * call would race the postMessage round trip. Never touches playback either
 * way.
 */
function syncYouTubeVolumeUi(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';
  const state = youtubeVolumeState.get(streamId);
  const available = state !== undefined && youtubePlayers.has(streamId);
  const muted = state?.muted ?? true;

  for (const button of card.querySelectorAll<HTMLButtonElement>('.stream-card__mute-btn')) {
    button.disabled = !available;
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
    const label = muted ? 'Unmute YouTube video' : 'Mute YouTube video';
    button.title = muted ? 'Unmute' : 'Mute';
    button.setAttribute('aria-label', label);
  }
}

/**
 * Flips mute only. Shared by the header and headers-hidden hover-toolbar
 * buttons (see createYouTubeVolumeControl) so the two copies can never drift
 * from each other. Every unmute resets volume to DEFAULT_UNMUTE_VOLUME (see
 * that constant's own doc comment) — YouTube has no slider anymore, so
 * there's no user-chosen level to preserve instead.
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
    player.setVolume(DEFAULT_UNMUTE_VOLUME);
  }
  youtubeVolumeState.set(streamId, { muted: nextMuted, volume: nextMuted ? state.volume : DEFAULT_UNMUTE_VOLUME });
  const card = cardForStream(streamId);
  if (card) syncYouTubeVolumeUi(card);
}

/**
 * Plain YouTube mute toggle: button only, no slider/panel — see
 * DEFAULT_UNMUTE_VOLUME's own doc comment for why. Only mute()/unMute()/
 * setVolume() are ever called here — deliberately never playVideo/
 * pauseVideo/cueVideoById/loadVideoById/destroy, and never the iframe's src —
 * so toggling mute can never pause, restart, or reconstruct the player.
 *
 * Disabled until a live player is actually attached for this stream — see
 * syncYouTubeVolumeUi, called on the player's onReady and after every
 * mute/unmute so both rendered copies (header, hover toolbar) never drift
 * out of sync with each other or the player.
 */
/**
 * Reusable trigger+slider volume control, used by Twitch (slider
 * permanently disabled — see DEFAULT_UNMUTE_VOLUME's doc comment) and
 * TikTok (real slider, the one provider that kept fine volume control). The
 * trigger is the only speaker icon this control ever renders — clicking it
 * both toggles mute immediately (same as a plain mute button) and, when
 * `canAdjustVolume` allows it, reveals a small slider that extends to its
 * LEFT for fine adjustment. The slider lives inside `root`, a
 * position:relative wrapper sized to the trigger button — the slider is
 * absolutely positioned off `root` (`right: 100%`), not the whole header/
 * toolbar, so it never drops down over the player below and never grows the
 * header's height. Closes on outside click/Escape, keyboard+touch
 * accessible.
 *
 * `canAdjustVolume` gates whether a click reveals the slider at all — always
 * false degrades to a plain quick-mute-toggle click (no slider), same shape
 * as the focused-card short-circuit below, so a capability-less provider and
 * a deliberately-simplified one share one code path.
 */
function createVolumeMuteControl(config: {
  streamId: string;
  footer: HTMLElement;
  panelClassName: string;
  triggerAriaLabel: string;
  muteAriaLabel: string;
  sliderAriaLabel: string;
  canAdjustVolume: () => boolean;
  getMuted: () => boolean;
  getVolume: () => number;
  onToggleMute: () => void;
  onVolumeChange: (value: number) => void;
}): { root: HTMLDivElement; trigger: HTMLButtonElement; panel: HTMLDivElement; closePanel: () => void; sync: () => void } {
  const { streamId, footer, canAdjustVolume, getMuted, getVolume, onToggleMute, onVolumeChange } = config;

  const root = document.createElement('div');
  root.className = 'stream-card__volume-control';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'stream-card__mute-btn';
  trigger.dataset.role = 'trigger';
  trigger.title = 'Volume';
  trigger.setAttribute('aria-label', config.triggerAriaLabel);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = ICON_VOLUME_OFF;
  trigger.addEventListener('pointerdown', (event) => event.stopPropagation());
  trigger.addEventListener('mousedown', (event) => event.stopPropagation());
  trigger.addEventListener('touchstart', (event) => event.stopPropagation());
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    // Unmuting reveals the slider so the just-unmuted level can be
    // fine-tuned without a second control; re-muting closes it — there's
    // nothing to slide once silent, and the same button that opened the
    // panel is one of its documented ways to close it (alongside outside
    // click and Escape below).
    onToggleMute();
    if (getMuted() || focusedStreamId === streamId || !canAdjustVolume()) {
      closePanel();
    } else {
      openPanel();
    }
  });

  const panel = document.createElement('div');
  panel.className = config.panelClassName;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'stream-card__youtube-volume-slider';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = '0';
  slider.setAttribute('aria-label', config.sliderAriaLabel);
  slider.setAttribute('aria-valuemin', '0');
  slider.setAttribute('aria-valuemax', '100');
  slider.setAttribute('aria-valuenow', '0');
  slider.setAttribute('aria-valuetext', '0%');
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
    if (!canAdjustVolume()) return;
    onVolumeChange(Number(slider.value));
  });

  panel.append(slider);
  root.append(panel, trigger);

  let outsidePointerDownTimer: ReturnType<typeof setTimeout> | undefined;

  function onOutsidePointerDown(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (target && root.contains(target)) return;
    closePanel();
  }

  function openPanel(): void {
    if (footer.classList.contains('is-volume-mode')) return;
    footer.classList.add('is-volume-mode');
    trigger.setAttribute('aria-expanded', 'true');
    slider.focus();
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

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!footer.classList.contains('is-volume-mode')) return;
    event.stopPropagation();
    closePanel();
  });

  // sync() paints current state into this instance — the caller collects
  // one per rendered copy (header, hover toolbar) and invokes both from its
  // own syncXUi function so neither copy ever drifts from the other.
  function sync(): void {
    const muted = getMuted();
    const label = muted ? 'Unmute stream' : 'Mute stream';
    trigger.setAttribute('aria-pressed', muted ? 'true' : 'false');
    trigger.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
    trigger.title = label;
    const ready = canAdjustVolume();
    slider.disabled = !ready;
    const volume = muted ? 0 : getVolume();
    slider.value = String(volume);
    slider.setAttribute('aria-valuenow', String(volume));
    slider.setAttribute('aria-valuetext', `${volume}%`);
  }
  sync();

  return { root, trigger, panel, closePanel, sync };
}

function createYouTubeVolumeControl(
  streamId: string,
  _footer: HTMLElement,
): { root: HTMLDivElement; trigger: HTMLButtonElement; closePanel: () => void } {
  const root = document.createElement('div');
  root.className = 'stream-card__volume-control';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'stream-card__mute-btn';
  trigger.title = 'Unmute';
  trigger.setAttribute('aria-label', 'Unmute YouTube video');
  trigger.disabled = true;
  trigger.innerHTML = ICON_VOLUME_OFF;
  // Without this, a pointerdown-then-move on the trigger (not just a click)
  // is unprotected against SortableJS's drag-start detection in
  // headers-visible mode, since the trigger lives inside the header (the
  // drag handle there) and isn't in Sortable's `filter` list.
  trigger.addEventListener('pointerdown', (event) => event.stopPropagation());
  trigger.addEventListener('mousedown', (event) => event.stopPropagation());
  trigger.addEventListener('touchstart', (event) => event.stopPropagation());
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleYouTubeMute(streamId);
  });

  root.append(trigger);

  // No panel to close — kept as a no-op so call sites that close every
  // provider's volume panel on a shared event (see youtubeVolumePanelClosers)
  // don't need a YouTube-specific branch.
  return { root, trigger, closePanel: () => {} };
}

/**
 * Plain Twitch mute toggle: button only, no slider/panel — see
 * DEFAULT_UNMUTE_VOLUME's own doc comment for why Twitch never exposes fine
 * volume control. canAdjustVolume is permanently false, so
 * createVolumeMuteControl's click handler never opens the (unused) panel and
 * always quick-toggles mute directly — same behavior in 'api' and 'fallback'
 * mode, and while the card is focused.
 */
function createTwitchVolumeControl(
  streamId: string,
  footer: HTMLElement,
): { root: HTMLDivElement; trigger: HTMLButtonElement; panel: HTMLDivElement; closePanel: () => void; sync: () => void } {
  return createVolumeMuteControl({
    streamId,
    footer,
    panelClassName: 'stream-card__youtube-volume-panel',
    triggerAriaLabel: 'Open Twitch volume controls',
    muteAriaLabel: 'Mute Twitch stream',
    sliderAriaLabel: 'Twitch volume',
    canAdjustVolume: () => false,
    getMuted: () => {
      const card = cardForStream(streamId);
      return card ? preferredMuted(card) : true;
    },
    getVolume: () => twitchVolume.get(streamId) ?? DEFAULT_UNMUTE_VOLUME,
    onToggleMute: () => {
      const card = cardForStream(streamId);
      if (card) toggleTwitchMute(card);
    },
    onVolumeChange: () => {
      // Unreachable: canAdjustVolume is always false, so
      // createVolumeMuteControl's slider is disabled and its input listener
      // never fires this.
    },
  });
}

/**
 * Toggles the current card's Twitch mute state. 'api' mode mutes live via
 * the player, no reload; 'fallback' (embed script blocked) has no such API,
 * so it goes through mountTwitchIframe's normal reload-with-new-mute-param
 * path instead — the same mechanism focus-unmute already uses for fallback
 * mode. 'pending' just records the preference for the in-flight mount to
 * read once it resolves (see mountStreamMedia). 'api' mode also resets
 * volume to DEFAULT_UNMUTE_VOLUME on every unmute (see that constant's own
 * doc comment) — there's no slider anymore to have left it anywhere else.
 */
function toggleTwitchMute(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';
  const nextMuted = !preferredMuted(card);
  const mode = card.dataset.twitchMode;

  if (mode === 'fallback') {
    mountTwitchIframe(card, nextMuted, 'focus-unmute');
  } else {
    const player = twitchPlayers.get(streamId);
    player?.setMuted(nextMuted);
    if (!nextMuted) player?.setVolume(DEFAULT_UNMUTE_VOLUME / 100);
    card.dataset.embedMuted = nextMuted ? '1' : '0';
  }
  syncTwitchMuteUi(card);
}

/** Keeps every rendered copy of the Twitch control (header, headers-hidden hover toolbar) in sync with card.dataset.embedMuted and twitchVolume. */
function syncTwitchMuteUi(card: HTMLElement): void {
  const muted = preferredMuted(card);
  const label = muted ? 'Unmute stream' : 'Mute stream';
  for (const button of card.querySelectorAll<HTMLButtonElement>('.stream-card__mute-btn')) {
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  const streamId = card.dataset.streamId ?? '';
  for (const sync of twitchVolumeSyncers.get(streamId) ?? []) sync();
}

/**
 * Kick deliberately has NO header mute/volume control. Its embed API exposes
 * mute only via a muted=true/false URL param (see kick.ts's buildEmbedUrl) —
 * there is no postMessage/JS API, so the only way to change it is reloading
 * the iframe's src (mountKickIframe). A one-time reload on entering Focus
 * View ('focus-unmute', pre-existing) is an acceptable, infrequent cost; a
 * header button a viewer can click repeatedly is not — each click would
 * force a full iframe reload (re-buffering, a real chance of resetting
 * Kick's own in-player volume, per reloadKickPlayer's doc comment below on
 * why its automatic-reload predecessor was removed in commit e1799f8).
 * Playback stability wins: viewers use Kick's own native player mute button
 * inside the iframe instead. See docs/PLAYBACK_STABILITY.md.
 */

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
    retainCreatorAvatar(card, 'youtubeAvatarUrl', result.avatarUrl);
    const gridContainer = card.closest<HTMLElement>('#stream-grid');
    if (gridContainer) {
      renderYouTubeCardMeta(card, Date.now());
      syncYouTubeDurationTimer(gridContainer);
    }

    void startYouTubePlayer(card, result.videoId, autoplay);
    return;
  }

  if (result.status === 'offline') {
    retainCreatorAvatar(card, 'youtubeAvatarUrl', result.avatarUrl);
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
  const status = document.createElement('div');
  status.className = 'stream-card__tiktok-status';
  const message = document.createElement('p');
  message.className = 'stream-card__tiktok-status-message';
  message.textContent = text;
  status.append(message);

  if (linkUsername) {
    const link = document.createElement('a');
    link.className = 'stream-card__tiktok-status-link';
    link.href = `https://www.tiktok.com/@${linkUsername}/live`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open on TikTok';
    status.append(link);
  }
  wrap.append(status);
}

/** Pause, detach, and remove a TikTok <video> so a detached node cannot keep playing audio. */
function disposeTikTokVideoElement(video: HTMLVideoElement): void {
  try {
    video.pause();
  } catch {
    // already gone
  }
  video.autoplay = false;
  video.muted = true;
  video.defaultMuted = true;
  video.removeAttribute('src');
  video.srcObject = null;
  while (video.firstChild) video.removeChild(video.firstChild);
  try {
    video.load();
  } catch {
    // jsdom / already-disposed
  }
  video.remove();
}

function applyTikTokVideoMute(video: HTMLVideoElement, muted: boolean): void {
  video.muted = muted;
  video.defaultMuted = muted;
  if (muted) video.setAttribute('muted', '');
  else video.removeAttribute('muted');
}

/**
 * Creator identity (avatar) is independent of live-session fields. A later
 * poll that omits avatarUrl — or reports offline — must not erase a URL we
 * already resolved.
 */
function retainCreatorAvatar(
  card: HTMLElement,
  datasetKey: 'twitchAvatarUrl' | 'kickAvatarUrl' | 'youtubeAvatarUrl',
  avatarUrl: string | undefined | null,
): void {
  if (typeof avatarUrl === 'string' && avatarUrl !== '') {
    card.dataset[datasetKey] = avatarUrl;
  }
}

/** Drops every trace of one TikTok player: in-flight resolve, mpegts player, video element. Safe to call on a card with none of those. */
function forgetTikTokPlayer(streamId: string): void {
  tiktokResolveControllers.get(streamId)?.abort();
  tiktokResolveControllers.delete(streamId);
  const entry = tiktokPlayers.get(streamId);
  tiktokPlayers.delete(streamId);
  if (entry?.player) {
    safeCall(() => entry.player!.pause());
    safeCall(() => entry.player!.unload());
    safeCall(() => entry.player!.detachMediaElement());
    safeCall(() => entry.player!.destroy());
  }
  const videos = new Set<HTMLVideoElement>();
  if (entry?.video) videos.add(entry.video);
  const card = cardForStream(streamId);
  if (card) {
    for (const video of card.querySelectorAll<HTMLVideoElement>('video')) {
      videos.add(video);
    }
  }
  for (const video of videos) {
    disposeTikTokVideoElement(video);
  }
}

/** Invariant: at most one TikTok <video> per stream id. Disposes extras. */
function retainOnlyTikTokVideo(streamId: string, keep: HTMLVideoElement): void {
  const card = cardForStream(streamId);
  if (card) {
    for (const video of [...card.querySelectorAll<HTMLVideoElement>('video')]) {
      if (video !== keep) disposeTikTokVideoElement(video);
    }
  }
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
    showTikTokMessage(card, 'Resolving TikTok LIVE…');

    // The real resolve can take 10-15s (an unauthenticated upstream lookup,
    // not a fast documented API — see tiktok.ts's module doc comment) — a
    // static "Resolving…" that never changes reads as frozen past a few
    // seconds. Each stage is guarded on tiktokMountState still being
    // 'pending' so a resolve that finishes first (the common case) never
    // flashes any of this.
    window.setTimeout(() => {
      if (card.dataset.tiktokMountState === 'pending') {
        showTikTokMessage(card, 'Connecting…');
      }
    }, 2000);
    window.setTimeout(() => {
      if (card.dataset.tiktokMountState === 'pending') {
        showTikTokMessage(card, 'Still connecting…');
      }
    }, 6000);

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
      applyTikTokVideoMute(entry.video, false);
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
    forgetTikTokPlayer(streamId);
    showTikTokMessage(card, describeTikTokState(result.state), result.username);
    logEmbedEvent('tiktok-not-live', {
      platform: 'tiktok',
      channel: `${card.dataset.channel ?? ''} (${result.state})`,
      card,
    });
    return;
  }

  const wrapEl = tiktokWrap(card);
  if (!wrapEl) return;
  const wrap = wrapEl; // narrowed non-null, safe to close over from mountFlv below

  // Genuine remount (manual reload): dispose the previous instance first so
  // a second mpegts/HLS pipeline cannot keep playing in the background.
  // Grid reorder never reaches here — tiktokMountState stays 'mounted'.
  forgetTikTokPlayer(streamId);

  const flvQuality =
    result.qualities.find((q: TikTokQuality) => q.id === 'hd') ??
    result.qualities.find((q: TikTokQuality) => q.protocol === 'flv') ??
    result.qualities[0];
  const hlsQuality = result.qualities.find((q: TikTokQuality) => q.protocol === 'hls');

  wrap.replaceChildren();
  const video = document.createElement('video');
  video.className = 'stream-card__tiktok-video';
  const startMuted = card.dataset.embedMuted !== '0';
  applyTikTokVideoMute(video, startMuted);
  // Restores the intended volume across a re-mount (reload, tab/focus
  // resume) — falls back to DEFAULT_UNMUTE_VOLUME for a brand-new stream
  // (see that constant's own doc comment for why full blast on first unmute
  // is the wrong default).
  video.volume = (tiktokVolume.get(streamId) ?? DEFAULT_UNMUTE_VOLUME) / 100;
  video.autoplay = true;
  video.playsInline = true;

  /**
   * mpegts.js FLV-over-MSE path — the default for every browser without
   * native HLS (i.e. everyone except Safari/iOS). Also used as the HLS
   * branch's own fallback below when native HLS mounts but then fails to
   * actually decode (see that branch's comment for why that happens for
   * real, not just hypothetically).
   */
  function mountFlv(): void {
    if (!flvQuality || !mpegts.isSupported()) {
      card.dataset.tiktokMountState = 'error';
      showTikTokMessage(card, "This browser can't play TikTok LIVE's video format.", result.username);
      return;
    }

    // Falling back from a failed native-HLS attempt leaves a stale `src` on
    // this same <video> — a src attribute takes precedence over MSE, so it
    // has to go before attachMediaElement or mpegts.js would be fighting it.
    video.removeAttribute('src');
    video.load();
    wrap.replaceChildren();
    wrap.append(video);

    const player = mpegts.createPlayer(
      { type: 'flv', isLive: true, url: flvQuality.url, cors: true },
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
    retainOnlyTikTokVideo(streamId, video);
    card.dataset.tiktokMountState = 'mounted';
    logEmbedEvent('tiktok-mounted', { platform: 'tiktok', channel: card.dataset.channel, card });
  }

  // Prefer HLS through the plain <video> element's own native playback only
  // where the browser actually supports HLS without a library (Safari/iOS —
  // canPlayType returns non-empty there, empty everywhere else). That's the
  // one case worth preferring HLS for: iOS Safari has no MSE, so mpegts.js's
  // FLV-over-MSE path can't play there at all. Every other browser keeps the
  // existing, proven mpegts.js FLV path untouched.
  const canPlayNativeHls = hlsQuality ? video.canPlayType('application/vnd.apple.mpegurl') !== '' : false;
  if (hlsQuality && canPlayNativeHls) {
    // Real-tested failure mode, not hypothetical: a canPlayType() "maybe"
    // does not guarantee TikTok's actual HLS manifest demuxes cleanly — it
    // has been observed failing native playback with
    // DEMUXER_ERROR_COULD_NOT_PARSE on a real live stream while the same
    // stream's FLV rendition played fine. Previously this branch had no
    // error handling at all: a failure here left the card at
    // tiktokMountState 'mounted' — looking successful — while showing
    // nothing, forever, with no message and no fallback. `once: true` caps
    // this at a single fallback attempt so a genuinely broken FLV rendition
    // can't bounce back and forth.
    const onNativeHlsError = () => {
      logEmbedEvent('tiktok-player-error', {
        platform: 'tiktok',
        channel: `${card.dataset.channel ?? ''} (native-hls:${video.error?.message ?? video.error?.code ?? 'unknown'})`,
        card,
      });
      mountFlv();
    };
    video.addEventListener('error', onNativeHlsError, { once: true });
    wrap.append(video);
    video.src = hlsQuality.url;
    safeCall(() => void video.play());
    tiktokPlayers.set(streamId, { player: null, video });
    retainOnlyTikTokVideo(streamId, video);
    card.dataset.tiktokMountState = 'mounted';
    logEmbedEvent('tiktok-mounted', { platform: 'tiktok', channel: `${card.dataset.channel ?? ''} (hls)`, card });
    return;
  }

  mountFlv();
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

/**
 * The real <video> element (tiktokPlayers.get(id).video) gives direct
 * synchronous .muted/.volume access — real capability, no postMessage race —
 * so canAdjustVolume is simply "has this card's player mounted yet".
 */
function createTikTokVolumeControl(
  streamId: string,
  footer: HTMLElement,
): { root: HTMLDivElement; trigger: HTMLButtonElement; panel: HTMLDivElement; closePanel: () => void; sync: () => void } {
  return createVolumeMuteControl({
    streamId,
    footer,
    panelClassName: 'stream-card__youtube-volume-panel',
    triggerAriaLabel: 'Open TikTok volume controls',
    muteAriaLabel: 'Mute TikTok stream',
    sliderAriaLabel: 'TikTok volume',
    canAdjustVolume: () => tiktokPlayers.has(streamId),
    getMuted: () => {
      const card = cardForStream(streamId);
      return card ? preferredMuted(card) : true;
    },
    getVolume: () => tiktokVolume.get(streamId) ?? DEFAULT_UNMUTE_VOLUME,
    onToggleMute: () => {
      const card = cardForStream(streamId);
      if (card) toggleTikTokMute(card);
    },
    onVolumeChange: (value) => {
      const card = cardForStream(streamId);
      const entry = tiktokPlayers.get(streamId);
      if (!card || !entry) return;
      const wasMuted = preferredMuted(card);
      const nextMuted = value === 0;
      entry.video.volume = value / 100;
      if (nextMuted !== wasMuted) {
        applyTikTokVideoMute(entry.video, nextMuted);
        if (!nextMuted) safeCall(() => void entry.video.play());
        card.dataset.embedMuted = nextMuted ? '1' : '0';
      }
      if (value > 0) tiktokVolume.set(streamId, value);
      syncTikTokMuteUi(card);
    },
  });
}

function toggleTikTokMute(card: HTMLElement): void {
  const streamId = card.dataset.streamId ?? '';
  const nextMuted = !preferredMuted(card);
  const entry = tiktokPlayers.get(streamId);
  if (entry) {
    applyTikTokVideoMute(entry.video, nextMuted);
    if (!nextMuted) safeCall(() => void entry.video.play());
  }
  card.dataset.embedMuted = nextMuted ? '1' : '0';
  syncTikTokMuteUi(card);
}

/** Keeps every rendered copy of the TikTok control (header, headers-hidden hover toolbar) in sync with card.dataset.embedMuted and tiktokVolume. */
function syncTikTokMuteUi(card: HTMLElement): void {
  const muted = preferredMuted(card);
  const label = muted ? 'Unmute stream' : 'Mute stream';
  for (const button of card.querySelectorAll<HTMLButtonElement>('.stream-card__mute-btn')) {
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  const streamId = card.dataset.streamId ?? '';
  for (const sync of tiktokVolumeSyncers.get(streamId) ?? []) sync();
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
    player?.play();
    // play() can unmute; apply the requested mute *after* so tab-resume of a
    // muted tile never leaks audio, and focused unmute still lands.
    player?.setMuted(muted);
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
    // The trigger stops opening the panel while focused (see
    // createVolumeMuteControl) — close one left open from grid view so the
    // header doesn't get stuck in is-volume-mode.
    for (const close of twitchVolumePanelClosers.get(streamId) ?? []) close();
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
    for (const close of tiktokVolumePanelClosers.get(streamId) ?? []) close();
  }
}

export function getFocusedStreamId(): string | null {
  return focusedStreamId;
}

/**
 * X means two different things depending on where it sits, and the label
 * must say so: on the primary (Theater or Focus) it EXITS back to Grid —
 * the stream stays in the lineup, nothing is removed — while on a tray card
 * it REMOVES that stream from the lineup like any other X. Applied to both
 * the header close button and its headers-hidden overlay twin.
 */
function syncCloseButtonLabel(button: HTMLButtonElement | null, isExitControl: boolean): void {
  if (!button) return;
  if (isExitControl) {
    button.title = 'Return to Grid';
    button.setAttribute('aria-label', 'Return to Grid');
  } else {
    button.title = 'Remove stream';
    button.setAttribute('aria-label', 'Remove stream');
  }
}

/**
 * The per-card Focus control is also two different things depending on
 * context: on any card in Grid View (or a tray card) it's the ONE entry
 * point into Theater (see focusViewEntryHandler's doc comment). On the
 * current primary, once already in Theater/Focus, it's repurposed as the
 * Focus toggle — the same "Focus toggle remains available" control the
 * directive requires, reusing one button/icon instead of adding a second.
 */
function syncFocusButtonLabel(button: HTMLButtonElement | null, isToggleControl: boolean, trayVisible: boolean): void {
  if (!button) return;
  const isOverlay = button.classList.contains('stream-card__overlay-focus');
  if (isToggleControl) {
    if (trayVisible) {
      button.title = 'Exit Theater Mode';
      button.setAttribute('aria-label', 'Exit Theater Mode');
      button.setAttribute('aria-pressed', 'true');
      button.innerHTML = isOverlay ? ICON_MAGNIFIER : ICON_FULL_WINDOW;
    } else {
      button.title = 'Enter Theater Mode';
      button.setAttribute('aria-label', 'Enter Theater Mode');
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = ICON_THEATER;
    }
  } else {
    button.title = 'Focus stream';
    button.setAttribute('aria-label', 'Focus stream in browser window');
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = isOverlay ? ICON_MAGNIFIER : ICON_FULL_WINDOW;
  }
}

function syncFocusViewDom(container: HTMLElement): void {
  const mode = container.dataset.viewMode;
  const inPrimaryMode = mode === 'theater' || mode === 'focus';
  const trayVisible = mode === 'focus';
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    const isPrimary = inPrimaryMode && card.dataset.streamId === focusViewPrimaryId;
    card.classList.toggle('is-focus-primary', isPrimary);

    const header = card.querySelector<HTMLElement>('.stream-card__header');
    const promotable = trayVisible && !isPrimary;
    if (header) {
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

    syncCloseButtonLabel(card.querySelector<HTMLButtonElement>('.stream-card__close'), isPrimary);
    syncCloseButtonLabel(card.querySelector<HTMLButtonElement>('.stream-card__overlay-remove'), isPrimary);
    syncFocusButtonLabel(card.querySelector<HTMLButtonElement>('.stream-card__focus'), isPrimary, trayVisible);
    syncFocusButtonLabel(card.querySelector<HTMLButtonElement>('.stream-card__overlay-focus'), isPrimary, trayVisible);
  }
}

/**
 * Called whenever the view-mode store changes and whenever the stream list
 * changes (see syncStreamGrid) — picks/revalidates the primary so it's never
 * left pointing at a removed stream, and always writes data-view-mode so
 * updateGridLayout and the CSS know which layout to use.
 *
 * Theater (no tray) and Focus (tray) are two faces of the same primary/tray
 * machinery — both are "not grid" modes that share focusViewPrimaryId, only
 * differing in whether the tray is rendered. Treating them as one group
 * below (mode !== 'grid') is what lets the Focus toggle switch between them
 * without ever touching, resetting, or re-resolving the primary.
 *
 * The old solo per-card "expand" mode (focusedStreamId/.is-focused, predates
 * Theater/Focus) and this primary/tray layout must never both be active at
 * once — updateGridLayout only ever renders one of them (it skips the
 * primary/tray branch whenever focusedStreamId is set, see its own doc
 * comment), so entering Theater/Focus while a card is solo-focused would
 * leave the primary/tray CSS applied to the DOM while the JS-computed layout
 * vars are still the solo-focus ones — stale/conflicting sizing, not a clean
 * picture in either mode. Exiting solo-focus first, then carrying that same
 * stream forward as the primary, is the one clean transition.
 */
export function syncViewMode(container: HTMLElement, mode: ViewMode, streams: StreamRef[]): void {
  if (mode === 'focus' && container.dataset.viewMode !== 'focus') {
    pendingTrayNudge = true;
  }

  if (mode !== 'grid' && focusedStreamId) {
    const soloFocusedId = focusedStreamId;
    setFocusedStream(container, null);
    if (streams.some((s) => s.id === soloFocusedId)) {
      focusViewPrimaryId = soloFocusedId;
    }
  }

  container.dataset.viewMode = mode;
  if (mode !== 'grid' && (!focusViewPrimaryId || !streams.some((s) => s.id === focusViewPrimaryId))) {
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
  focusViewPrimaryChangedHandler?.();
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
  // Keeps data-tray-overflow (the edge-fade mask, see main.css) in sync as
  // the viewer scrolls the tray by hand, not just right after a layout pass.
  container.addEventListener(
    'scroll',
    () => {
      if (container.dataset.viewMode !== 'focus') return;
      updateFocusTrayOverflowIndicator(container);
    },
    { passive: true },
  );
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

function isCurrentPrimaryInPrimaryMode(container: HTMLElement, streamId: string): boolean {
  const mode = container.dataset.viewMode;
  return (mode === 'theater' || mode === 'focus') && focusViewPrimaryId === streamId;
}

/** X on the primary exits Theater/Focus back to Grid (see syncCloseButtonLabel's doc comment); X on anything else removes that stream normally. */
function handleCardCloseClick(container: HTMLElement, store: StreamStore, stream: StreamRef): void {
  if (isCurrentPrimaryInPrimaryMode(container, stream.id)) {
    focusViewExitHandler?.();
    return;
  }
  const previousIndex = store.getStreams().findIndex((s) => s.id === stream.id);
  store.removeStream(stream.id);
  streamRemovedHandler?.(stream, previousIndex);
}

/** On the current primary, repurposed as the Focus toggle; on anything else, Theater's one entry point (see syncFocusButtonLabel's doc comment). */
function handleCardFocusClick(container: HTMLElement, stream: StreamRef): void {
  if (typeof window.matchMedia === 'function' && isPhoneViewport()) return;
  if (isCurrentPrimaryInPrimaryMode(container, stream.id)) {
    focusViewToggleHandler?.();
    return;
  }
  focusViewEntryHandler?.(stream.id);
  unmuteTheaterEntryPrimary(stream.id);
}

/**
 * Turns audio on for the stream a viewer just deliberately picked as Theater
 * primary — restores the pre-regression behavior where entering Theater was
 * itself the unmute gesture, instead of leaving the viewer muted in a bigger
 * player. Runs synchronously inside the same click handler as the Theater
 * entry itself (handleCardFocusClick, a real user gesture), so browser
 * autoplay-audio policy allows it.
 *
 * Deliberately narrow: only ever calls each provider's own mute()/unMute()/
 * setVolume() (or, for TikTok, the real <video> element's .muted/.volume) —
 * never destroy/reload/reconstruct a player, never touch an iframe's src.
 * That's what keeps this from reintroducing the Theater-exit Twitch-pause
 * regression (beginFocusExitRecovery/snapshotPlayingTwitchPlayers), which
 * was caused by a layout-driven remount, not by anything audio-related.
 *
 * Twitch fallback-mode and Kick are skipped outright: neither exposes a
 * live audio API, only a reload-with-different-params path, and reloading
 * on every Theater entry would re-buffer the stream — worse than staying
 * muted. Kick's native player controls remain the only way to unmute it,
 * same as everywhere else in the app (see the no-header-control comment on
 * Kick's audio model above).
 */
function unmuteTheaterEntryPrimary(streamId: string): void {
  const card = cardForStream(streamId);
  if (!card) return;

  switch (card.dataset.platform) {
    case 'twitch': {
      if (card.dataset.twitchMode !== 'api') return; // fallback iframe: no API, don't reload
      const player = twitchPlayers.get(streamId);
      if (!player) return;
      player.setMuted(false);
      player.setVolume(DEFAULT_UNMUTE_VOLUME / 100);
      card.dataset.embedMuted = '0';
      syncTwitchMuteUi(card);
      return;
    }
    case 'youtube': {
      const player = youtubePlayers.get(streamId);
      if (!player) return;
      player.unMute();
      player.setVolume(DEFAULT_UNMUTE_VOLUME);
      youtubeVolumeState.set(streamId, { muted: false, volume: DEFAULT_UNMUTE_VOLUME });
      syncYouTubeVolumeUi(card);
      return;
    }
    case 'tiktok': {
      const entry = tiktokPlayers.get(streamId);
      if (!entry) return;
      applyTikTokVideoMute(entry.video, false);
      entry.video.volume = DEFAULT_UNMUTE_VOLUME / 100;
      tiktokVolume.set(streamId, DEFAULT_UNMUTE_VOLUME);
      safeCall(() => void entry.video.play());
      card.dataset.embedMuted = '0';
      syncTikTokMuteUi(card);
      return;
    }
    default:
      return; // kick: no live audio API, native controls only
  }
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

  // Viewer count + "Live for…" duration, appended inline after the platform
  // badge once a live status check resolves — see applyTwitchStatus /
  // applyKickStatus / applyYouTubeStats and their render helpers. Hidden (no
  // text) for every other state; the dot itself plus its title/aria-label
  // carry the full status for offline/not_found/unavailable. TikTok is the
  // only platform with no metadata source at all, so it never gets a span.
  const headerNameBadge = createNameBadge(
    stream,
    adapter,
    stream.platform === 'twitch' || stream.platform === 'youtube' || stream.platform === 'kick',
  );

  const controls = document.createElement('div');
  controls.className = 'stream-card__controls';

  const focusButton = document.createElement('button');
  focusButton.type = 'button';
  focusButton.className = 'stream-card__focus';
  focusButton.title = 'Focus stream';
  focusButton.setAttribute('aria-label', 'Focus stream in browser window');
  focusButton.setAttribute('aria-pressed', 'false');
  focusButton.innerHTML = ICON_FULL_WINDOW;
  focusButton.addEventListener('click', () => handleCardFocusClick(container, stream));

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'stream-card__close';
  removeButton.title = 'Remove stream';
  removeButton.setAttribute('aria-label', 'Remove stream');
  // Same icon and markup as the toolbar's overlayRemove below — one
  // mathematically symmetric SVG, no text glyph, no per-location offset.
  removeButton.innerHTML = ICON_CLOSE;
  removeButton.addEventListener('click', () => handleCardCloseClick(container, store, stream));

  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.className = 'stream-card__reload';
  reloadButton.title = 'Reload stream';
  reloadButton.setAttribute('aria-label', 'Reload stream');
  reloadButton.innerHTML =
    '<span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 7A5 5 0 1 1 10.5 3.4M12 1.5V4.5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  reloadButton.addEventListener('click', () => reloadStreamCard(card));

  if (stream.platform === 'youtube') {
    youtubeVolumePanelClosers.set(stream.id, []);
    const { root, closePanel } = createYouTubeVolumeControl(stream.id, header);
    controls.append(root);
    youtubeVolumePanelClosers.get(stream.id)!.push(closePanel);
  } else if (stream.platform === 'twitch') {
    twitchVolumePanelClosers.set(stream.id, []);
    twitchVolumeSyncers.set(stream.id, []);
    const { root, closePanel, sync } = createTwitchVolumeControl(stream.id, header);
    controls.append(root);
    twitchVolumePanelClosers.get(stream.id)!.push(closePanel);
    twitchVolumeSyncers.get(stream.id)!.push(sync);
  } else if (stream.platform === 'tiktok') {
    tiktokVolumePanelClosers.set(stream.id, []);
    tiktokVolumeSyncers.set(stream.id, []);
    const { root, closePanel, sync } = createTikTokVolumeControl(stream.id, header);
    controls.append(root);
    tiktokVolumePanelClosers.get(stream.id)!.push(closePanel);
    tiktokVolumeSyncers.get(stream.id)!.push(sync);
    card.dataset.tiktokAvatarUrl = tiktokAvatarEndpoint(stream.channel);
  }
  controls.append(focusButton, reloadButton, removeButton);
  header.append(headerNameBadge.root, controls);

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
  // Same control as the header's focusButton above — this is its
  // headers-hidden hover-toolbar copy (see handleCardFocusClick).
  overlayFocus.addEventListener('click', () => handleCardFocusClick(container, stream));

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
  overlayRemove.addEventListener('click', () => handleCardCloseClick(container, store, stream));

  if (stream.platform === 'youtube') {
    const { root, closePanel } = createYouTubeVolumeControl(stream.id, toolbar);
    overlayControls.append(root);
    youtubeVolumePanelClosers.get(stream.id)!.push(closePanel);
  } else if (stream.platform === 'twitch') {
    const { root, closePanel, sync } = createTwitchVolumeControl(stream.id, toolbar);
    overlayControls.append(root);
    twitchVolumePanelClosers.get(stream.id)!.push(closePanel);
    twitchVolumeSyncers.get(stream.id)!.push(sync);
  } else if (stream.platform === 'tiktok') {
    const { root, closePanel, sync } = createTikTokVolumeControl(stream.id, toolbar);
    overlayControls.append(root);
    tiktokVolumePanelClosers.get(stream.id)!.push(closePanel);
    tiktokVolumeSyncers.get(stream.id)!.push(sync);
  }
  overlayControls.append(overlayDrag, overlayFocus, overlayReload, overlayRemove);

  toolbar.append(toolbarNameBadge.root, overlayControls);

  card.append(header, player, toolbar);

  if (stream.platform === 'tiktok') {
    syncTikTokMuteUi(card);
  }

  if (stream.platform === 'twitch') {
    syncTwitchMuteUi(card);

    /*
     * Headers-hidden reveals this toolbar on hover by shrinking the player
     * box (main.css) — a real iframe resize we otherwise never observe, on
     * both open and close. Arm recovery at transitionstart (not end) so a
     * headers-hidden drag that begins mid-animation still has this card in
     * the coordinator's pending set before Sortable's onChoose snapshot.
     * The bounded schedule already waits for Twitch's async pause; starting
     * 150ms earlier does not issue a premature play() on a still-healthy
     * player (pass 0 only acts on a positive paused reading).
     */
    toolbar.addEventListener('transitionstart', (event) => {
      if (event.propertyName !== 'height') return;
      const wasPlaying = twitchPlayback.get(stream.id) === 'playing';
      logPlayerEvent('toolbar-transition-start', {
        streamId: stream.id,
        mountId: card.querySelector<HTMLElement>('.stream-card__iframe')?.id,
        wasPlaying,
      });
      if (!wasPlaying) return;
      playbackRecovery.hover(createTwitchRecoveryTarget(stream.id, Date.now()), 'toolbar-hover');
    });
    toolbar.addEventListener('transitionend', (event) => {
      if (event.propertyName !== 'height') return;
      logPlayerEvent('toolbar-transition-end', {
        streamId: stream.id,
        mountId: card.querySelector<HTMLElement>('.stream-card__iframe')?.id,
      });
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

/**
 * Phone stacked layout only: play the most-visible stream, pause the rest.
 * Kick has no player API — pausing it would blank+remount (and remute), so
 * Kick is left playing. Twitch fallback iframes and unresolved YouTube/
 * TikTok mounts are skipped the same way. Theater/Focus keep their own
 * freeze path and are not observed.
 */
const PHONE_VISIBLE_MIN_RATIO = 0.5;
const PHONE_VISIBLE_HYSTERESIS = 0.08;

let phoneVisibleObserver: IntersectionObserver | null = null;
let phoneVisibleContainer: HTMLElement | null = null;
let phoneVisiblePrimaryId: string | null = null;
const phoneVisibleRatios = new Map<string, number>();

function phoneStackActive(): boolean {
  return typeof window.matchMedia === 'function' && isStackedStreamLayout();
}

function pausePhoneVisibleCard(card: HTMLElement): void {
  if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return;
  const streamId = card.dataset.streamId ?? '';
  if (card.dataset.platform === 'kick') return;
  if (card.dataset.platform === 'twitch') {
    if (card.dataset.twitchMode !== 'api') return;
    const player = twitchPlayers.get(streamId);
    if (player && !player.isPaused()) player.pause();
    return;
  }
  if (card.dataset.platform === 'youtube') {
    youtubePlayers.get(streamId)?.pauseVideo();
    return;
  }
  if (card.dataset.platform === 'tiktok') {
    tiktokPlayers.get(streamId)?.video.pause();
  }
}

function playPhoneVisibleCard(card: HTMLElement): void {
  if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return;
  const streamId = card.dataset.streamId ?? '';
  if (card.dataset.platform === 'kick') return;
  if (card.dataset.platform === 'twitch') {
    if (card.dataset.twitchMode !== 'api') return;
    const player = twitchPlayers.get(streamId);
    if (!player) return;
    if (player.isPaused()) {
      player.play();
      player.setMuted(preferredMuted(card));
    }
    return;
  }
  if (card.dataset.platform === 'youtube') {
    youtubePlayers.get(streamId)?.playVideo();
    return;
  }
  if (card.dataset.platform === 'tiktok') {
    const entry = tiktokPlayers.get(streamId);
    if (entry) safeCall(() => void entry.video.play());
  }
}

export function applyPhoneVisiblePlayback(
  container: HTMLElement,
  visibilities: ReadonlyArray<{ id: string; ratio: number }>,
): string | null {
  if (!phoneStackActive()) return phoneVisiblePrimaryId;
  const mode = container.dataset.viewMode;
  if (mode === 'focus' || mode === 'theater') return phoneVisiblePrimaryId;

  let bestId: string | null = null;
  let bestRatio = 0;
  const ratioById = new Map<string, number>();
  for (const { id, ratio } of visibilities) {
    ratioById.set(id, ratio);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestId = id;
    }
  }

  const currentId = phoneVisiblePrimaryId;
  const currentRatio = currentId ? (ratioById.get(currentId) ?? 0) : 0;
  let next = currentId;
  if (bestRatio < PHONE_VISIBLE_MIN_RATIO) {
    next = currentRatio >= PHONE_VISIBLE_MIN_RATIO - PHONE_VISIBLE_HYSTERESIS ? currentId : null;
  } else if (!currentId || currentRatio < PHONE_VISIBLE_MIN_RATIO - PHONE_VISIBLE_HYSTERESIS) {
    next = bestId;
  } else if (bestId && bestId !== currentId && bestRatio >= currentRatio + PHONE_VISIBLE_HYSTERESIS) {
    next = bestId;
  }

  phoneVisiblePrimaryId = next;

  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    const id = card.dataset.streamId ?? '';
    if (next && id === next) playPhoneVisibleCard(card);
    else pausePhoneVisibleCard(card);
  }

  return phoneVisiblePrimaryId;
}

function phoneVisibleObserverCallback(entries: IntersectionObserverEntry[]): void {
  if (!phoneVisibleContainer) return;
  for (const entry of entries) {
    const id = (entry.target as HTMLElement).dataset.streamId;
    if (!id) continue;
    phoneVisibleRatios.set(id, entry.intersectionRatio);
  }
  applyPhoneVisiblePlayback(
    phoneVisibleContainer,
    [...phoneVisibleRatios.entries()].map(([id, ratio]) => ({ id, ratio })),
  );
}

export function bindPhoneVisiblePlayback(container: HTMLElement): void {
  phoneVisibleContainer = container;
  syncPhoneVisiblePlayback(container);
}

export function syncPhoneVisiblePlayback(container: HTMLElement): void {
  phoneVisibleContainer = container;
  const stacked =
    phoneStackActive() &&
    container.dataset.viewMode !== 'focus' &&
    container.dataset.viewMode !== 'theater';

  if (!stacked) {
    const wasObserving = phoneVisibleObserver !== null;
    phoneVisibleObserver?.disconnect();
    phoneVisibleObserver = null;
    phoneVisibleRatios.clear();
    if (wasObserving && typeof window.matchMedia === 'function' && !isStackedStreamLayout()) {
      for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
        playPhoneVisibleCard(card);
      }
    }
    phoneVisiblePrimaryId = null;
    return;
  }

  if (typeof IntersectionObserver === 'undefined') return;

  if (!phoneVisibleObserver) {
    phoneVisibleObserver = new IntersectionObserver(phoneVisibleObserverCallback, {
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });
  }

  const cards = [...container.querySelectorAll<HTMLElement>('.stream-card')];
  const liveIds = new Set(cards.map((card) => card.dataset.streamId ?? ''));
  for (const id of [...phoneVisibleRatios.keys()]) {
    if (!liveIds.has(id)) phoneVisibleRatios.delete(id);
  }
  phoneVisibleObserver.disconnect();
  for (const card of cards) phoneVisibleObserver.observe(card);
}

export function __resetPhoneVisiblePlaybackForTests(): void {
  phoneVisibleObserver?.disconnect();
  phoneVisibleObserver = null;
  phoneVisibleContainer = null;
  phoneVisiblePrimaryId = null;
  phoneVisibleRatios.clear();
}

export function bindStreamFocus(handler: FocusChangeHandler): void {
  focusChangeHandler = handler;
  bindFocusEscape();
}

/**
 * Wires main.ts's viewModeStore into the per-card Focus control (see
 * focusViewEntryHandler's own doc comment for why this replaced the old
 * global header toggle as Focus View's only entry point). The handler is
 * expected to set the stream as primary and switch to Focus View in one
 * synchronous pair of calls — e.g. `(id) => { setFocusViewPrimary(grid,
 * id); viewModeStore.setMode('focus'); }` — so there's no frame where the
 * grid shows 'focus' mode with the wrong (or no) primary.
 */
export function bindFocusViewEntry(handler: (streamId: string) => void): void {
  focusViewEntryHandler = handler;
}

/** Primary's X — exit Theater/Focus back to Grid (see focusViewExitHandler's own doc comment). */
export function bindFocusViewExit(handler: () => void): void {
  focusViewExitHandler = handler;
}

/** Primary's repurposed Focus control — toggle the tray on/off without touching the primary (see focusViewToggleHandler's own doc comment). */
export function bindFocusViewToggle(handler: () => void): void {
  focusViewToggleHandler = handler;
}

/** Fires on entry and on every promotion — lets main.ts keep chat locked to whichever stream is currently primary (see focusViewPrimaryChangedHandler's own doc comment). */
export function bindFocusViewPrimaryChanged(handler: () => void): void {
  focusViewPrimaryChangedHandler = handler;
}

export function bindStreamRemoved(handler: StreamRemovedHandler): void {
  streamRemovedHandler = handler;
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
 * Explicit toolbar Refresh — more forceful than automatic recovery, still
 * not a page reload. Twitch: replay a live api player, or the proven
 * per-card reload if that player is missing/unreadable/fallback. Kick and
 * YouTube: existing manual remount. TikTok: remount only when the live
 * <video> is absent or already stopped (a healthy LIVE stays mounted).
 */
export function refreshLoadedStreamPlayers(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    const platform = card.dataset.platform;
    if (platform === 'twitch') {
      refreshTwitchPlayerForManual(card);
      continue;
    }
    if (platform === 'kick' || platform === 'youtube') {
      reloadStreamCard(card);
      continue;
    }
    if (platform === 'tiktok') {
      refreshTikTokPlayerIfNeeded(card);
    }
  }
}

function refreshTwitchPlayerForManual(card: HTMLElement): void {
  if (card.dataset.twitchMode === 'api') {
    const streamId = card.dataset.streamId ?? '';
    const player = twitchPlayers.get(streamId);
    if (player) {
      const paused = checkPaused(player, streamId);
      if (paused === false) return;
      if (paused === true) {
        logEmbedEvent('player-recover', { platform: 'twitch', channel: card.dataset.channel, card });
        reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'manual-replay' });
        replayTwitchPlayback(player, card);
        return;
      }
    }
  }
  reloadStreamCard(card);
}

function refreshTikTokPlayerIfNeeded(card: HTMLElement): void {
  if (card.dataset.tiktokMountState === 'pending') return;
  const streamId = card.dataset.streamId ?? '';
  const video = tiktokPlayers.get(streamId)?.video;
  if (video && !video.paused && !video.ended) return;
  reloadTikTokPlayer(card);
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
    retainCreatorAvatar(
      card,
      'twitchAvatarUrl',
      result.status === 'live' || result.status === 'offline' ? result.avatarUrl : undefined,
    );

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

// --- Kick status ---------------------------------------------------------
// Deliberately the same advisory, player-untouching shape as the Twitch
// block above: dataset attributes + the name-badge dot/meta span, nothing
// else. A Kick card's iframe mounts and plays whether or not any of this
// resolves — including when the server has no Kick credentials installed at
// all, which comes back as `not_configured` and is treated as "no metadata
// yet", never as an error state.

/**
 * `not_configured` and `invalid_input` deliberately return null: neither is
 * something to paint on a card. A card with no Kick credentials behind it
 * keeps the decorative always-pulsing dot it has always had (see
 * createNameBadge) rather than acquiring a misleading grey "unavailable"
 * indicator, and its meta span stays empty.
 */
export function kickStatusDotProps(
  result: KickStatusResult,
): { modifier: TwitchDotModifier; label: string } | null {
  if (result.status === 'invalid_input' || result.status === 'not_configured') return null;
  return { modifier: result.status, label: DOT_STATUS_LABELS[result.status] };
}

/**
 * Renders one Kick card's already-known status from its `data-kick-*`
 * dataset, using the exact same formatters and the exact same
 * "12.4K viewers · 2h 14m" meta shape as Twitch (see renderTwitchCardStatus)
 * so the two providers read identically in the header.
 *
 * With no `data-kick-status` at all — the pre-credentials state — this
 * leaves the dot exactly as createNameBadge built it and only clears the
 * meta span, so an unconfigured Kick card is visually unchanged from before
 * this feature existed.
 */
function renderKickCardStatus(card: HTMLElement, nowMs: number): void {
  const statusValue = card.dataset.kickStatus;
  const props = isTwitchDotModifier(statusValue)
    ? { modifier: statusValue, label: DOT_STATUS_LABELS[statusValue] }
    : null;

  const category = card.dataset.kickCategory;
  const viewers = formatTwitchViewerCount(
    card.dataset.kickViewerCount === undefined ? undefined : Number(card.dataset.kickViewerCount),
  );
  const duration = formatTwitchLiveDuration(card.dataset.kickStartedAt, nowMs);
  const { tooltip, meta } = twitchStatusText(props, category, viewers, duration);

  if (props) {
    for (const dot of card.querySelectorAll<HTMLElement>('.stream-card__name-badge-dot')) {
      for (const modifier of DOT_STATUS_MODIFIERS) {
        dot.classList.remove(`stream-card__name-badge-dot--${modifier}`);
      }
      dot.classList.remove('stream-card__name-badge-dot--pulse');
      dot.classList.add(`stream-card__name-badge-dot--${props.modifier}`);
      if (props.modifier === 'live') dot.classList.add('stream-card__name-badge-dot--pulse');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-hidden', 'false');
      dot.setAttribute('aria-label', tooltip);
      dot.title = tooltip;
    }
  }

  const metaEl = card.querySelector<HTMLElement>('.stream-card__name-badge-meta');
  if (metaEl) {
    metaEl.textContent = meta ? `· ${meta}` : '';
    metaEl.hidden = meta.length === 0;
  }
}

let kickDurationTimerId = 0;

/** Test-only counterpart to __resetTwitchDurationTimerForTests. */
export function __resetKickDurationTimerForTests(): void {
  if (kickDurationTimerId) {
    window.clearInterval(kickDurationTimerId);
    kickDurationTimerId = 0;
  }
}

/** One shared 60s timer for every live Kick card's duration text — never one per card. */
function syncKickDurationTimer(container: HTMLElement): void {
  const hasLiveDuration =
    container.querySelector('.stream-card[data-platform="kick"][data-kick-started-at]') !== null;

  if (!hasLiveDuration) {
    if (kickDurationTimerId) {
      window.clearInterval(kickDurationTimerId);
      kickDurationTimerId = 0;
    }
    return;
  }

  if (kickDurationTimerId) return;
  kickDurationTimerId = window.setInterval(() => {
    if (!container.isConnected) {
      window.clearInterval(kickDurationTimerId);
      kickDurationTimerId = 0;
      return;
    }
    const now = Date.now();
    for (const card of container.querySelectorAll<HTMLElement>(
      '.stream-card[data-platform="kick"][data-kick-started-at]',
    )) {
      renderKickCardStatus(card, now);
    }
  }, 60_000);
}

/**
 * Applies already-fetched Kick status results to whatever matching Kick
 * cards currently exist. Only ever touches the name-badge dot, the meta
 * span, and `data-kick-*` dataset attributes — never mountStreamMedia, never
 * an iframe, never the Kick player's src. Viewer count / duration / category
 * are attached to live results only, so an offline card can never keep
 * showing a stale count or a duration that goes on ticking.
 *
 * The avatar URL lands in `data-kick-avatar-url`, the same dataset
 * convention Twitch and YouTube use, which is all the Story Card needs to
 * pick it up (see StreamToolbar.ts's collectShareCardAvatarUrls) — there is
 * no separate Kick avatar request anywhere in the app.
 */
export function applyKickStatus(
  container: HTMLElement,
  results: Map<string, KickStatusResult>,
): void {
  const nowMs = Date.now();

  for (const card of container.querySelectorAll<HTMLElement>('.stream-card[data-platform="kick"]')) {
    const channel = card.dataset.channel ?? '';
    const result = results.get(channel);
    if (!result) continue;

    const props = kickStatusDotProps(result);
    if (props) {
      card.dataset.kickStatus = props.modifier;
    } else {
      delete card.dataset.kickStatus;
    }

    if (result.status === 'live' && result.startedAt) {
      card.dataset.kickStartedAt = result.startedAt;
    } else {
      delete card.dataset.kickStartedAt;
    }
    if (result.status === 'live' && result.category) {
      card.dataset.kickCategory = result.category;
    } else {
      delete card.dataset.kickCategory;
    }
    if (result.status === 'live' && result.viewerCount !== undefined) {
      card.dataset.kickViewerCount = String(result.viewerCount);
    } else {
      delete card.dataset.kickViewerCount;
    }
    retainCreatorAvatar(
      card,
      'kickAvatarUrl',
      result.status === 'live' || result.status === 'offline' ? result.avatarUrl : undefined,
    );

    renderKickCardStatus(card, nowMs);
  }

  syncKickDurationTimer(container);
}

/** Kick's counterpart to refreshTwitchStatus — fire-and-forget, one batched request. */
export function refreshKickStatus(container: HTMLElement, channels: string[]): void {
  const wanted = channels.filter(Boolean);
  if (wanted.length === 0) return;
  void checkKickStatus(wanted).then((results) => {
    if (!container.isConnected) return;
    applyKickStatus(container, results);
  });
}

const kickStatusCoordinator = createTwitchStatusCoordinator<KickStatusResult>({
  checkStatus: checkKickStatus,
  onResult: (results, _reason) => {
    const container = document.querySelector<HTMLElement>('#stream-grid');
    if (!container || !container.isConnected) return;
    applyKickStatus(container, results);
  },
});

/** Kick's counterpart to refreshAllTwitchStatuses — same single-in-flight gate. */
export function refreshAllKickStatuses(
  store: StreamStore,
  reason: TwitchStatusRefreshReason,
): Promise<TwitchStatusRefreshResult<KickStatusResult>> {
  const channels = store
    .getStreams()
    .filter((stream) => stream.platform === 'kick')
    .map((stream) => stream.channel);
  return kickStatusCoordinator.refresh(channels, reason);
}

export function isKickStatusRefreshInFlight(): boolean {
  return kickStatusCoordinator.isInFlight();
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
  if (card.dataset.streamId && isActivelyWatchedStream(card.dataset.streamId)) return;

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
    if (card.dataset.streamId && isActivelyWatchedStream(card.dataset.streamId)) return;

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
      replayTwitchPlayback(player, card);
      return;
    }

    const count = (twitchStallCounts.get(streamId) ?? 0) + 1;
    twitchStallCounts.set(streamId, count);

    if (count >= 2) {
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'reconnect' });
      player.setChannel(card.dataset.channel ?? '');
      twitchStallCounts.set(streamId, 0);
      enforcePreferredMute(player, card);
    } else {
      reportEmbedRecovery('player-recover', { platform: 'twitch', reason: 'replay' });
      replayTwitchPlayback(player, card);
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
      const card = cardForStream(streamId);
      if (card) replayTwitchPlayback(player, card);
      else player.play();
    },

    escalate() {
      const card = cardForStream(streamId);
      if (!card?.isConnected) return;
      if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return;
      if (Number(card.dataset.userEngagedAt ?? '0') >= startedAt) return;
      reloadStreamCard(card);
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
 * Reorder snapshot for headers-hidden as well as headers-visible. Hovering
 * the overlay grip shrinks the player before Sortable's onStart, so a
 * playing-only read can miss the exact cards the drag is about to further
 * resize. Union the live playing set with ids the coordinator is already
 * chasing (toolbar-hover / in-flight transaction). User-paused streams are
 * in neither set.
 */
export function snapshotReorderRecoveryIds(container: HTMLElement): string[] {
  const pending = playbackRecovery.pendingIds().filter((id) => {
    const card = cardForStream(id);
    return Boolean(card?.isConnected) && container.contains(card);
  });
  return [...new Set([...snapshotPlayingTwitchPlayers(container), ...pending])];
}

export function pendingTwitchRecoveryIds(): string[] {
  return playbackRecovery.pendingIds();
}

const twitchPlayerObjectIds = new WeakMap<object, number>();
let twitchPlayerObjectSeq = 0;

function twitchPlayerObjectId(player: object | undefined): number | null {
  if (!player) return null;
  let id = twitchPlayerObjectIds.get(player);
  if (id === undefined) {
    id = ++twitchPlayerObjectSeq;
    twitchPlayerObjectIds.set(player, id);
  }
  return id;
}

export interface TwitchPlayerIdentity {
  streamId: string;
  cardConnected: boolean;
  parent: string | null;
  iframeId: string | null;
  iframeSrc: string | null;
  playerObjectId: number | null;
  playing: boolean;
  paused: boolean | null;
  muted: boolean;
}

export function captureTwitchPlayerIdentities(container: HTMLElement): TwitchPlayerIdentity[] {
  return [...container.querySelectorAll<HTMLElement>('.stream-card[data-platform="twitch"]')].map((card) => {
    const streamId = card.dataset.streamId ?? '';
    const iframe = card.querySelector<HTMLIFrameElement>('iframe');
    const mount = card.querySelector<HTMLElement>('.stream-card__iframe');
    const player = twitchPlayers.get(streamId);
    let paused: boolean | null = null;
    try {
      paused = player ? player.isPaused() : null;
    } catch {
      paused = null;
    }
    return {
      streamId,
      cardConnected: card.isConnected,
      parent: card.parentElement?.id ?? null,
      iframeId: iframe?.id ?? mount?.id ?? null,
      iframeSrc: iframe?.src ?? null,
      playerObjectId: twitchPlayerObjectId(player),
      playing: paused === false,
      paused,
      muted: card.dataset.embedMuted === '1',
    };
  });
}

export function diffTwitchPlayerIdentities(
  before: readonly TwitchPlayerIdentity[],
  after: readonly TwitchPlayerIdentity[],
): {
  remounts: string[];
  srcChanges: string[];
  playerObjectChanges: string[];
  newlyPaused: string[];
} {
  const afterById = new Map(after.map((entry) => [entry.streamId, entry]));
  const remounts: string[] = [];
  const srcChanges: string[] = [];
  const playerObjectChanges: string[] = [];
  const newlyPaused: string[] = [];
  for (const prev of before) {
    const next = afterById.get(prev.streamId);
    if (!next) continue;
    if (prev.iframeId !== next.iframeId) remounts.push(prev.streamId);
    if (prev.iframeSrc !== next.iframeSrc) srcChanges.push(prev.streamId);
    if (prev.playerObjectId !== next.playerObjectId) playerObjectChanges.push(prev.streamId);
    if (prev.playing && next.paused === true) newlyPaused.push(prev.streamId);
  }
  return { remounts, srcChanges, playerObjectChanges, newlyPaused };
}

/**
 * Diagnostic snapshot for app-controlled overlays (Story Card preview).
 * Logs identity + playback fields so we can tell pause-only from remount/
 * detach/reorder. Read-only — never mutates players or the grid.
 */
export function logTwitchPlayerIdentities(container: HTMLElement, phase: string): void {
  const players = captureTwitchPlayerIdentities(container);
  logPlayerEvent(phase, {
    hidden: document.hidden,
    activeElement:
      document.activeElement instanceof HTMLElement
        ? document.activeElement.id || document.activeElement.tagName
        : null,
    gridChildren: container.childElementCount,
    viewMode: container.dataset.viewMode,
    players,
  });
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
export type LayoutRecoveryCause =
  | 'add'
  | 'remove'
  | 'add-remove'
  | 'reorder'
  | 'chat'
  | 'headers'
  | 'view-mode'
  | 'story-preview';

export function beginAddRemoveRecovery(
  container: HTMLElement,
  snapshotIds: readonly string[],
  cause: LayoutRecoveryCause = 'add-remove',
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
  // Story Card preview must not remount players. play() recovery is the
  // safety fallback if an overlay still pauses a tile; a circuit-break
  // reload is the visible restart we are trying to eliminate.
  if (cause !== 'story-preview') {
    armLayoutCircuitBreaker(container, snapshotIds);
  }
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
  armLayoutCircuitBreaker(container, snapshotIds);
}

/**
 * If ≥80% of the pre-operation playing set is still paused shortly after
 * layout, remount those same cards once (the same per-card reload Refresh
 * uses). Guards: visible tab, snapshot of at least two, 12s cooldown, never
 * a single user-paused stream.
 */
const LAYOUT_CIRCUIT_RATIO = 0.8;
const LAYOUT_CIRCUIT_MIN_SNAPSHOT = 2;
const LAYOUT_CIRCUIT_DELAY_MS = 250;
const LAYOUT_CIRCUIT_COOLDOWN_MS = 12_000;
let layoutCircuitTimer = 0;
let layoutCircuitCooldownUntil = 0;

/**
 * Test-only: cancel in-flight operation recovery and the 250ms layout circuit
 * breaker so leftover timers cannot remount cards in a later test. Playback
 * recovery is a module singleton; begin() cancels prior runs but does not
 * clear the circuit timer from a previous test's container.
 */
export function __resetPlaybackRecoveryForTests(): void {
  playbackRecovery.cancel('test-reset');
  window.clearTimeout(layoutCircuitTimer);
  layoutCircuitTimer = 0;
  layoutCircuitCooldownUntil = 0;
}

function armLayoutCircuitBreaker(container: HTMLElement, snapshotIds: readonly string[]): void {
  window.clearTimeout(layoutCircuitTimer);
  layoutCircuitTimer = 0;
  if (snapshotIds.length < LAYOUT_CIRCUIT_MIN_SNAPSHOT) return;
  layoutCircuitTimer = window.setTimeout(() => {
    layoutCircuitTimer = 0;
    runLayoutCircuitBreaker(container, snapshotIds);
  }, LAYOUT_CIRCUIT_DELAY_MS);
}

function runLayoutCircuitBreaker(container: HTMLElement, snapshotIds: readonly string[]): void {
  if (document.hidden) return;
  if (Date.now() < layoutCircuitCooldownUntil) return;

  // The coordinator is still trying play() on these ids (passes at 0/750/1500/3000ms).
  // Remounting them at 250ms fights that schedule and, in tests, replaces the
  // FakeTwitchPlayer the waiter is watching so the original instance stays paused.
  const pending = new Set(playbackRecovery.pendingIds());

  const stuck: HTMLElement[] = [];
  for (const streamId of snapshotIds) {
    if (pending.has(streamId)) continue;
    const card = cardForStream(streamId);
    if (!card?.isConnected || !container.contains(card)) continue;
    if (card.dataset.platform !== 'twitch' || card.dataset.twitchMode !== 'api') continue;
    const player = twitchPlayers.get(streamId);
    if (!player) continue;
    if (checkPaused(player, streamId) === true) stuck.push(card);
  }

  if (stuck.length / snapshotIds.length < LAYOUT_CIRCUIT_RATIO) return;

  layoutCircuitCooldownUntil = Date.now() + LAYOUT_CIRCUIT_COOLDOWN_MS;
  logPlayerEvent('circuit-break', {
    paused: stuck.length,
    snapshot: snapshotIds.length,
  });
  for (const card of stuck) {
    reloadStreamCard(card);
  }
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
    if (card.dataset.streamId && isActivelyWatchedStream(card.dataset.streamId)) continue;

    const spreadMs = Number(card.dataset.recoverySpreadMs ?? '0');

    window.setTimeout(() => {
      // Re-check: card state can change during the spread delay (tab hidden,
      // focused, removed) between when the sweep started and this fires.
      if (!card.isConnected) return;
      if (card.dataset.tabFrozen === '1' || card.dataset.focusFrozen === '1') return;
      if (card.dataset.streamId && isActivelyWatchedStream(card.dataset.streamId)) return;

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
        twitchVolume.delete(id);
        twitchVolumePanelClosers.delete(id);
        twitchVolumeSyncers.delete(id);
      }
      if (card.dataset.platform === 'youtube') {
        forgetYouTubePlayer(id);
      }
      if (card.dataset.platform === 'tiktok') {
        forgetTikTokPlayer(id);
        tiktokVolume.delete(id);
        tiktokVolumePanelClosers.delete(id);
        tiktokVolumeSyncers.delete(id);
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

    // New cards only — append, never insertBefore an already-mounted card.
    // Reparenting a connected card detaches its iframe and pauses/reloads
    // Twitch/Kick/YouTube. Visual order is CSS `order` from the store index.
    if (!container.contains(card)) {
      container.append(card);
    }
    card.style.order = String(i);
  }

  container.dataset.count = String(streams.length);
  container.dataset.hasKick = streams.some((stream) => stream.platform === 'kick')
    ? '1'
    : '0';
  container.dataset.hasPortrait = streams.some((stream) => stream.orientation === 'portrait')
    ? '1'
    : '0';

  syncFocusDom(container);

  if (focusViewPrimaryId && !nextIds.has(focusViewPrimaryId)) {
    focusViewPrimaryId = streams[0]?.id ?? null;
  }
  syncFocusViewDom(container);
  syncPhoneVisiblePlayback(container);
}

type CardChrome = { header: number; borderX: number; borderY: number };

/**
 * The chrome a .stream-card actually renders, as opposed to the packer's
 * model of it.
 *
 * computeWeightedGridLayout budgets CARD_HEADER_HEIGHT (42) per row and knows
 * nothing about .stream-card's 1px border. The header really measures ~45px
 * (28px controls inside 8px padding, plus a 1px bottom rule) and the border
 * costs 2px on each axis, so a card laid out from those numbers alone is a
 * few px short vertically and 2px narrow horizontally. .stream-card__player
 * is `flex: 0 1 auto`, so it absorbed the whole shortfall and stopped being
 * 16:9 — which is exactly the app-created pillarbox on Twitch and the clipped
 * bottom of Kick's native control bar.
 *
 * Returns null before any card exists (callers fall back to the constant).
 */
function measureCardChrome(container: HTMLElement, focusedStreamId: string | null): CardChrome | null {
  const card =
    (focusedStreamId
      ? container.querySelector<HTMLElement>(`.stream-card[data-stream-id="${focusedStreamId}"]`)
      : null) ?? container.querySelector<HTMLElement>('.stream-card');
  if (!card) return null;
  // Hidden headers measure 0 (display: none), which matches the 0 chrome the
  // headers-hidden branch feeds the packer — no special-casing needed.
  const header = card.querySelector<HTMLElement>('.stream-card__header');
  return {
    header: header?.offsetHeight ?? 0,
    borderX: Math.max(0, card.offsetWidth - card.clientWidth),
    borderY: Math.max(0, card.offsetHeight - card.clientHeight),
  };
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

  if (
    (container.dataset.viewMode === 'focus' || container.dataset.viewMode === 'theater') &&
    !focusedStreamId
  ) {
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
    container.style.removeProperty('--grid-row-height');
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
    container.style.removeProperty('--grid-row-height');
    container.style.removeProperty('--player-width');
    container.style.removeProperty('--portrait-row-span');
    container.style.removeProperty('--portrait-content-width');
    container.style.removeProperty('--portrait-content-height');
    return;
  }

  const cellWidth = Math.floor(packed.cellWidth);
  const chrome = measureCardChrome(container, focusedStreamId) ?? {
    header: chromeHeight,
    borderX: 0,
    borderY: 0,
  };
  /*
   * --player-width is the grid TRACK width, and .stream-card is border-box
   * with a 1px border, so the player host only ever gets cellWidth - borderX.
   * Sizing its height from packed.cellHeight (which is 16:9 of the full
   * cellWidth) therefore made the host slightly WIDER than 16:9, and a 16:9
   * broadcast inside a wider-than-16:9 host pillarboxes itself — the
   * app-created black gutters down both sides of every Twitch embed. Deriving
   * the height from the width the player actually gets, unrounded, makes the
   * host exactly 16:9 with nothing left over to letterbox or pillarbox.
   */
  const playerWidth = Math.max(0, cellWidth - chrome.borderX);
  const playerHeight = (playerWidth * 9) / 16;
  /*
   * A header that measures 0 while chrome is expected means the DOM cannot be
   * measured yet (offsetHeight is 0 before first layout, and always 0 under
   * jsdom), not that the header is gone — headers-hidden reports chromeHeight
   * 0 and is handled by that branch instead. Falling back to the constant
   * keeps the row track from being pinned a header short, which is the very
   * failure this measurement exists to prevent.
   */
  const headerHeight = chromeHeight > 0 && chrome.header <= 0 ? chromeHeight : chrome.header;
  const cardChromeHeight = headerHeight + chrome.borderY;

  container.style.setProperty('--grid-columns', String(packed.columns));
  container.style.setProperty('--player-width', `${cellWidth}px`);
  container.style.setProperty('--player-height', `${playerHeight}px`);
  /*
   * The row track a card actually occupies: player + header + the card's own
   * top/bottom border. Only the portrait grid pins explicit rows (see
   * main.css's [data-has-portrait='1'] rule), and it used to pin them at
   * --player-height — a whole header short. Every landscape card in that grid
   * was then squeezed by the flex column: the header kept its size and the
   * player, a shrinkable flex item, absorbed the entire shortfall and stopped
   * being 16:9. Same pillarbox as above, plus it clipped the bottom of Kick's
   * CSS-scaled native control bar off the host.
   *
   * The chrome measured here (real header ~45px + 2px border) is deliberately
   * NOT fed back into computeWeightedGridLayout, which keeps budgeting
   * CARD_HEADER_HEIGHT: its inputs decide column count and card width, and
   * those must stay bit-for-bit on the Aug 13 baseline. The measurement only
   * corrects what happens INSIDE the card.
   */
  const rowHeight = Math.ceil(playerHeight + cardChromeHeight);
  container.style.setProperty('--grid-row-height', `${rowHeight}px`);
  container.style.setProperty('--portrait-row-span', String(packed.portraitRowSpan));
  if (packed.portraitContentWidth > 0 && packed.portraitContentHeight > 0) {
    /*
     * Largest 9:16 rectangle that fits the real spanned player area, recomputed
     * against the measured chrome for the same reason as above — the packer's
     * own portraitContent* are 16:9-of-cellWidth derived and inherit the
     * 42-vs-45 error.
     */
    const portraitAreaHeight =
      rowHeight * packed.portraitRowSpan +
      GRID_GAP * (packed.portraitRowSpan - 1) -
      cardChromeHeight;
    const portraitContentHeight = Math.min(portraitAreaHeight, (playerWidth * 16) / 9);
    container.style.setProperty(
      '--portrait-content-width',
      `${Math.floor((portraitContentHeight * 9) / 16)}px`,
    );
    container.style.setProperty('--portrait-content-height', `${Math.floor(portraitContentHeight)}px`);
  } else {
    container.style.removeProperty('--portrait-content-width');
    container.style.removeProperty('--portrait-content-height');
  }

  if (hasKick) {
    setKickScaleVars(container, packed.cellWidth, playerWidth);
  } else {
    container.style.removeProperty('--kick-col-min');
    container.style.removeProperty('--kick-render-width');
    container.style.removeProperty('--kick-scale');
  }
}

/**
 * Retry a zero-size Focus View layout attempt without depending solely on
 * requestAnimationFrame ever firing (see updateFocusViewLayout's own doc
 * comment on the retry branch for why rAF alone isn't reliable here). Only
 * whichever of the two fires first actually re-runs the layout.
 */
function scheduleFocusViewLayoutRetry(container: HTMLElement): void {
  if (layoutRetries >= MAX_LAYOUT_RETRIES) return;
  layoutRetries += 1;
  let fired = false;
  const retry = () => {
    if (fired) return;
    fired = true;
    updateGridLayout(container);
  };
  requestAnimationFrame(retry);
  setTimeout(retry, 50);
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
    // requestAnimationFrame alone can stall past a single mode-change retry
    // — a backgrounded tab, a throttled renderer, or (observed directly)
    // the very first paint after navigation not having run yet all leave
    // rAF unfired for an unbounded stretch. Racing it against a plain
    // setTimeout means the retry always fires within ~50ms regardless of
    // whether the browser has scheduled a frame, so a primary/tray that
    // read a zero-size stream area on the first attempt (see
    // scheduleFocusViewLayoutRetry) can't get stuck permanently collapsed.
    scheduleFocusViewLayoutRetry(container);
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

  const includeTray = container.dataset.viewMode === 'focus';
  const result = computeFocusViewLayout(areaWidth, areaHeight, primaryOrientation, {
    gap: GRID_GAP,
    chromeHeightPerRow: chromeHeight,
    includeTray,
  });

  if (result.primaryWidth <= 0 || result.primaryHeight <= 0) {
    clearFocusViewVars(container);
    return;
  }

  const trayCount = Math.max(1, totalCount - 1);
  const visibleTrayCount = Math.max(1, Math.min(trayCount, targetVisibleTrayCount(areaWidth)));

  container.style.setProperty('--grid-columns', '1');
  container.style.removeProperty('--player-height');
  container.style.removeProperty('--grid-row-height');
  container.style.removeProperty('--player-width');
  container.style.setProperty('--focus-primary-width', `${Math.floor(result.primaryWidth)}px`);
  container.style.setProperty('--focus-primary-height', `${Math.floor(result.primaryHeight)}px`);
  container.style.setProperty(
    '--focus-primary-row-height',
    `${Math.floor(result.primaryHeight + chromeHeight)}px`,
  );
  // Focus mode's primary sits in a grid track that spans every tray column
  // (including ones the tray overflows into) — centering it with justify-self
  // against that track centers it against the full scrollable content width,
  // not what's actually visible, which is exactly the "left-justified in
  // production, centered in a unit test" bug this fixes. Pinning it with
  // position:sticky + an explicit left offset computed from areaWidth (the
  // real, chat-aware scrollport width — see streamArea.clientWidth above)
  // instead keeps it centered in the VIEWPORT continuously through any
  // amount of horizontal tray scroll. See main.css's .is-focus-primary rule.
  container.style.setProperty(
    '--focus-primary-offset-left',
    `${Math.max(0, Math.floor((areaWidth - result.primaryWidth) / 2))}px`,
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

  updateFocusTrayOverflowIndicator(container);
  maybeNudgeFocusTray(container);
}

/**
 * The primary and tray share one scroll container (see .stream-grid's own
 * doc comment above the CSS rule) — data-tray-overflow drives the edge-fade
 * mask in main.css so it only ever appears on the side there's actually more
 * to scroll to, never as a static decoration.
 */
function updateFocusTrayOverflowIndicator(container: HTMLElement): void {
  const maxScroll = container.scrollWidth - container.clientWidth;
  if (maxScroll <= 1) {
    container.removeAttribute('data-tray-overflow');
    return;
  }
  const atStart = container.scrollLeft <= 1;
  const atEnd = container.scrollLeft >= maxScroll - 1;
  if (atStart && atEnd) {
    container.removeAttribute('data-tray-overflow');
  } else if (atStart) {
    container.dataset.trayOverflow = 'end';
  } else if (atEnd) {
    container.dataset.trayOverflow = 'start';
  } else {
    container.dataset.trayOverflow = 'both';
  }
}

/**
 * One-time, subtle "there's more here" nudge the first time Focus View is
 * entered with an overflowing tray — never repeats while already in Focus
 * View (gated by pendingTrayNudge, consumed here regardless of outcome) and
 * never fires under prefers-reduced-motion, per the no-continuous-auto-scroll
 * / no-annoyance / respect-reduced-motion constraints this was written to.
 */
function maybeNudgeFocusTray(container: HTMLElement): void {
  if (!pendingTrayNudge) return;
  pendingTrayNudge = false;

  if (typeof container.scrollTo !== 'function') return;
  const maxScroll = container.scrollWidth - container.clientWidth;
  if (maxScroll <= 1) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const nudgeDistance = Math.min(48, maxScroll);
  container.scrollTo({ left: nudgeDistance, behavior: 'smooth' });
  setTimeout(() => {
    container.scrollTo({ left: 0, behavior: 'smooth' });
  }, 450);
}
