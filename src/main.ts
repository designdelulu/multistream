import { bindChatPanel, bindChatToggle } from './components/ChatPanel';
import {
  bindStreamFocus,
  bindTabVisibilityPlayers,
  nudgeStalledTwitchPlayers,
  recoverStalledTwitchPlayers,
  recoverTwitchPlayersAfterLayout,
  startStatsProbe,
  syncStreamGrid,
  updateGridLayout,
} from './components/StreamGrid';
import { bindStreamReorder } from './components/StreamReorder';
import { bindStreamToolbar, updateEmptyState } from './components/StreamToolbar';
import { bindWelcomeModal } from './components/WelcomeModal';
import { announceEmbedDebug } from './lib/embedDebug';
import { phoneMediaQuery } from './lib/viewport';
import { createChatStore } from './state/chat';
import { createHeadersStore } from './state/headers';
import { createStreamStore } from './state/streams';

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

function renderStreams(): void {
  quietLayout(2000);
  syncStreamGrid(gridEl, store);
  updateEmptyState(store);
  afterLayoutPaint(() => {
    measureAndLayout();
    // Adding/removing a stream resizes every remaining card the same way a
    // headers-toggle does — same recovery is needed here, not just there.
    recoverTwitchPlayersAfterLayout(gridEl);
  });
}

let chatSnapshotBeforeFocus: { visible: boolean; selectedId: string | null } | null = null;

bindWelcomeModal();
const toolbar = bindStreamToolbar(store, headersStore);
const reorder = bindStreamReorder(gridEl, store, headersStore);
reorder.sync();
bindChatToggle(chatStore);
bindChatPanel(chatPanelEl, chatStore);
bindTabVisibilityPlayers(gridEl);
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
chatStore.subscribe(() => {
  quietLayout(1500);
  updateLayout();
});
headersStore.subscribe(afterHeadersToggle);

const phoneQuery = phoneMediaQuery();

function handleViewportChange(): void {
  updateLayout();
}

window.addEventListener('resize', handleViewportChange);
phoneQuery.addEventListener('change', handleViewportChange);
window.visualViewport?.addEventListener('resize', handleViewportChange);

const resizeObserver = new ResizeObserver(() => {
  if (suppressLayout) return;
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
 * 30s (down from 90s): this is still the same confirm-then-escalate path in
 * verifyAndRecoverTwitchPlayer, just running more often — the only thing
 * that changes is how long a genuinely stalled card waits for its first
 * check. recoverStalledTwitchPlayers spreads each card's check over a small
 * random delay so several stalled cards can't confirm/escalate in the same
 * instant at this shorter interval.
 */
const WATCHDOG_INTERVAL_MS = 30_000;
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
  if (!document.hidden) armInteractionNudge();
});
// Exiting fullscreen has the same lost-gesture problem, and was previously
// only ever fixed by incidental mouse movement — there was no listener for it.
document.addEventListener('fullscreenchange', armInteractionNudge);
window.addEventListener('mousemove', nudgeOnInteraction, { passive: true });
window.addEventListener('pointerdown', nudgeOnInteraction, { passive: true });

renderStreams();
