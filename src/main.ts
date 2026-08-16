import { bindChatPanel, bindChatToggle } from './components/ChatPanel';
import {
  beginAddRemoveRecovery,
  beginFocusExitRecovery,
  bindFocusViewEntry,
  bindFocusViewExit,
  bindFocusViewPrimaryChanged,
  bindFocusViewPromotion,
  bindFocusViewToggle,
  bindPlaybackRecovery,
  bindStreamFocus,
  bindStreamRemoved,
  bindTabVisibilityPlayers,
  bindPhoneVisiblePlayback,
  syncPhoneVisiblePlayback,
  getFocusViewPrimaryId,
  isKickStatusRefreshInFlight,
  isTwitchStatusRefreshInFlight,
  isYouTubeStatsRefreshInFlight,
  logTwitchPlayerIdentities,
  nudgeStalledTwitchPlayers,
  recoverStalledTwitchPlayers,
  recoverTwitchPlayersAfterLayout,
  refreshAllKickStatuses,
  refreshAllTwitchStatuses,
  refreshAllYouTubeStats,
  refreshLoadedStreamPlayers,
  setFocusViewPrimary,
  snapshotPlayingTwitchPlayers,
  snapshotReorderRecoveryIds,
  captureTwitchPlayerIdentities,
  diffTwitchPlayerIdentities,
  startStatsProbe,
  syncStreamGrid,
  syncViewMode,
  updateGridLayout,
} from './components/StreamGrid';
import { bindStreamReorder } from './components/StreamReorder';
import { bindStreamToolbar, updateEmptyState } from './components/StreamToolbar';
import { bindWatchParty } from './components/WatchParty';
import { bindWelcomeModal } from './components/WelcomeModal';
import { announceEmbedDebug, logPlayerEvent, twitchStatusFastPollEnabled } from './lib/embedDebug';
import {
  createTwitchStatusScheduler,
  TWITCH_STATUS_POLL_INTERVAL_MS,
} from './lib/twitchStatusScheduler';
import {
  createYouTubeStatusScheduler,
  YOUTUBE_STATS_POLL_INTERVAL_MS,
} from './lib/youtubeStatusScheduler';
import { isPhoneViewport, phoneMediaQuery } from './lib/viewport';
import { createChatStore, isChatPlatform } from './state/chat';
import { createHeadersStore } from './state/headers';
import { createStreamStore, detectStreamListChange } from './state/streams';
import { createViewModeStore } from './state/viewMode';
import type { StreamRef } from './types';

/** Dev-only (?debug=twitch-fast-poll, gated on import.meta.env.DEV): compresses manual testing of multiple automatic cycles into a short session. Never reachable in production. */
const DEV_FAST_TWITCH_POLL_INTERVAL_MS = 15_000;

announceEmbedDebug();

const store = createStreamStore();
const chatStore = createChatStore(store);
const headersStore = createHeadersStore();
const viewModeStore = createViewModeStore();

/**
 * Phones have no Hide Headers control. Strip the class without calling
 * setHidden(false), which would persist '0' and wipe a desktop preference.
 * Restores from the store when leaving the phone breakpoint.
 */
function applyPhoneHeadersOverride(): void {
  if (typeof window.matchMedia === 'function' && isPhoneViewport()) {
    document.documentElement.classList.remove('headers-hidden');
    return;
  }
  document.documentElement.classList.toggle('headers-hidden', headersStore.isHidden());
}

applyPhoneHeadersOverride();
const grid = document.querySelector<HTMLElement>('#stream-grid');
const chatPanel = document.querySelector<HTMLElement>('#chat-panel');
const streamArea = document.querySelector<HTMLElement>('.stream-area');
const mainLayout = document.querySelector<HTMLElement>('.main-layout');

if (!grid || !chatPanel || !streamArea || !mainLayout) {
  throw new Error('Required layout elements not found');
}

const gridEl = grid;
const chatPanelEl = chatPanel;
const streamAreaEl = streamArea;
const mainLayoutEl = mainLayout;

/**
 * Quiet ResizeObserver briefly after mounts so mid-bootstrap size thrash
 * cannot stall Twitch embeds.
 *
 * Twitch refuses muted autoplay when the embed is obscured. Headers-hidden
 * mode keeps the video alone at rest; hover shrinks the player slightly and
 * reveals a toolbar below the iframe (Kick re-scales so controls stay usable).
 */
