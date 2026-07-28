import { bindChatPanel, bindChatToggle } from './components/ChatPanel';
import {
  bindStreamFocus,
  bindTabVisibilityPlayers,
  recoverStalledTwitchPlayers,
  recoverTwitchPlayersAfterLayout,
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
 */
const WATCHDOG_INTERVAL_MS = 90_000;
window.setInterval(() => {
  if (document.hidden || suppressLayout) return;
  recoverStalledTwitchPlayers(gridEl);
}, WATCHDOG_INTERVAL_MS);

renderStreams();
