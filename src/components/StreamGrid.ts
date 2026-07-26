import {
  clearStreamIframe,
  observeStreamCard,
  setStreamIframeSource,
  shouldLazyLoadStream,
  unobserveStreamCard,
} from '../lib/lazyIframe';
import { isStackedStreamLayout } from '../lib/viewport';
import { getAdapter, buildEmbedUrl } from '../platforms';
import type { StreamRef } from '../types';
import type { StreamStore } from '../state/streams';

function updateMuteButton(card: HTMLElement, stream: StreamRef): void {
  const muteButton = card.querySelector<HTMLButtonElement>('[data-action="mute"]');
  if (!muteButton) return;

  muteButton.title = stream.muted ? 'Unmute' : 'Mute';
  muteButton.setAttribute('aria-label', stream.muted ? 'Unmute stream' : 'Mute stream');
  muteButton.textContent = stream.muted ? 'Unmute' : 'Mute';
}

function replaceKickIframe(card: HTMLElement, stream: StreamRef): void {
  const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
  if (!iframe) return;

  const adapter = getAdapter(stream.platform);
  const next = document.createElement('iframe');
  next.className = 'stream-card__iframe';
  next.src = buildEmbedUrl(stream, stream.muted);
  next.allowFullscreen = true;
  next.title = `${adapter.label} stream: ${stream.channel}`;
  next.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
  next.setAttribute('scrolling', 'no');
  iframe.replaceWith(next);
}

function applyMuteState(card: HTMLElement, stream: StreamRef): void {
  updateMuteButton(card, stream);
  card.dataset.muted = String(stream.muted);

  if (stream.platform === 'kick') {
    replaceKickIframe(card, stream);
    return;
  }

  const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
  if (!iframe) return;
  setStreamIframeSource(iframe, stream, { autoplay: true, forceReload: true });
}

function createPlayerElement(stream: StreamRef, store: StreamStore): HTMLElement {
  const adapter = getAdapter(stream.platform);

  const card = document.createElement('article');
  card.className = `stream-card stream-card--${stream.platform}`;
  card.dataset.streamId = stream.id;
  card.dataset.platform = stream.platform;
  card.dataset.muted = String(stream.muted);

  const header = document.createElement('div');
  header.className = 'stream-card__header';

  const badge = document.createElement('span');
  badge.className = `stream-card__badge stream-card__badge--${stream.platform}`;
  badge.textContent = adapter.label;

  const title = document.createElement('span');
  title.className = 'stream-card__title';
  title.textContent = adapter.displayName(stream);

  const controls = document.createElement('div');
  controls.className = 'stream-card__controls';

  const muteButton = document.createElement('button');
  muteButton.type = 'button';
  muteButton.className = 'stream-card__btn';
  muteButton.dataset.action = 'mute';
  muteButton.addEventListener('click', () => store.toggleMute(stream.id));

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'stream-card__btn stream-card__btn--danger';
  removeButton.title = 'Remove stream';
  removeButton.setAttribute('aria-label', 'Remove stream');
  removeButton.textContent = 'Remove';
  removeButton.addEventListener('click', () => store.removeStream(stream.id));

  controls.append(muteButton, removeButton);
  header.append(badge, title, controls);

  const player = document.createElement('div');
  player.className = 'stream-card__player';

  const iframe = document.createElement('iframe');
  iframe.className = 'stream-card__iframe';
  iframe.allowFullscreen = true;
  iframe.title = `${adapter.label} stream: ${stream.channel}`;
  iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
  iframe.setAttribute('scrolling', 'no');

  // Kick: load immediately (same as the original working viewer).
  // Twitch: defer via IntersectionObserver until near the viewport.
  if (stream.platform === 'kick') {
    iframe.src = buildEmbedUrl(stream, stream.muted);
  } else {
    setStreamIframeSource(iframe, stream, { autoplay: true });
  }

  player.append(iframe);
  card.append(header, player);
  updateMuteButton(card, stream);
  return card;
}

function updatePlayerElement(card: HTMLElement, stream: StreamRef): void {
  if ((card.dataset.muted === 'true') === stream.muted) {
    return;
  }
  applyMuteState(card, stream);
}

export function syncStreamGrid(container: HTMLElement, store: StreamStore): void {
  const streams = store.getStreams();
  const nextIds = new Set(streams.map((stream) => stream.id));

  for (const card of [...container.querySelectorAll<HTMLElement>('.stream-card')]) {
    const streamId = card.dataset.streamId;
    if (!streamId || !nextIds.has(streamId)) {
      unobserveStreamCard(card);
      card.remove();
    }
  }

  for (const stream of streams) {
    const existing = container.querySelector<HTMLElement>(
      `[data-stream-id="${CSS.escape(stream.id)}"]`,
    );
    if (existing) {
      updatePlayerElement(existing, stream);
      continue;
    }

    const card = createPlayerElement(stream, store);
    container.append(card);
    if (shouldLazyLoadStream(stream)) {
      observeStreamCard(card);
    }
  }

  container.dataset.count = String(streams.length);
}

/** Simple MultiTwitch-style column counts — never maximize single-column width. */
function columnCountFor(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

export function updateGridLayout(container: HTMLElement): void {
  const count = Number(container.dataset.count ?? '0');
  if (count === 0) {
    container.style.removeProperty('--grid-columns');
    return;
  }

  const columns = isStackedStreamLayout() ? 1 : columnCountFor(count);
  container.style.setProperty('--grid-columns', String(columns));
}

export function unloadStreamGrid(container: HTMLElement): void {
  for (const card of container.querySelectorAll<HTMLElement>('.stream-card')) {
    unobserveStreamCard(card);
    const iframe = card.querySelector<HTMLIFrameElement>('.stream-card__iframe');
    if (iframe) {
      clearStreamIframe(iframe);
    }
  }
}