let suppressLayout = false;
let suppressLayoutTimer = 0;
let resizeDebounceTimer = 0;
/**
 * Set when the ResizeObserver below fires *while* suppressed — e.g. the
 * stream-area resizing because chat just opened/closed. Dropping that
 * notification outright (the previous behavior) left the grid stuck at its
 * pre-resize --player-width/--grid-columns indefinitely: nothing else was
 * going to size it again on its own, since ResizeObserver only notifies on
 * a genuine size change and that change had already happened once and been
 * ignored. Confirmed live: opening chat could leave a card sized for the
 * wider pre-chat area, pushed left of the grid's own (now narrower) center
 * and partly off-screen. Replaying exactly one layout pass the moment
 * suppression lifts fixes that without weakening the thrash protection
 * itself — the resize is still ignored *during* the quiet window, just not
 * lost forever.
 */
let pendingLayoutAfterSuppress = false;

function quietLayout(ms = 1500): void {
  suppressLayout = true;
  window.clearTimeout(suppressLayoutTimer);
  suppressLayoutTimer = window.setTimeout(() => {
    suppressLayoutTimer = 0;
    suppressLayout = false;
    if (pendingLayoutAfterSuppress) {
      pendingLayoutAfterSuppress = false;
      updateGridLayout(gridEl);
    }
  }, ms);
}

function measureAndLayout(): void {
  void streamAreaEl.offsetWidth;
  updateGridLayout(gridEl);
}

function updateLayout(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (suppressLayout) return;
      updateGridLayout(gridEl);
    });
  });
}

function afterLayoutPaint(fn: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(fn);
  });
}

function afterHeadersToggle(): void {
  applyPhoneHeadersOverride();
  const playingBefore = snapshotPlayingTwitchPlayers(gridEl);
  quietLayout(2500);
  reorder.sync();
  afterLayoutPaint(() => {
    measureAndLayout();
    recoverTwitchPlayersAfterLayout(gridEl);
    quietLayout(2500);
    requestAnimationFrame(() => {
      beginAddRemoveRecovery(gridEl, playingBefore, 'headers');
    });
  });
}

/**
 * Theater (unlike Focus) renders every non-primary card with `display: none`
 * (see main.css's `[data-view-mode='theater']` rule) — collapsing a live
 * Twitch embed to 0x0 makes the underlying player actually pause, not just
 * resize, and it never resumes itself once un-hidden. Nothing else recovers
 * that: recoverTwitchPlayersAfterLayout below only handles 'fallback'-mode
 * iframes, and the periodic stall watchdog (nudgeStalledTwitchPlayers) can
 * take up to ~90s to reach it, which reads as "stuck paused, needs a hard
 * refresh" (this was a real, reproducible regression — every non-primary
 * Twitch player staying paused after Theater→Grid). Snapshotting on the way
 * into Theater and replaying play() on the way out — the same pattern
 * beginFocusExitRecovery already uses for the older solo-focus feature —
 * closes that gap immediately instead of waiting on the watchdog. Entering
 * Theater (from Grid or from Focus) now also runs beginAddRemoveRecovery so
 * the still-visible primary is recovered after the resize; this snapshot is
 * only consumed on the way *out* of Theater, when hidden secondaries become
 * visible again.
 */
let theaterEntrySnapshot: { ids: string[]; startedAt: number } | null = null;

/** Switching Grid/Theater/Focus resizes every card at once, same as a headers toggle — same recovery is needed. */
function afterViewModeToggle(): void {
  const previousMode = gridEl.dataset.viewMode;
  const nextMode = viewModeStore.getMode();
  const playingBefore = snapshotPlayingTwitchPlayers(gridEl);

  if (previousMode !== 'theater' && nextMode === 'theater') {
    theaterEntrySnapshot = {
      ids: playingBefore,
      startedAt: Date.now(),
    };
  }

  syncViewMode(gridEl, nextMode, store.getStreams());
  // The SortableJS `disabled` option (StreamReorder.ts) is only re-applied
  // when sync() runs — it does not watch grid.dataset.viewMode itself — so
  // this must be called on every mode change, not just headers toggles.
  reorder.sync();
  syncPrimaryChat();
  // syncViewMode only flips data-view-mode + .is-focus-primary — the actual
  // --focus-primary-width/--focus-tray-* pixel vars that size the primary
  // and tray are computed exclusively inside updateGridLayout, which used to
  // run only via the 2x-requestAnimationFrame-deferred measureAndLayout
  // below. That left a window, between the mode attribute flipping (CSS
  // selectors match immediately) and the vars actually being set two frames
  // later, where the tray/primary CSS was active but its sizing vars were
  // still whatever the previous mode left them as (empty for grid, since
  // grid never sets them) — rendering as a collapsed, seemingly-empty tray.
  // Any main-thread delay or throttled rAF in that window (backgrounded tab,
  // heavy embed script work) stretches it from imperceptible to visible.
  // Computing layout synchronously here, immediately after the mode flips,
  // closes that window entirely; the deferred pass below still runs to
  // recover players and to re-measure once any provider embeds have
  // finished reflowing after becoming visible.
  updateGridLayout(gridEl);
  syncPhoneVisiblePlayback(gridEl);
  quietLayout(2500);
  afterLayoutPaint(() => {
    measureAndLayout();
    recoverTwitchPlayersAfterLayout(gridEl);
    quietLayout(2500);

    if (previousMode === 'theater' && nextMode !== 'theater' && theaterEntrySnapshot) {
      const snapshot = theaterEntrySnapshot;
      theaterEntrySnapshot = null;
      if (snapshot.ids.length > 0) {
        beginFocusExitRecovery(gridEl, snapshot.ids, snapshot.startedAt);
      }
      return;
    }

    requestAnimationFrame(() => {
      beginAddRemoveRecovery(gridEl, playingBefore, 'view-mode');
    });
  });
}

