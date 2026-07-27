import { buildChatEmbedUrl } from '../platforms';
import { isChatHiddenByViewport, phoneMediaQuery } from '../lib/viewport';
import type { ChatStore } from '../state/chat';
import type { StreamRef } from '../types';

interface ChatElements {
  header: HTMLElement;
  select: HTMLSelectElement;
  iframe: HTMLIFrameElement;
  message: HTMLParagraphElement;
  body: HTMLElement;
}

function streamIdsKey(streams: StreamRef[]): string {
  return streams.map((stream) => stream.id).join(',');
}

export function bindChatToggle(chatStore: ChatStore): void {
  const button = document.querySelector<HTMLButtonElement>('#chat-toggle');
  if (!button) return;

  const toggleButton = button;

  function setLabel(text: string): void {
    const label = toggleButton.querySelector<HTMLElement>('.toolbar__icon-btn-label');
    if (label) {
      label.textContent = text;
    }
    toggleButton.title = text;
    toggleButton.setAttribute('aria-label', text);
  }

  function updateButton(): void {
    const hasStreams = chatStore.hasAnyStreams();
    const onMobile = isChatHiddenByViewport();
    toggleButton.hidden = !hasStreams || onMobile;

    if (!hasStreams || onMobile) {
      return;
    }

    const visible = chatStore.isVisible();
    setLabel(visible ? 'Hide chat' : 'Show chat');
    toggleButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
  }

  toggleButton.addEventListener('click', () => {
    chatStore.toggleVisible();
  });

  chatStore.subscribe(updateButton);
  phoneMediaQuery().addEventListener('change', updateButton);
  updateButton();
}

export function bindChatPanel(container: HTMLElement, chatStore: ChatStore): void {
  let elements: ChatElements | null = null;
  let lastOptionsKey = '';
  let lastEmbedSrc = '';

  function ensureElements(): ChatElements {
    if (elements) {
      return elements;
    }

    container.replaceChildren();

    const header = document.createElement('div');
    header.className = 'chat-panel__header';

    const label = document.createElement('label');
    label.className = 'chat-panel__label';
    label.htmlFor = 'chat-select';
    label.textContent = 'Chat';

    const select = document.createElement('select');
    select.id = 'chat-select';
    select.className = 'chat-panel__select';
    select.addEventListener('change', () => {
      chatStore.setSelectedId(select.value);
    });

    header.append(label, select);

    const body = document.createElement('div');
    body.className = 'chat-panel__body';

    const message = document.createElement('p');
    message.className = 'chat-panel__message';
    message.hidden = true;

    const iframe = document.createElement('iframe');
    iframe.className = 'chat-panel__iframe';
    iframe.hidden = true;

    body.append(message, iframe);
    container.append(header, body);

    elements = { header, select, iframe, message, body };
    return elements;
  }

  function syncSelectOptions(
    select: HTMLSelectElement,
    twitchStreams: StreamRef[],
    selectedId: string | null,
  ): void {
    const optionsKey = streamIdsKey(twitchStreams);
    if (optionsKey === lastOptionsKey) {
      select.value = selectedId ?? '';
      return;
    }

    lastOptionsKey = optionsKey;
    select.replaceChildren();

    for (const stream of twitchStreams) {
      const option = document.createElement('option');
      option.value = stream.id;
      option.textContent = stream.channel;
      select.append(option);
    }

    if (selectedId) {
      select.value = selectedId;
    }
  }

  function syncChatPanel(): void {
    const hasStreams = chatStore.hasAnyStreams();
    const onMobile = isChatHiddenByViewport();
    const visible = chatStore.isVisible() && !onMobile;
    const twitchStreams = chatStore.getTwitchStreams();
    const selected = chatStore.getSelectedStream();

    container.hidden = !hasStreams || !visible;
    document.documentElement.classList.toggle('chat-open', hasStreams && visible);

    if (!hasStreams || !visible) {
      if (elements?.iframe.src) {
        elements.iframe.removeAttribute('src');
        lastEmbedSrc = '';
      }
      return;
    }

    const els = ensureElements();
    els.header.hidden = twitchStreams.length === 0;
    els.select.hidden = twitchStreams.length === 0;

    if (twitchStreams.length === 0) {
      els.message.textContent = 'Chat is only available for Twitch streams.';
      els.message.hidden = false;
      els.iframe.hidden = true;
      if (els.iframe.src) {
        els.iframe.removeAttribute('src');
        lastEmbedSrc = '';
      }
      return;
    }

    syncSelectOptions(els.select, twitchStreams, selected?.id ?? null);

    if (!selected) {
      els.message.hidden = true;
      els.iframe.hidden = true;
      return;
    }

    els.message.hidden = true;
    els.iframe.hidden = false;
    els.iframe.title = `Twitch chat: ${selected.channel}`;

    const embedSrc = buildChatEmbedUrl(selected) ?? '';
    if (embedSrc !== lastEmbedSrc) {
      els.iframe.src = embedSrc;
      lastEmbedSrc = embedSrc;
    }
  }

  chatStore.subscribe(syncChatPanel);
  syncChatPanel();
}
