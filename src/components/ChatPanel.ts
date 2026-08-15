import { buildChatEmbedUrl } from '../platforms';
import {
  fetchKickChat,
  kickEmoteUrl,
  shouldPollKickChat,
  tokenizeKickContent,
  type KickChatMessage,
} from '../platforms/kickChat';
import { isChatHiddenByViewport, phoneMediaQuery } from '../lib/viewport';
import type { ChatStore } from '../state/chat';
import type { StreamRef } from '../types';

interface ChatElements {
  header: HTMLElement;
  select: HTMLSelectElement;
  iframe: HTMLIFrameElement;
  message: HTMLParagraphElement;
  body: HTMLElement;
  kickFeed: HTMLElement;
  kickList: HTMLElement;
  kickEmpty: HTMLParagraphElement;
  kickComposer: HTMLElement;
}

const KICK_POLL_MS = 1500;

function streamIdsKey(streams: StreamRef[]): string {
  return streams.map((stream) => stream.id).join(',');
}

function platformLabel(platform: StreamRef['platform']): string {
  if (platform === 'kick') return 'Kick';
  if (platform === 'twitch') return 'Twitch';
  return platform;
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
    const allowed = chatStore.isToggleAllowed();
    toggleButton.hidden = !hasStreams || onMobile || !allowed;

    if (!hasStreams || onMobile || !allowed) {
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

function appendKickContent(target: HTMLElement, content: string): void {
  for (const token of tokenizeKickContent(content)) {
    if (token.type === 'text') {
      target.append(document.createTextNode(token.value));
      continue;
    }
    const src = kickEmoteUrl(token.id);
    if (!src) {
      target.append(document.createTextNode(token.name));
      continue;
    }
    const img = document.createElement('img');
    img.className = 'chat-panel__kick-emote';
    img.src = src;
    img.alt = token.name;
    img.title = token.name;
    target.append(img);
  }
}

export function renderKickChatMessage(message: KickChatMessage): HTMLElement {
  const row = document.createElement('div');
  row.className = 'chat-panel__kick-msg';
  row.dataset.messageId = message.messageId;

  if (message.repliesTo?.username) {
    const reply = document.createElement('div');
    reply.className = 'chat-panel__kick-reply';
    const excerpt = message.repliesTo.content.replace(/\s+/g, ' ').slice(0, 80);
    reply.textContent = excerpt
      ? `↪ ${message.repliesTo.username}: ${excerpt}`
      : `↪ ${message.repliesTo.username}`;
    row.append(reply);
  }

  const line = document.createElement('div');
  line.className = 'chat-panel__kick-line';

  for (const badge of message.sender.badges) {
    const pill = document.createElement('span');
    pill.className = 'chat-panel__kick-badge';
    pill.textContent = badge.count && badge.count > 1 ? `${badge.text} ×${badge.count}` : badge.text;
    line.append(pill);
  }

  const name = document.createElement('span');
  name.className = 'chat-panel__kick-user';
  name.textContent = message.sender.username;
  if (message.sender.color) name.style.color = message.sender.color;
  line.append(name);

  const body = document.createElement('span');
  body.className = 'chat-panel__kick-text';
  appendKickContent(body, message.content);
  line.append(document.createTextNode(' '), body);

  row.append(line);
  return row;
}

export function bindChatPanel(container: HTMLElement, chatStore: ChatStore): void {
  let elements: ChatElements | null = null;
  let lastOptionsKey = '';
  let lastEmbedSrc = '';
  let lastKickChannel: string | null = null;
  let lastKickMessageId: string | null = null;
  let pollTimer = 0;
  let pollInFlight: AbortController | null = null;
  let seenKickIds = new Set<string>();

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

    const kickFeed = document.createElement('div');
    kickFeed.className = 'chat-panel__kick';
    kickFeed.hidden = true;

    const kickEmpty = document.createElement('p');
    kickEmpty.className = 'chat-panel__kick-empty';
    kickEmpty.textContent = 'Waiting for new Kick chat messages…';

    const kickList = document.createElement('div');
    kickList.className = 'chat-panel__kick-list';
    kickList.setAttribute('role', 'log');
    kickList.setAttribute('aria-live', 'polite');

    // Send is not wired this pass — POST /public/v1/chat needs a user/bot
    // OAuth token, not the existing App Access Token. Kept in the DOM so a
    // later composer can mount here without reshaping the panel.
    const kickComposer = document.createElement('div');
    kickComposer.className = 'chat-panel__kick-composer';
    kickComposer.hidden = true;
    kickComposer.dataset.kickSendReady = '0';

    kickFeed.append(kickEmpty, kickList, kickComposer);
    body.append(message, iframe, kickFeed);
    container.append(header, body);

    elements = { header, select, iframe, message, body, kickFeed, kickList, kickEmpty, kickComposer };
    return elements;
  }

  function stopKickPoll(): void {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = 0;
    }
    pollInFlight?.abort();
    pollInFlight = null;
  }

  function resetKickFeed(els: ChatElements): void {
    els.kickList.replaceChildren();
    seenKickIds = new Set();
    lastKickMessageId = null;
    lastKickChannel = null;
    els.kickEmpty.hidden = false;
    els.kickEmpty.textContent = 'Waiting for new Kick chat messages…';
  }

  function appendKickMessages(els: ChatElements, messages: KickChatMessage[]): void {
    const nearBottom =
      els.kickList.scrollHeight - els.kickList.scrollTop - els.kickList.clientHeight < 48;
    for (const message of messages) {
      if (seenKickIds.has(message.messageId)) continue;
      seenKickIds.add(message.messageId);
      els.kickList.append(renderKickChatMessage(message));
      lastKickMessageId = message.messageId;
    }
    els.kickEmpty.hidden = seenKickIds.size > 0;
    if (nearBottom || seenKickIds.size <= messages.length) {
      els.kickList.scrollTop = els.kickList.scrollHeight;
    }
  }

  async function pollKick(els: ChatElements, channel: string): Promise<void> {
    if (!shouldPollKickChat({
      panelVisible: true,
      selectedPlatform: 'kick',
      pageVisible: document.visibilityState !== 'hidden',
    })) {
      return;
    }
    pollInFlight?.abort();
    const controller = new AbortController();
    pollInFlight = controller;
    try {
      const result = await fetchKickChat(channel, lastKickMessageId, controller.signal);
      if (pollInFlight !== controller) return;
      if (result.status !== 'ok') {
        if (seenKickIds.size === 0) {
          els.kickEmpty.hidden = false;
          els.kickEmpty.textContent =
            result.subscription === 'unavailable'
              ? 'Kick chat isn’t available for this channel yet.'
              : 'Waiting for new Kick chat messages…';
        }
        return;
      }
      appendKickMessages(els, result.messages);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }

  function startKickPoll(els: ChatElements, channel: string): void {
    stopKickPoll();
    void pollKick(els, channel);
    pollTimer = window.setInterval(() => {
      void pollKick(els, channel);
    }, KICK_POLL_MS);
  }

  function syncSelectOptions(
    select: HTMLSelectElement,
    streams: StreamRef[],
    selectedId: string | null,
  ): void {
    const optionsKey = streamIdsKey(streams);
    if (optionsKey === lastOptionsKey) {
      select.value = selectedId ?? '';
      return;
    }

    lastOptionsKey = optionsKey;
    select.replaceChildren();

    for (const stream of streams) {
      const option = document.createElement('option');
      option.value = stream.id;
      option.textContent = `${stream.channel} — ${platformLabel(stream.platform)}`;
      select.append(option);
    }

    if (selectedId) {
      select.value = selectedId;
    }
  }

  function hideTwitchEmbed(els: ChatElements): void {
    els.iframe.hidden = true;
    if (els.iframe.src) {
      els.iframe.removeAttribute('src');
      lastEmbedSrc = '';
    }
  }

  function syncChatPanel(): void {
    const hasStreams = chatStore.hasAnyStreams();
    const onMobile = isChatHiddenByViewport();
    const allowed = chatStore.isToggleAllowed();
    const visible = chatStore.isVisible() && !onMobile && allowed;
    const streams = chatStore.getChatStreams();
    const selected = chatStore.getSelectedStream();

    container.hidden = !hasStreams || !visible;
    document.documentElement.classList.toggle('chat-open', hasStreams && visible);

    if (!hasStreams || !visible) {
      stopKickPoll();
      if (elements?.iframe.src) {
        elements.iframe.removeAttribute('src');
        lastEmbedSrc = '';
      }
      return;
    }

    const els = ensureElements();
    els.header.hidden = streams.length === 0;
    els.select.hidden = streams.length === 0;

    if (streams.length === 0) {
      stopKickPoll();
      els.message.textContent = 'Chat is only available for Twitch and Kick streams.';
      els.message.hidden = false;
      hideTwitchEmbed(els);
      els.kickFeed.hidden = true;
      return;
    }

    syncSelectOptions(els.select, streams, selected?.id ?? null);

    if (!selected) {
      stopKickPoll();
      els.message.hidden = true;
      hideTwitchEmbed(els);
      els.kickFeed.hidden = true;
      return;
    }

    els.message.hidden = true;

    if (selected.platform === 'kick') {
      hideTwitchEmbed(els);
      els.kickFeed.hidden = false;
      if (lastKickChannel !== selected.channel) {
        resetKickFeed(els);
        lastKickChannel = selected.channel;
        startKickPoll(els, selected.channel);
      } else if (!pollTimer) {
        startKickPoll(els, selected.channel);
      }
      return;
    }

    stopKickPoll();
    els.kickFeed.hidden = true;
    els.iframe.hidden = false;
    els.iframe.title = `Twitch chat: ${selected.channel}`;

    const embedSrc = buildChatEmbedUrl(selected) ?? '';
    if (embedSrc !== lastEmbedSrc) {
      els.iframe.src = embedSrc;
      lastEmbedSrc = embedSrc;
    }
  }

  document.addEventListener('visibilitychange', () => {
    const selected = chatStore.getSelectedStream();
    if (
      document.visibilityState === 'visible' &&
      elements &&
      selected?.platform === 'kick' &&
      chatStore.isVisible()
    ) {
      startKickPoll(elements, selected.channel);
      return;
    }
    if (document.visibilityState === 'hidden') {
      stopKickPoll();
    }
  });

  chatStore.subscribe(syncChatPanel);
  syncChatPanel();
}