/**
 * Locks chat to the Theater/Focus primary, replacing the old bindStreamFocus
 * wiring below (which only ever fired for the dead solo-focus mechanism and
 * is now unreachable). Runs on every view-mode change (afterViewModeToggle)
 * and every primary promotion (bindFocusViewPrimaryChanged) so switching
 * primary mid-Focus follows the same "lock to whichever stream is now big"
 * rule as first entering Theater. Chat supports Twitch and Kick — for a
 * YouTube/TikTok primary the toggle is locked out rather than left open on
 * an unrelated chat stream that merely happens to share the grid.
 */
function syncPrimaryChat(): void {
  const primaryId = viewModeStore.getMode() !== 'grid' ? getFocusViewPrimaryId() : null;

  if (primaryId) {
    if (!chatSnapshotBeforeFocus) {
      chatSnapshotBeforeFocus = {
        visible: chatStore.isVisible(),
        selectedId: chatStore.getSelectedId(),
      };
    }
    const platform = gridEl.querySelector<HTMLElement>(
      `.stream-card[data-stream-id="${CSS.escape(primaryId)}"]`,
    )?.dataset.platform;
    chatStore.setToggleAllowed(isChatPlatform(platform));
    if (isChatPlatform(platform)) {
      chatStore.setSelectedId(primaryId);
      chatStore.setVisible(true, { persist: false });
    } else {
      chatStore.setVisible(false, { persist: false });
    }
  } else if (chatSnapshotBeforeFocus) {
    chatStore.setToggleAllowed(true);
    const snapshot = chatSnapshotBeforeFocus;
    chatSnapshotBeforeFocus = null;
    if (snapshot.selectedId) {
      chatStore.setSelectedId(snapshot.selectedId);
    }
    chatStore.setVisible(snapshot.visible, { persist: false });
  }
}

/**
 * Add/remove/reorder detection. Reorder used to be treated as a no-op here
 * so the bounded Twitch recovery pass never ran after a drag. Reorder no
 * longer reparents iframe cards, but dense-pack layout can still pause
 * api-mode players the same way an add/remove resize does. Same
 * snapshot-before-mutation rule as add/remove: only players observed
 * playing beforehand are eligible, so a user pause is left alone.
 */
let knownStreamIds: string[] = [];
/** Pre-drag snapshot — Sortable may pause Twitch before renderStreams runs. */
let reorderPlaybackSnapshot: string[] | null = null;

function takeStreamIdChange(next: string[]): 'add' | 'remove' | 'reorder' | null {
  const previous = knownStreamIds;
  knownStreamIds = next;
  return detectStreamListChange(previous, next);
}

function renderStreams(): void {
  /*
   * Snapshot before syncStreamGrid mutates cards. For a drag-reorder, the
   * playing set was captured on drag start (iframes may already have paused
   * by the time this runs). For add/remove, read live players now — a stream
   * the user had already paused is absent and can never be restarted here.
   */
  const transaction = takeStreamIdChange(store.getStreams().map((stream) => stream.id));
  const playingBefore =
    transaction === 'reorder' && reorderPlaybackSnapshot
      ? reorderPlaybackSnapshot
      : snapshotPlayingTwitchPlayers(gridEl);
  reorderPlaybackSnapshot = null;

  quietLayout(2000);
  syncStreamGrid(gridEl, store);
  syncViewMode(gridEl, viewModeStore.getMode(), store.getStreams());
  updateEmptyState(store);
  afterLayoutPaint(() => {
    measureAndLayout();
    // Adding/removing a stream resizes every remaining card the same way a
    // headers-toggle does — same recovery is needed here, not just there.
    recoverTwitchPlayersAfterLayout(gridEl);

    if (!transaction) return;
    /*
     * measureAndLayout only *writes* the new --player-width/--player-height.
     * One more frame lets the browser apply them, so every surviving iframe
     * has its final box before the first check — that resize is what Twitch
     * reacts to, and reacting to it is exactly what we are waiting on.
     */
    requestAnimationFrame(() => {
      beginAddRemoveRecovery(gridEl, playingBefore, transaction);
    });
  });
}

