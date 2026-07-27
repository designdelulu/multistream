import { getAdapter } from '../platforms';
import {
  getFocusedStreamId,
  toggleStreamFocus,
} from './StreamGrid';
import type { HeadersStore } from '../state/headers';
import type { StreamStore } from '../state/streams';

const FOCUS_ICON =
  '<span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 5V1.5H5M9 1.5H12.5V5M12.5 9V12.5H9M5 12.5H1.5V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

export function bindWatchingPanel(
  panel: HTMLElement,
  list: HTMLElement,
  store: StreamStore,
  headersStore: HeadersStore,
  grid: HTMLElement,
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

      const nameButton = document.createElement('button');
      nameButton.type = 'button';
      nameButton.className = 'watching-panel__name';
      nameButton.textContent = adapter.displayName(stream);
      nameButton.title = `Drag to reorder · click to focus ${adapter.displayName(stream)}`;
      nameButton.addEventListener('click', () => {
        toggleStreamFocus(grid, stream.id);
      });

      const focusButton = document.createElement('button');
      focusButton.type = 'button';
      focusButton.className = 'watching-panel__focus';
      focusButton.title = 'Focus stream';
      focusButton.setAttribute('aria-label', `Focus ${adapter.displayName(stream)}`);
      focusButton.setAttribute('aria-pressed', focusedId === stream.id ? 'true' : 'false');
      focusButton.innerHTML = FOCUS_ICON;
      focusButton.addEventListener('click', () => {
        toggleStreamFocus(grid, stream.id);
      });

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'watching-panel__remove';
      removeButton.title = 'Remove stream';
      removeButton.setAttribute('aria-label', `Remove ${adapter.displayName(stream)}`);
      removeButton.innerHTML = '<span aria-hidden="true">×</span>';
      removeButton.addEventListener('click', () => {
        store.removeStream(stream.id);
      });

      item.append(accent, nameButton, focusButton, removeButton);
      list.append(item);
    }

    onLayout?.();
  }

  store.subscribe(sync);
  headersStore.subscribe(sync);
  sync();

  return { sync };
}
