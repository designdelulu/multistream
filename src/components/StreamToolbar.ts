import { parseStreamInput } from '../platforms';
import type { Platform } from '../types';
import type { HeadersStore } from '../state/headers';
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

function stripAtPrefix(value: string): string {
  return value.trim().replace(/^@+/, '');
}

function isExplicitStreamInput(value: string): boolean {
  return (
    /^(?:t|k|twitch|kick):/i.test(value) ||
    /^https?:\/\//i.test(value) ||
    /(?:^|\.)twitch\.tv\b/i.test(value) ||
    /(?:^|\.)kick\.com\b/i.test(value)
  );
}

/** Plain username candidates for the Twitch/Kick suggestion dropdown. */
export function plainUsernameCandidate(raw: string): string | null {
  const value = stripAtPrefix(raw);
  if (!value || isExplicitStreamInput(value)) return null;
  if (!/^[a-zA-Z0-9_]{1,25}$/.test(value) && !/^[a-zA-Z0-9_-]{1,25}$/.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

/** Explicit prefixes/URLs win; plain usernames use the selected platform. */
export function resolveAddInput(raw: string, platform: Platform): string {
  const value = stripAtPrefix(raw);
  if (!value) return value;

  if (isExplicitStreamInput(value)) {
    return value;
  }

  return platform === 'kick' ? `k:${value}` : value;
}

function iconButtonLabel(button: HTMLButtonElement): HTMLElement | null {
  return button.querySelector<HTMLElement>('.toolbar__icon-btn-label');
}

function setIconButtonLabel(button: HTMLButtonElement, text: string): void {
  const label = iconButtonLabel(button);
  if (label) {
    label.textContent = text;
  }
  button.title = text;
  button.setAttribute('aria-label', text);
}

function tryAddStream(
  store: StreamStore,
  inputEl: HTMLInputElement,
  resolved: string,
): boolean {
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
    return false;
  }

  inputEl.value = '';
  inputEl.classList.remove('toolbar__input--error');
  inputEl.removeAttribute('aria-invalid');
  inputEl.focus();
  return true;
}

export function bindStreamToolbar(store: StreamStore, headersStore: HeadersStore): void {
  const form = document.querySelector<HTMLFormElement>('#add-stream-form');
  const input = document.querySelector<HTMLInputElement>('#stream-input');
  const suggestions = document.querySelector<HTMLElement>('#add-stream-suggestions');
  const shareButton = document.querySelector<HTMLButtonElement>('#share-link');
  const clearButton = document.querySelector<HTMLButtonElement>('#clear-streams');
  const headersButton = document.querySelector<HTMLButtonElement>('#headers-toggle');

  if (!form || !input || !suggestions) {
    throw new Error('Stream toolbar elements not found');
  }

  const formEl = form;
  const inputEl = input;
  const suggestionsEl = suggestions;
  let selectedPlatform = loadPreferredPlatform();
  let shareResetTimer = 0;

  function hideSuggestions(): void {
    suggestionsEl.hidden = true;
    suggestionsEl.replaceChildren();
    inputEl.setAttribute('aria-expanded', 'false');
  }

  function showSuggestions(username: string): void {
    suggestionsEl.replaceChildren();

    const platforms: Platform[] = ['twitch', 'kick'];
    for (const platform of platforms) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'toolbar__suggestion';
      option.role = 'option';
      option.dataset.platform = platform;

      const label = document.createElement('span');
      label.className = 'toolbar__suggestion-label';
      const strong = document.createElement('strong');
      strong.textContent = username;
      label.append('Add ', strong);

      const badge = document.createElement('span');
      badge.className = `toolbar__suggestion-platform toolbar__suggestion-platform--${platform}`;
      badge.textContent = platform === 'twitch' ? 'TWITCH' : 'KICK';

      option.append(label, badge);
      option.addEventListener('mousedown', (event) => {
        // Prevent input blur from racing the click.
        event.preventDefault();
      });
      option.addEventListener('click', () => {
        selectedPlatform = platform;
        persistPreferredPlatform(platform);
        const resolved = resolveAddInput(username, platform);
        if (tryAddStream(store, inputEl, resolved)) {
          hideSuggestions();
        }
      });
      suggestionsEl.append(option);
    }

    suggestionsEl.hidden = false;
    inputEl.setAttribute('aria-expanded', 'true');
  }

  function syncSuggestions(): void {
    const candidate = plainUsernameCandidate(inputEl.value);
    if (!candidate) {
      hideSuggestions();
      return;
    }
    showSuggestions(candidate);
  }

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = stripAtPrefix(inputEl.value);
    if (!value) return;

    const resolved = resolveAddInput(value, selectedPlatform);
    if (tryAddStream(store, inputEl, resolved)) {
      hideSuggestions();
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.classList.remove('toolbar__input--error');
    inputEl.removeAttribute('aria-invalid');
    syncSuggestions();
  });

  inputEl.addEventListener('focus', () => {
    syncSuggestions();
  });

  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSuggestions();
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (formEl.contains(target)) return;
    hideSuggestions();
  });

  function syncActionButtons(): void {
    const hasStreams = store.getStreams().length > 0;
    if (shareButton) shareButton.hidden = !hasStreams;
    if (clearButton) clearButton.hidden = !hasStreams;
  }

  function syncHeadersButton(): void {
    if (!headersButton) return;
    const hidden = headersStore.isHidden();
    const label = hidden ? 'Show headers' : 'Hide headers';
    setIconButtonLabel(headersButton, label);
    headersButton.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  }

  shareButton?.addEventListener('click', async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this link:', url);
      return;
    }
    const previous = iconButtonLabel(shareButton)?.textContent ?? 'Share link';
    setIconButtonLabel(shareButton, 'Copied!');
    window.clearTimeout(shareResetTimer);
    shareResetTimer = window.setTimeout(() => {
      setIconButtonLabel(shareButton, previous === 'Copied!' ? 'Share link' : previous);
    }, 1600);
  });

  clearButton?.addEventListener('click', () => {
    if (store.getStreams().length === 0) return;
    const ok = window.confirm('Remove all streams from this layout?');
    if (!ok) return;
    store.clearStreams();
  });

  headersButton?.addEventListener('click', () => {
    headersStore.toggle();
  });

  store.subscribe(syncActionButtons);
  headersStore.subscribe(syncHeadersButton);
  syncActionButtons();
  syncHeadersButton();
  hideSuggestions();
}

export function updateEmptyState(store: StreamStore): void {
  const emptyState = document.querySelector<HTMLElement>('#empty-state');
  if (!emptyState) return;

  const hasStreams = store.getStreams().length > 0;
  emptyState.hidden = hasStreams;
}
