import { buildEmbedUrl, getAdapter } from '../platforms';
import type { StreamRef } from '../types';
import type { StreamStore } from '../state/streams';

function createPlayerElement(stream: StreamRef, store: StreamStore): HTMLElement {
  const adapter = getAdapter(stream.platform);

  const card = document.createElement('article');
  card.className = 'stream-card';
  card.dataset.streamId = stream.id;

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
  muteButton.title = stream.muted ? 'Unmute' : 'Mute';
  muteButton.setAttribute('aria-label', stream.muted ? 'Unmute stream' : 'Mute stream');
  muteButton.textContent = stream.muted ? 'Unmute' : 'Mute';
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
  iframe.src = buildEmbedUrl(stream, stream.muted);
  iframe.allowFullscreen = true;
  iframe.title = `${adapter.label} stream: ${stream.channel}`;
  iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');

  player.append(iframe);
  card.append(header, player);
  return card;
}

export function renderStreamGrid(
  container: HTMLElement,
  store: StreamStore,
): void {
  const streams = store.getStreams();
  container.replaceChildren();

  for (const stream of streams) {
    container.append(createPlayerElement(stream, store));
  }

  container.dataset.count = String(streams.length);
}

export function updateGridColumns(container: HTMLElement): void {
  const count = Number(container.dataset.count ?? '0');
  if (count === 0) {
    container.style.removeProperty('--grid-columns');
    return;
  }

  const isMobile = window.matchMedia('(max-width: 900px)').matches;
  const columns = isMobile ? 1 : count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
  container.style.setProperty('--grid-columns', String(columns));
}
