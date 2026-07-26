import { bindChatPanel, bindChatToggle } from './components/ChatPanel';
import { syncStreamGrid, updateGridLayout } from './components/StreamGrid';
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

bindWelcomeModal();
bindStreamToolbar(store);
bindChatToggle(chatStore);
bindChatPanel(chatPanelEl, chatStore);
store.subscribe(renderStreams);
chatStore.subscribe(updateLayout);

const phoneQuery = phoneMediaQuery();

function handleViewportChange(): void {
  updateLayout();
}

window.addEventListener('resize', handleViewportChange);
phoneQuery.addEventListener('change', handleViewportChange);

const resizeObserver = new ResizeObserver(() => {
  updateGridLayout(gridEl);
});
resizeObserver.observe(mainLayout);
resizeObserver.observe(streamArea);

renderStreams();
