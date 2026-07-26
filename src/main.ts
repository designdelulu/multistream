import { renderStreamGrid, updateGridColumns } from './components/StreamGrid';
import { bindStreamToolbar, updateEmptyState } from './components/StreamToolbar';
import { createStreamStore } from './state/streams';

const store = createStreamStore();
const grid = document.querySelector<HTMLElement>('#stream-grid');

if (!grid) {
  throw new Error('#stream-grid not found');
}

const gridEl = grid;

function render(): void {
  renderStreamGrid(gridEl, store);
  updateGridColumns(gridEl);
  updateEmptyState(store);
}

bindStreamToolbar(store);
store.subscribe(render);

window.addEventListener('resize', () => updateGridColumns(gridEl));

render();
