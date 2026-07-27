import { bindChatPanel, bindChatToggle } from './components/ChatPanel';
import {
  bindStreamFocus,
  bindTabVisibilityPlayers,
  syncStreamGrid,
  updateGridLayout,
} from './components/StreamGrid';
import { bindStreamToolbar, updateEmptyState } from './components/StreamToolbar';
import { bindWelcomeModal } from './components/WelcomeModal';
import { phoneMediaQuery } from './lib/viewport';
import { createChatStore } from './state/chat';
import { createStreamStore } from './state/streams';

const store = createStreamStore();
const chatStore = createChatStore(store);
const grid = document.querySelector<HTMLElement>('#stream-grid');
const chatPanel = document.querySelector<HTMLElement>('#chat-panel');
const streamArea = document.querySelector<HTMLElement>('.stream-area');
const mainLayout = document.querySelector<HTMLElement>('.main-layout');

if (!grid || !chatPanel || !streamArea || !mainLayout) {
  throw new Error('Required layout elements not found');
}

const gridEl = grid;
const chatPanelEl = chatPanel;

function updateLayout(): void {
  // Double rAF so flex has applied chat show/hide before measuring (MultiTwitch
  // called optimize_size after show/hide synchronously on settled layout).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      updateGridLayout(gridEl);
    });
  });
}

function renderStreams(): void {
  syncStreamGrid(gridEl, store);
  updateEmptyState(store);
  updateLayout();
}

let chatSnapshotBeforeFocus: { visible: boolean; selectedId: string | null } | null = null;

bindWelcomeModal();
bindStreamToolbar(store);
bindChatToggle(chatStore);
bindChatPanel(chatPanelEl, chatStore);
bindTabVisibilityPlayers(gridEl);
bindStreamFocus((focused, streamId) => {
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
chatStore.subscribe(updateLayout);

const phoneQuery = phoneMediaQuery();

function handleViewportChange(): void {
  updateLayout();
}

window.addEventListener('resize', handleViewportChange);
phoneQuery.addEventListener('change', handleViewportChange);
window.visualViewport?.addEventListener('resize', handleViewportChange);

const resizeObserver = new ResizeObserver(() => {
  updateGridLayout(gridEl);
});
resizeObserver.observe(mainLayout);
resizeObserver.observe(streamArea);

renderStreams();