let chatSnapshotBeforeFocus: { visible: boolean; selectedId: string | null } | null = null;

/**
 * Shared Twitch status scheduler — one for the whole app, armed only while at
 * least one Twitch card exists (see syncTwitchStatusScheduler below) and
 * paused while the tab is hidden or offline. Never touches players/iframes:
 * `run` only calls refreshAllTwitchStatuses, which in turn only updates
 * status dots/metadata — see StreamGrid.ts's applyTwitchStatus doc comment.
 */
const twitchStatusScheduler = createTwitchStatusScheduler({
  intervalMs: twitchStatusFastPollEnabled
    ? DEV_FAST_TWITCH_POLL_INTERVAL_MS
    : TWITCH_STATUS_POLL_INTERVAL_MS,
  hasTwitchCards: () => store.getStreams().some((stream) => stream.platform === 'twitch'),
  isHidden: () => document.hidden,
  isOnline: () => navigator.onLine,
  run: (reason) => refreshAllTwitchStatuses(store, reason).then((result) => result.outcome),
  now: () => Date.now(),
  setInterval: (handler, ms) => window.setInterval(handler, ms),
  clearInterval: (handle) => window.clearInterval(handle),
});

function syncTwitchStatusScheduler(): void {
  const hasTwitchCards = store.getStreams().some((stream) => stream.platform === 'twitch');
  if (hasTwitchCards) {
    twitchStatusScheduler.start();
  } else {
    twitchStatusScheduler.stop();
  }
}

/**
 * Shared YouTube stats scheduler — mirrors twitchStatusScheduler above,
 * armed only while at least one YouTube card exists. `run` only calls
 * refreshAllYouTubeStats, which only updates the header meta span — see
 * StreamGrid.ts's applyYouTubeStats doc comment.
 */
const youtubeStatusScheduler = createYouTubeStatusScheduler({
  intervalMs: YOUTUBE_STATS_POLL_INTERVAL_MS,
  hasYouTubeCards: () => store.getStreams().some((stream) => stream.platform === 'youtube'),
  isHidden: () => document.hidden,
  isOnline: () => navigator.onLine,
  run: (reason) => refreshAllYouTubeStats(gridEl, reason).then((result) => result.outcome),
  now: () => Date.now(),
  setInterval: (handler, ms) => window.setInterval(handler, ms),
  clearInterval: (handle) => window.clearInterval(handle),
});

function syncYouTubeStatusScheduler(): void {
  const hasYouTubeCards = store.getStreams().some((stream) => stream.platform === 'youtube');
  if (hasYouTubeCards) {
    youtubeStatusScheduler.start();
  } else {
    youtubeStatusScheduler.stop();
  }
}

/**
 * Shared Kick status scheduler — same shape and same guarantees as the two
 * above. `run` only calls refreshAllKickStatuses, which updates the status
 * dot / header meta / avatar dataset and nothing else; it never remounts or
 * reloads a Kick iframe. That distinction is the whole reason Kick can now
 * be polled at all: the disruptive thing this app deliberately stopped doing
 * on a timer (see manualRefreshAll's doc comment below, and
 * reloadKickPlayer's) is reloading the *player*, which this does not touch.
 */
const kickStatusScheduler = createTwitchStatusScheduler({
  intervalMs: TWITCH_STATUS_POLL_INTERVAL_MS,
  hasTwitchCards: () => store.getStreams().some((stream) => stream.platform === 'kick'),
  isHidden: () => document.hidden,
  isOnline: () => navigator.onLine,
  run: (reason) => refreshAllKickStatuses(store, reason).then((result) => result.outcome),
  now: () => Date.now(),
  setInterval: (handler, ms) => window.setInterval(handler, ms),
  clearInterval: (handle) => window.clearInterval(handle),
});

function syncKickStatusScheduler(): void {
  const hasKickCards = store.getStreams().some((stream) => stream.platform === 'kick');
  if (hasKickCards) {
    kickStatusScheduler.start();
  } else {
    kickStatusScheduler.stop();
  }
}

/** Kick's counterpart to manualTwitchStatusRefresh — metadata only, never a player reload. */
async function manualKickStatusRefresh(): Promise<Awaited<ReturnType<typeof refreshAllKickStatuses>>> {
  const result = await refreshAllKickStatuses(store, 'manual');
  if (result.outcome === 'ok') kickStatusScheduler.notifyManualRefresh();
  return result;
}

