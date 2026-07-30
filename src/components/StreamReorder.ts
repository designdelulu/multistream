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
 * Headers visible → drag the card header (the whole row is the handle).
 * Headers hidden → drag the toolbar's dedicated grip button instead; the
 * SortableJS instance and its onEnd/reorder logic are unchanged, only the
 * `handle` selector moves to match whichever surface is actually visible.
 * Focus mode → dragging disabled entirely, in both cases.
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
      '.stream-card__focus, .stream-card__reload, .stream-card__close, .stream-card__overlay-focus, .stream-card__overlay-reload, .stream-card__overlay-remove, a, input, select, textarea',
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
    // Only the element matching `handle` can start a drag — Focus/Reload/
    // Close in the toolbar are siblings of the grip button, not descendants
    // of it, so switching this selector is what makes them un-draggable
    // without needing anything else to change.
    gridSortable.option('handle', hidden ? '.stream-card__overlay-drag' : '.stream-card__header');
  }

  headersStore.subscribe(sync);
  return { sync };
}
