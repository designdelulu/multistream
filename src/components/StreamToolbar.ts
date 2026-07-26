import { parseStreamInput } from '../platforms';
import type { StreamStore } from '../state/streams';

export function bindStreamToolbar(store: StreamStore): void {
  const form = document.querySelector<HTMLFormElement>('#add-stream-form');
  const input = document.querySelector<HTMLInputElement>('#stream-input');

  if (!form || !input) {
    throw new Error('Stream toolbar elements not found');
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;

    const added = store.addStream(value);
    if (!added) {
      input.classList.add('toolbar__input--error');
      const parsed = parseStreamInput(value);
      const isDuplicate =
        parsed !== null &&
        store.getStreams().some(
          (stream) =>
            stream.platform === parsed.platform && stream.channel === parsed.channel,
        );
      input.setAttribute('aria-invalid', isDuplicate ? 'duplicate' : 'true');
      return;
    }

    input.value = '';
    input.classList.remove('toolbar__input--error');
    input.removeAttribute('aria-invalid');
    input.focus();
  });

  input.addEventListener('input', () => {
    input.classList.remove('toolbar__input--error');
    input.removeAttribute('aria-invalid');
  });
}

export function updateEmptyState(store: StreamStore): void {
  const emptyState = document.querySelector<HTMLElement>('#empty-state');
  if (!emptyState) return;

  const hasStreams = store.getStreams().length > 0;
  emptyState.hidden = hasStreams;
}