/** The manual "Refresh Twitch statuses" action — resets the periodic clock only on success, per the scheduler's own contract. */
async function manualTwitchStatusRefresh(): Promise<Awaited<ReturnType<typeof refreshAllTwitchStatuses>>> {
  const result = await refreshAllTwitchStatuses(store, 'manual');
  if (result.outcome === 'ok') twitchStatusScheduler.notifyManualRefresh();
  return result;
}

/**
 * YouTube's equivalent of manualTwitchStatusRefresh above — same
 * non-disruptive, stats-only contract. Unlike the Twitch scheduler,
 * youtubeStatusScheduler never had a manual-refresh clock reset (no prior
 * manual trigger existed for it before this global Refresh button), so there
 * is nothing to notify — its periodic interval is simply left running as-is.
 */
async function manualYouTubeStatsRefresh(): Promise<Awaited<ReturnType<typeof refreshAllYouTubeStats>>> {
  return refreshAllYouTubeStats(gridEl, 'manual');
}

/**
 * The global toolbar "Refresh" action. This is an explicit user request, so
 * it is allowed to be more forceful than automatic recovery: it first
 * recovers/reloads currently loaded players (see refreshLoadedStreamPlayers),
 * then refreshes Twitch/YouTube/Kick metadata. It never reloads the page,
 * never changes the lineup, and never resets Grid order.
 *
 * Automatic/timer paths still must not call Kick's player reload — that
 * stays restricted to this button and the per-card reload control
 * (see reloadKickPlayer: a periodic remount reset volume to muted).
 */
async function manualRefreshAll(): Promise<{
  outcome: 'ok' | 'skipped-empty';
  twitchAllUnavailable: boolean;
}> {
  if (store.getStreams().length === 0) {
    return { outcome: 'skipped-empty', twitchAllUnavailable: false };
  }

  refreshLoadedStreamPlayers(gridEl);

  const [twitchResult] = await Promise.all([
    manualTwitchStatusRefresh(),
    manualYouTubeStatsRefresh(),
    manualKickStatusRefresh(),
  ]);

  const twitchAllUnavailable =
    twitchResult.outcome === 'ok' &&
    twitchResult.results.size > 0 &&
    [...twitchResult.results.values()].every((entry) => entry.status === 'unavailable');

  return { outcome: 'ok', twitchAllUnavailable };
}

function isAnyRefreshInFlight(): boolean {
  return (
    isTwitchStatusRefreshInFlight() ||
    isYouTubeStatsRefreshInFlight() ||
    isKickStatusRefreshInFlight()
  );
}

bindWelcomeModal();
let storyPreviewPlaybackSnapshot: string[] = [];
let storyPreviewIdentitiesBefore: ReturnType<typeof captureTwitchPlayerIdentities> = [];

function recoverAfterStoryPreview(): void {
  afterLayoutPaint(() => {
    requestAnimationFrame(() => {
      beginAddRemoveRecovery(gridEl, storyPreviewPlaybackSnapshot, 'story-preview');
    });
  });
}

const watchParty = bindWatchParty(store);

