import { bindChatPanel, bindChatToggle } from './components/ChatPanel';
import {
  bindStreamFocus,
  bindTabVisibilityPlayers,
  nudgeStalledTwitchPlayers,
  recoverStalledApiTwitchPlayers,
  recoverStalledFallbackTwitchPlayers,
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
 * Twitch-only, two cadences. Api-mode cards get real events
 * (PLAYBACK_BLOCKED/OFFLINE/ONLINE) plus isPaused() and a stuck-buffering
 * check, all confirm-delayed before acting — safe to run often since it
 * only ever touches a genuinely confirmed stall, so it runs every few
 * seconds instead of waiting up to 90s. Fallback-mode cards have no signal
 * at all, so that blind remount stays on the original slow 90s cadence —
 * running it as often as the api-mode check would reload a possibly-fine
 * stream constantly. Kick has neither signal nor an API-mode path — a
 * periodic blind remount there was confirmed to reset its volume back to
 * muted on every cycle far more often than it ever fixed a real stall, so
 * Kick gets no periodic watchdog at all.
 */
const API_WATCHDOG_INTERVAL_MS = 6_000;
window.setInterval(() => {
  if (document.hidden || suppressLayout) return;
  recoverStalledApiTwitchPlayers(gridEl);
}, API_WATCHDOG_INTERVAL_MS);

const FALLBACK_WATCHDOG_INTERVAL_MS = 90_000;
window.setInterval(() => {
  if (document.hidden || suppressLayout) return;
  recoverStalledFallbackTwitchPlayers(gridEl);
}, FALLBACK_WATCHDOG_INTERVAL_MS);

/**
 * A tab-resume's own play() call isn't a genuine user gesture — after a real
 * background/throttled period, browsers can silently ignore it without one.
 * The first real mouse movement or click after returning satisfies that,
 * so nudge stalled players right then instead of waiting on the next
 * api-watchdog tick. Cooldown keeps this from running on every mouse pixel —
 * kept short so it doesn't itself delay recovery: an incidental movement
 * right as a fullscreen exit settles can burn the window before players
 * are actually ready to check, and a long cooldown then makes the very
 * next deliberate movement (checking a different card) wait it out too.
 */
const INTERACTION_NUDGE_COOLDOWN_MS = 500;
let lastInteractionNudge = 0;
function nudgeOnInteraction(): void {
  const now = Date.now();
  if (now - lastInteractionNudge < INTERACTION_NUDGE_COOLDOWN_MS) return;
  lastInteractionNudge = now;
  nudgeStalledTwitchPlayers(gridEl);
}
window.addEventListener('mousemove', nudgeOnInteraction, { passive: true });
window.addEventListener('pointerdown', nudgeOnInteraction, { passive: true });

renderStreams();
