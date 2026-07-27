import Sortable from 'sortablejs';
import type { StreamStore } from '../state/streams';

export function bindStreamReorder(grid: HTMLElement, store: StreamStore): void {
  Sortable.create(grid, {
    animation: 150,
    handle: '.stream-card__header',
    draggable: '.stream-card',
    ghostClass: 'stream-card--ghost',
    chosenClass: 'stream-card--chosen',
    dragClass: 'stream-card--drag',
    filter: 'button, a, input, select, textarea',
    preventOnFilter: false,
    onEnd: () => {
      const ids = Array.from(grid.querySelectorAll<HTMLElement>('.stream-card'))
        .map((card) => card.dataset.streamId)
        .filter((id): id is string => Boolean(id));
      store.reorderStreams(ids);
    },
  });
}