const toolbar = bindStreamToolbar(
  store,
  headersStore,
  viewModeStore,
  {
    refresh: manualRefreshAll,
    isRefreshInFlight: isAnyRefreshInFlight,
  },
  {
    onWillOpen: () => {
      storyPreviewPlaybackSnapshot = snapshotPlayingTwitchPlayers(gridEl);
      storyPreviewIdentitiesBefore = captureTwitchPlayerIdentities(gridEl);
      logTwitchPlayerIdentities(gridEl, 'story-preview-before-open');
    },
    onDidOpen: () => {
      const after = captureTwitchPlayerIdentities(gridEl);
      logTwitchPlayerIdentities(gridEl, 'story-preview-after-open');
      const openDiff = diffTwitchPlayerIdentities(storyPreviewIdentitiesBefore, after);
      logPlayerEvent('story-preview-open-diff', {
        remounts: openDiff.remounts,
        srcChanges: openDiff.srcChanges,
        playerObjectChanges: openDiff.playerObjectChanges,
        newlyPaused: openDiff.newlyPaused,
      });
      recoverAfterStoryPreview();
    },
    onWillClose: () => {
      const live = snapshotPlayingTwitchPlayers(gridEl);
      storyPreviewPlaybackSnapshot = [...new Set([...storyPreviewPlaybackSnapshot, ...live])];
      logTwitchPlayerIdentities(gridEl, 'story-preview-before-close');
    },
    onDidClose: () => {
      const after = captureTwitchPlayerIdentities(gridEl);
      logTwitchPlayerIdentities(gridEl, 'story-preview-after-close');
      const closeDiff = diffTwitchPlayerIdentities(storyPreviewIdentitiesBefore, after);
      logPlayerEvent('story-preview-close-diff', {
        remounts: closeDiff.remounts,
        srcChanges: closeDiff.srcChanges,
        playerObjectChanges: closeDiff.playerObjectChanges,
        newlyPaused: closeDiff.newlyPaused,
      });
      recoverAfterStoryPreview();
    },
  },
  watchParty,
);
const reorder = bindStreamReorder(gridEl, store, headersStore, {
  onDragChoose: () => {
    reorderPlaybackSnapshot = snapshotReorderRecoveryIds(gridEl);
  },
  onDragStart: () => {
    const extra = snapshotReorderRecoveryIds(gridEl);
    reorderPlaybackSnapshot = [...new Set([...(reorderPlaybackSnapshot ?? []), ...extra])];
  },
});
reorder.sync();
watchParty.subscribe(() => {
  reorder.sync();
});
bindChatToggle(chatStore);
bindChatPanel(chatPanelEl, chatStore);
bindTabVisibilityPlayers(gridEl);
bindPhoneVisiblePlayback(gridEl);
bindPlaybackRecovery();
bindFocusViewPromotion(gridEl);
/*
 * Theater's only entry point: a card's own Focus control (see
 * bindFocusViewEntry's own doc comment in StreamGrid.ts). setFocusViewPrimary
 * runs first and synchronously — it only touches module state, a CSS class,
 * and (harmlessly, since the grid is still in 'grid' mode at this instant) a
 * layout recompute — so by the time viewModeStore.setMode('theater') fires
 * afterViewModeToggle -> syncViewMode, focusViewPrimaryId already matches
 * this exact stream and its own streams[0] fallback never engages. No
 * intermediate frame ever shows the wrong primary. Focus (the tray) is never
 * a restart point — it's only reached from within Theater via the toggle
 * below, per viewMode.ts's own toggle() doc comment.
 */
bindFocusViewEntry((streamId) => {
  setFocusViewPrimary(gridEl, streamId);
  viewModeStore.setMode('theater');
});

// Primary's own X: exit Theater/Focus back to Grid, same primary preserved
// in module state (setFocusViewPrimary is untouched) in case of re-entry.
bindFocusViewExit(() => {
  viewModeStore.setMode('grid');
});

// The primary card's own Focus control, repurposed in Theater/Focus as the
// tray on/off toggle (see syncFocusButtonLabel in StreamGrid.ts) — same
// primary throughout, only the tray's visibility (CSS) changes.
bindFocusViewToggle(() => {
  viewModeStore.setMode(viewModeStore.getMode() === 'theater' ? 'focus' : 'theater');
});

// Promoting a different tray stream to primary follows the same chat-lock
// rule as first entering Theater.
bindFocusViewPrimaryChanged(syncPrimaryChat);

// Dead: only ever fired for the old solo-focus mechanism, which nothing
// sets anymore (see setFocusedStream's callers) — chat-lock for the live
// Theater/Focus system is syncPrimaryChat above. Left in place rather than
// removed since deleting it is a larger, out-of-scope refactor of the old
// solo-focus machinery it's paired with.
bindStreamFocus((focused, streamId) => {
  toolbar.sync();
  reorder.sync();

  if (focused && streamId) {
    if (!chatSnapshotBeforeFocus) {
      chatSnapshotBeforeFocus = {
        visible: chatStore.isVisible(),
        selectedId: chatStore.getSelectedId(),
      };
    }

    const platform = gridEl.querySelector<HTMLElement>(
      `.stream-card[data-stream-id="${CSS.escape(streamId)}"]`,
    )?.dataset.platform;

    // Chat supports Twitch and Kick. While focused on a YouTube/TikTok
    // stream, the toggle would otherwise still open a dropdown of whatever
    // other chat streams happen to be in the grid, unrelated to what's on
    // screen. Lock it out entirely for the duration of that focus session.
    chatStore.setToggleAllowed(isChatPlatform(platform));
    if (isChatPlatform(platform)) {
      chatStore.setSelectedId(streamId);
      chatStore.setVisible(true, { persist: false });
    } else {
      chatStore.setVisible(false, { persist: false });
    }
  } else if (!focused) {
    chatStore.setToggleAllowed(true);
    if (chatSnapshotBeforeFocus) {
      const snapshot = chatSnapshotBeforeFocus;
      chatSnapshotBeforeFocus = null;
      if (snapshot.selectedId) {
        chatStore.setSelectedId(snapshot.selectedId);
      }
      chatStore.setVisible(snapshot.visible, { persist: false });
    }
  }

  updateLayout();
});

