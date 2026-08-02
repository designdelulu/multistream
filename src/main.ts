import { bindChatPanel, bindChatToggle } from './components/ChatPanel';
import {
  beginAddRemoveRecovery,
  bindPlaybackRecovery,
  bindStreamFocus,
  bindTabVisibilityPlayers,
  isTwitchStatusRefreshInFlight,
  nudgeStalledTwitchPlayers,
  recoverStalledTwitchPlayers,
  recoverTwitchPlayersAfterLayout,
  refreshAllTwitchStatuses,
  snapshotPlayingTwitchPlayers,
  startStatsProbe,
  syncStreamGrid,
  updateGridLayout,
} from './components/StreamGrid';
import { bindStreamReorder } from './components/StreamReorder';
import { bindStreamToolbar, updateEmptyState } from './components/StreamToolbar';
import { bindWelcomeModal } from './components/WelcomeModal';
import { announceEmbedDebug, twitchStatusFastPollEnabled } from './lib/embedDebug';
import {
  createTwitchStatusScheduler,
  TWITCH_STATUS_POLL_INTERVAL_MS,
} from './lib/twitchStatusScheduler';
import { phoneMediaQuery } from './lib/viewport';
import { createChatStore } from './state/chat';
import { createHeadersStore } from './state/headers';
import { createStreamStore } from './state/streams';

/** Dev-only (?debug=twitch-fast-poll, gated on import.meta.env.DEV): compresses manual testing of multiple automatic cycles into a short session. Never reachable in production. */
const DEV_FAST_TWITCH_POLL_INTERVAL_MS = 15_000;

announceEmbedDebug();

const store = createStreamStore();
const chatStore = createChatStore(store);
const headersStore = createHeadersStore();
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

function quietLayout(ms = 1500): void {
  suppressLayout = true;
  window.clearTimeout(suppressLayoutTimer);
  suppressLayoutTimer = window.setTimeout(() => {
    suppressLayoutTimer = 0;
    suppressLayout = false;
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
  quietLayout(2500);
  reorder.sync();
  afterLayoutPaint(() => {
    measureAndLayout();
    recoverTwitchPlayersAfterLayout(gridEl);
    quietLayout(2500);
  });
}

/**
 * Add/remove detection. The store notifies on reorder too, and a reorder is a
 * different problem with a different fix — this recovery path is deliberately
 * scoped to transactions that change *which* streams exist, per the constraint
 * that it must not run on every layout event.
 */
let knownStreamIds: string[] = [];

function takeStreamIdChange(next: string[]): 'add' | 'remove' | null {
  const previous = knownStreamIds;
  knownStreamIds = next;

  const previousSet = new Set(previous);
  const added = next.filter((id) => !previousSet.has(id)).length;
  const nextSet = new Set(next);
  const removed = previous.filter((id) => !nextSet.has(id)).length;

  if (added === 0 && removed === 0) return null;
  return added >= removed ? 'add' : 'remove';
}

function renderStreams(): void {
  /*
   * Snapshot first: this must read the live players BEFORE syncStreamGrid
   * destroys any of them, because "was this playing beforehand?" is the only
   * thing that authorises a later play() call. A stream the user had paused
   * is simply absent here and can never be restarted by the recovery path.
   */
  const playingBefore = snapshotPlayingTwitchPlayers(gridEl);
  const transaction = takeStreamIdChange(store.getStreams().map((stream) => stream.id));

  quietLayout(2000);
  syncStreamGrid(gridEl, store);
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

/** The manual "Refresh Twitch statuses" action — resets the periodic clock only on success, per the scheduler's own contract. */
async function manualTwitchStatusRefresh(): Promise<Awaited<ReturnType<typeof refreshAllTwitchStatuses>>> {
  const result = await refreshAllTwitchStatuses(store, 'manual');
  if (result.outcome === 'ok') twitchStatusScheduler.notifyManualRefresh();
  return result;
}

bindWelcomeModal();
const toolbar = bindStreamToolbar(store, headersStore, {
  refresh: manualTwitchStatusRefresh,
  isRefreshInFlight: isTwitchStatusRefreshInFlight,
});
const reorder = bindStreamReorder(gridEl, store, headersStore);
reorder.sync();
bindChatToggle(chatStore);
bindChatPanel(chatPanelEl, chatStore);
bindTabVisibilityPlayers(gridEl);
bindPlaybackRecovery();
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

    if (platform === 'twitch') {
      chatStore.setSelectedId(streamId);
      chatStore.setVisible(true, { persist: false });
    } else {
      chatStore.setVisible(false, { persist: false });
    }
  } else if (!focused && chatSnapshotBeforeFocus) {
    const snapshot = chatSnapshotBeforeFocus;
    chatSnapshotBeforeFocus = null;
    if (snapshot.selectedId) {
      chatStore.setSelectedId(snapshot.selectedId);
    }
    chatStore.setVisible(snapshot.visible, { persist: false });
  }

  updateLayout();
});
store.subscribe(renderStreams);
store.subscribe(syncTwitchStatusScheduler);
chatStore.subscribe(() => {
  quietLayout(1500);
  updateLayout();
});
headersStore.subscribe(afterHeadersToggle);

const phoneQuery = phoneMediaQuery();

function handleViewportChange(): void {
  updateLayout();
  armInteractionNudge();
}

window.addEventListener('resize', handleViewportChange);
phoneQuery.addEventListener('change', handleViewportChange);
window.visualViewport?.addEventListener('resize', handleViewportChange);

const resizeObserver = new ResizeObserver(() => {
  if (suppressLayout) return;
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
  }
});
window.addEventListener('online', () => twitchStatusScheduler.notifyVisible());
// Exiting fullscreen has the same lost-gesture problem, and was previously
// only ever fixed by incidental mouse movement — there was no listener for it.
document.addEventListener('fullscreenchange', armInteractionNudge);
window.addEventListener('mousemove', nudgeOnInteraction, { passive: true });
window.addEventListener('pointerdown', nudgeOnInteraction, { passive: true });

renderStreams();

// One batched advisory status check for every Twitch channel restored from
// the URL/localStorage at startup — never one request per tile. Streams
// added later go through StreamToolbar's own single-channel check instead.
void refreshAllTwitchStatuses(store, 'initial-restore');
syncTwitchStatusScheduler();
