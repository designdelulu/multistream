import Sortable from 'sortablejs';
import { isStreamFocused } from './StreamGrid';
import type { HeadersStore } from '../state/headers';
import type { StreamStore } from '../state/streams';

function streamIdsFrom(container: HTMLElement, itemSelector: string): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
    .map((el) => el.dataset.streamId)
    .filter((id): id is string => Boolean(id));
}

/**
 * Headers visible → drag card headers on the grid.
 * Headers hidden → drag bottom handle on each card (or Watching list rows).
 * Focus mode → dragging disabled entirely.
 */
export function bindStreamReorder(
  grid: HTMLElement,
  store: StreamStore,
  headersStore: HeadersStore,
  watchingList: HTMLElement,
): { sync: () => void } {
  const gridSortable = Sortable.create(grid, {
    animation: 150,
    handle: '.stream-card__header',
    draggable: '.stream-card',
    ghostClass: 'stream-card--ghost',
    chosenClass: 'stream-card--chosen',
    dragClass: 'stream-card--drag',
    filter: '.stream-card__focus, .stream-card__close, .stream-card__overlay-focus, a, input, select, textarea',
    preventOnFilter: false,
    disabled: isStreamFocused(),
    onEnd: () => {
      store.reorderStreams(streamIdsFrom(grid, '.stream-card'));
    },
  });

  const watchingSortable = Sortable.create(watchingList, {
    animation: 150,
    draggable: '.watching-panel__item',
    ghostClass: 'watching-panel__item--ghost',
    chosenClass: 'watching-panel__item--chosen',
    dragClass: 'watching-panel__item--drag',
    // Keep remove clickable; drag from the rest of the row.
    filter: '.watching-panel__remove',
    preventOnFilter: true,
    disabled: !headersStore.isHidden() || isStreamFocused(),
    onEnd: () => {
      store.reorderStreams(streamIdsFrom(watchingList, '.watching-panel__item'));
    },
  });

  function sync(): void {
    const focused = isStreamFocused();
    const hidden = headersStore.isHidden();
    gridSortable.option('disabled', focused);
    gridSortable.option('handle', hidden ? '.stream-card__drag-handle' : '.stream-card__header');
    watchingSortable.option('disabled', focused || !hidden);
  }

  headersStore.subscribe(sync);
  return { sync };
}