/*
 * One simple undo level: removing a stream (any of its X buttons, Grid or
 * Focus View) offers ~8s to bring it back at its previous position. store
 * .insertStream re-adds the plain StreamRef data at a clamped index — a
 * fresh player mounts for it exactly like any other addition (see
 * syncStreamGrid's diffing), never the old, possibly-torn-down player
 * object. Only one pending removal is tracked at a time: a second removal
 * before the toast is actioned replaces it, matching the "one simple undo
 * level" scope this was built to.
 */
const UNDO_TOAST_DURATION_MS = 8000;
const undoToastEl = document.querySelector<HTMLElement>('#undo-toast');
const undoToastMessageEl = undoToastEl?.querySelector<HTMLElement>('.undo-toast__message') ?? null;
const undoToastActionEl = undoToastEl?.querySelector<HTMLButtonElement>('.undo-toast__action') ?? null;
let undoToastHideTimer = 0;
let pendingUndo: { stream: StreamRef; index: number } | null = null;

function hideUndoToast(): void {
  if (!undoToastEl) return;
  window.clearTimeout(undoToastHideTimer);
  undoToastHideTimer = 0;
  undoToastEl.hidden = true;
  pendingUndo = null;
}

function showUndoToast(stream: StreamRef, index: number): void {
  if (!undoToastEl || !undoToastMessageEl) return;
  pendingUndo = { stream, index };
  undoToastMessageEl.textContent = 'Stream removed';
  undoToastEl.hidden = false;
  window.clearTimeout(undoToastHideTimer);
  undoToastHideTimer = window.setTimeout(hideUndoToast, UNDO_TOAST_DURATION_MS);
}

undoToastActionEl?.addEventListener('click', () => {
  if (!pendingUndo) return;
  const { stream, index } = pendingUndo;
  store.insertStream(stream, index);
  hideUndoToast();
});

bindStreamRemoved((removed, index) => {
  showUndoToast(removed, index);
});

store.subscribe(renderStreams);
store.subscribe(syncTwitchStatusScheduler);
store.subscribe(syncYouTubeStatusScheduler);
store.subscribe(syncKickStatusScheduler);
chatStore.subscribe(() => {
  const playingBefore = snapshotPlayingTwitchPlayers(gridEl);
  quietLayout(1500);
  afterLayoutPaint(() => {
    measureAndLayout();
    recoverTwitchPlayersAfterLayout(gridEl);
    requestAnimationFrame(() => {
      beginAddRemoveRecovery(gridEl, playingBefore, 'chat');
    });
  });
});
headersStore.subscribe(afterHeadersToggle);
viewModeStore.subscribe(afterViewModeToggle);

const phoneQuery = phoneMediaQuery();

function handleViewportChange(): void {
  applyPhoneHeadersOverride();
  if (typeof window.matchMedia === 'function' && isPhoneViewport() && viewModeStore.getMode() !== 'grid') {
    viewModeStore.setMode('grid');
  }
  reorder.sync();
  toolbar.sync();
  updateLayout();
  syncPhoneVisiblePlayback(gridEl);
  armInteractionNudge();
}

window.addEventListener('resize', handleViewportChange);
phoneQuery.addEventListener('change', handleViewportChange);
window.visualViewport?.addEventListener('resize', handleViewportChange);

const resizeObserver = new ResizeObserver(() => {
  if (suppressLayout) {
    pendingLayoutAfterSuppress = true;
    return;
  }
  armInteractionNudge();
  window.clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = window.setTimeout(() => {
    resizeDebounceTimer = 0;
    if (suppressLayout) return;
    updateGridLayout(gridEl);
  }, 120);
});
resizeObserver.observe(mainLayoutEl);
resizeObserver.observe(streamAreaEl);

/**
 * Twitch-only: real events (PLAYBACK_BLOCKED/OFFLINE/ONLINE) and
 * isPaused() give api-mode cards a verified stall to act on; fallback-mode
 * cards still get a blind remount since that's the only signal available.
 * Kick has neither signal nor an API-mode path — a periodic blind remount
 * here was confirmed to reset its volume back to muted on every cycle
 * (no way to read back a live in-player unmute) far more often than it
 * ever fixed a real stall, so Kick gets no periodic watchdog at all.
 *
 * Tried 30s (down from 90s) to reduce the stuck-until-hover wait — reverted.
 * verifyAndRecoverTwitchPlayer escalates to a full setChannel() reconnect
 * after 2 consecutive confirmed stalls, so shortening the interval also
 * shortens that escalation's grace period (90-180s of continuous stall
 * before reconnecting, down to just 30-60s at the faster cadence). With
 * many streams open, ordinary bandwidth-contention buffering can outlast
 * that shorter window on its own, so streams that would've quietly
 * recovered got forced into a disruptive reconnect instead — confirmed live,
 * more streams stuck than at 90s, some unrecoverable by a gentle hover-nudge
 * mid-reconnect. Back to 90s; recoverStalledTwitchPlayers' per-card stagger
 * stays (harmless regardless of interval, still useful if this is revisited).
 */
