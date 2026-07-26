import { parseStreamInput } from '../platforms';
import type { Platform } from '../types';
import type { StreamStore } from '../state/streams';

const PLATFORM_STORAGE_KEY = 'multistream:add-platform';

function loadPreferredPlatform(): Platform {
  try {
    const stored = localStorage.getItem(PLATFORM_STORAGE_KEY);
    if (stored === 'kick' || stored === 'twitch') {
      return stored;
    }
  } catch {
    // Ignore storage failures.
  }
  return 'twitch';
}

function persistPreferredPlatform(platform: Platform): void {
  try {
    localStorage.setItem(PLATFORM_STORAGE_KEY, platform);
  } catch {
    // Ignore storage failures.
  }
}

/** Explicit prefixes/URLs win; plain usernames use the selected platform. */
export function resolveAddInput(raw: string, platform: Platform): string {
  const value = raw.trim();
  if (!value) return value;

  if (
    /^(?:t|k|twitch|kick):/i.test(value) ||
    /^https?:\/\//i.test(value) ||
    /(?:^|\.)twitch\.tv\b/i.test(value) ||
    /(?:^|\.)kick\.com\b/i.test(value)
  ) {
    return value;
  }

  return platform === 'kick' ? `k:${value}` : value;
}

export function bindStreamToolbar(store: StreamStore): void {
  const form = document.querySelector<HTMLFormElement>('#add-stream-form');
  const input = document.querySelector<HTMLInputElement>('#stream-input');
  const platformButtons = [
    ...document.querySelectorAll<HTMLButtonElement>('.toolbar__platform-btn'),
  ];

  if (!form || !input || platformButtons.length === 0) {
    throw new Error('Stream toolbar elements not found');
  }

  const formEl = form;
  const inputEl = input;
  let selectedPlatform = loadPreferredPlatform();

  function syncPlatformButtons(): void {
    for (const button of platformButtons) {
      const platform = button.dataset.platform as Platform | undefined;
      const active = platform === selectedPlatform;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    inputEl.placeholder =
      selectedPlatform === 'kick'
        ? 'Kick username or URL'
        : 'Twitch username or URL';
  }

  for (const button of platformButtons) {
    button.addEventListener('click', () => {
      const platform = button.dataset.platform;
      if (platform !== 'twitch' && platform !== 'kick') return;
      selectedPlatform = platform;
      persistPreferredPlatform(platform);
      syncPlatformButtons();
      inputEl.focus();
    });
  }

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = inputEl.value.trim();
    if (!value) return;

    const resolved = resolveAddInput(value, selectedPlatform);
    const added = store.addStream(resolved);
    if (!added) {
      inputEl.classList.add('toolbar__input--error');
      const parsed = parseStreamInput(resolved);
      const isDuplicate =
        parsed !== null &&
        store.getStreams().some(
          (stream) =>
            stream.platform === parsed.platform && stream.channel === parsed.channel,
        );
      inputEl.setAttribute('aria-invalid', isDuplicate ? 'duplicate' : 'true');
      return;
    }

    inputEl.value = '';
    inputEl.classList.remove('toolbar__input--error');
    inputEl.removeAttribute('aria-invalid');
    inputEl.focus();
  });

  inputEl.addEventListener('input', () => {
    inputEl.classList.remove('toolbar__input--error');
    inputEl.removeAttribute('aria-invalid');
  });

  syncPlatformButtons();
}

export function updateEmptyState(store: StreamStore): void {
  const emptyState = document.querySelector<HTMLElement>('#empty-state');
  if (!emptyState) return;

  const hasStreams = store.getStreams().length > 0;
  emptyState.hidden = hasStreams;
}
