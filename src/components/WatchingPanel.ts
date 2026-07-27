import { getAdapter } from '../platforms';
import { getFocusedStreamId } from './StreamGrid';
import type { HeadersStore } from '../state/headers';
import type { StreamStore } from '../state/streams';

export function bindWatchingPanel(
  panel: HTMLElement,
  list: HTMLElement,
  store: StreamStore,
  headersStore: HeadersStore,
  _grid: HTMLElement,
  onLayout?: () => void,
): { sync: () => void } {
  function sync(): void {
    const streams = store.getStreams();
    const show = headersStore.isHidden() && streams.length > 0;
    panel.hidden = !show;
    document.documentElement.classList.toggle('watching-open', show);

    list.replaceChildren();
    if (!show) {
      onLayout?.();
      return;
    }

    const focusedId = getFocusedStreamId();

    for (const stream of streams) {
      const adapter = getAdapter(stream.platform);
      const item = document.createElement('li');
      item.className = `watching-panel__item watching-panel__item--${stream.platform}`;
      item.dataset.streamId = stream.id;
      if (focusedId === stream.id) {
        item.classList.add('is-focused');
      }

      const accent = document.createElement('span');
      accent.className = 'watching-panel__accent';
      accent.setAttribute('aria-hidden', 'true');

      const name = document.createElement('span');
      name.className = 'watching-panel__name';
      name.textContent = adapter.displayName(stream);
      name.title = `Drag to reorder · ${adapter.displayName(stream)}`;

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'watching-panel__remove';
      removeButton.title = 'Remove stream';
      removeButton.setAttribute('aria-label', `Remove ${adapter.displayName(stream)}`);
      removeButton.innerHTML = '<span aria-hidden="true">×</span>';
      removeButton.addEventListener('click', () => {
        store.removeStream(stream.id);
      });

      item.append(accent, name, removeButton);
      list.append(item);
    }

    onLayout?.();
  }

  store.subscribe(sync);
  headersStore.subscribe(sync);
  sync();

  return { sync };
}