const WATCHDOG_INTERVAL_MS = 90_000;
window.setInterval(() => {
  if (document.hidden || suppressLayout) return;
  recoverStalledTwitchPlayers(gridEl);
}, WATCHDOG_INTERVAL_MS);

// Phase C2 diagnostic probe — no-ops unless ?debug=stats is active.
startStatsProbe(gridEl);

/**
 * A tab-resume's (or fullscreen-exit's) own play() call isn't a genuine user
 * gesture — after a real background/throttled period, browsers can silently
 * ignore it without one. The first real mouse movement or click afterward
 * satisfies that, so nudge stalled players right then instead of waiting on
 * the next watchdog tick.
 *
 * Window/container resize has the same problem from a different cause:
 * shrinking the browser window can drop a cell below Twitch's own minimum
 * autoplay size, and Twitch can pause the embed on its own in response —
 * confirmed live (many streams paused after a resize, only some recovering
 * on their own; the rest sat until the next 90s watchdog tick). Arming here
 * too means the next mouse movement — which reliably follows a manual resize
 * — recovers them immediately instead.
 *
 * That rationale only holds in the window right after such an event. Left
 * ungated, this listener is a permanent grid-wide play() generator firing up
 * to twice a second during ordinary mouse use — and play() makes Twitch flash
 * its loading overlay, on every card the sweep touches, at once. That is the
 * likeliest source of the reported "overlay flashes on several streams
 * together, video keeps playing". So: arm only on the events that actually
 * need a user gesture, and stay dormant otherwise.
 */
const NUDGE_ARM_WINDOW_MS = 30_000;
const INTERACTION_NUDGE_COOLDOWN_MS = 500;
let nudgeArmedUntil = 0;
let lastInteractionNudge = 0;

function armInteractionNudge(): void {
  nudgeArmedUntil = Date.now() + NUDGE_ARM_WINDOW_MS;
}

function nudgeOnInteraction(): void {
  const now = Date.now();
  if (now >= nudgeArmedUntil) return;
  if (now - lastInteractionNudge < INTERACTION_NUDGE_COOLDOWN_MS) return;
  lastInteractionNudge = now;
  nudgeStalledTwitchPlayers(gridEl);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    armInteractionNudge();
    // Refresh once only if the previous check is older than the normal
    // interval — never a burst on every tab-foreground.
    twitchStatusScheduler.notifyVisible();
    youtubeStatusScheduler.notifyVisible();
    kickStatusScheduler.notifyVisible();
  }
});
window.addEventListener('online', () => {
  twitchStatusScheduler.notifyVisible();
  youtubeStatusScheduler.notifyVisible();
  kickStatusScheduler.notifyVisible();
});
// Exiting fullscreen has the same lost-gesture problem, and was previously
// only ever fixed by incidental mouse movement — there was no listener for it.
document.addEventListener('fullscreenchange', armInteractionNudge);
window.addEventListener('mousemove', nudgeOnInteraction, { passive: true });
window.addEventListener('pointerdown', nudgeOnInteraction, { passive: true });

renderStreams();
// renderStreams -> syncViewMode is what sets gridEl.dataset.viewMode for the
// very first time (it's still undefined at the reorder.sync() call above,
// since bindStreamReorder runs before the first renderStreams). Without this,
// isPrimaryModeActive() reads 'undefined !== grid' as true on that initial
// sync, leaving SortableJS permanently disabled — no drag ever starts, in
// either headers-visible or headers-hidden Grid — until the user happens to
// toggle Theater/Focus at least once, which is the only other place that
// calls reorder.sync().
reorder.sync();

// One batched advisory status check for every Twitch channel restored from
// the URL/localStorage at startup — never one request per tile. Streams
// added later go through StreamToolbar's own single-channel check instead.
void refreshAllTwitchStatuses(store, 'initial-restore');
syncTwitchStatusScheduler();

// Same for Kick, and for the same reason — its metadata check is fully
// decoupled from the iframe mount, so this can run at restore without
// touching a single player.
void refreshAllKickStatuses(store, 'initial-restore');
syncKickStatusScheduler();

// YouTube has no equivalent initial-restore call: unlike Twitch's advisory
// status check (decoupled from player mount), each YouTube card's own mount
// path already fires a one-off stats fetch for its first paint — see
// resolveAndMountYouTubeChannel/mountYouTubeMedia in StreamGrid.ts. Just arm
// the periodic scheduler for whatever YouTube cards restored from the URL.
syncYouTubeStatusScheduler();
