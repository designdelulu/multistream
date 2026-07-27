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
 * Headers hidden → drag bottom handle on each card.
 * Focus mode → dragging disabled entirely.
 */
export function bindStreamReorder(
  grid: HTMLElement,
  store: StreamStore,
  headersStore: HeadersStore,
): { sync: () => void } {
  const gridSortable = Sortable.create(grid, {
    animation: 150,
    handle: '.stream-card__header',
    draggable: '.stream-card',
    ghostClass: 'stream-card--ghost',
    chosenClass: 'stream-card--chosen',
    dragClass: 'stream-card--drag',
    filter:
      '.stream-card__focus, .stream-card__close, .stream-card__overlay-focus, .stream-card__overlay-remove, a, input, select, textarea',
    preventOnFilter: false,
    disabled: isStreamFocused(),
    onEnd: () => {
      store.reorderStreams(streamIdsFrom(grid, '.stream-card'));
    },
  });

  function sync(): void {
    const focused = isStreamFocused();
    const hidden = headersStore.isHidden();
    gridSortable.option('disabled', focused);
    gridSortable.option('handle', hidden ? '.stream-card__drag-handle' : '.stream-card__header');
  }

  headersStore.subscribe(sync);
  return { sync };
}
