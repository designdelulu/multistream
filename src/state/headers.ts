type Listener = () => void;

const STORAGE_KEY = 'multistream:headers-hidden';

function loadHidden(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return true;
    return stored === '1';
  } catch {
    return true;
  }
}

function persistHidden(hidden: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, hidden ? '1' : '0');
  } catch {
    // Ignore storage failures.
  }
}

function syncDom(hidden: boolean): void {
  document.documentElement.classList.toggle('headers-hidden', hidden);
}

export function createHeadersStore() {
  let hidden = loadHidden();
  const listeners = new Set<Listener>();

  syncDom(hidden);

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    isHidden(): boolean {
      return hidden;
    },

    setHidden(next: boolean): void {
      if (hidden === next) return;
      hidden = next;
      persistHidden(hidden);
      syncDom(hidden);
      notify();
    },

    toggle(): void {
      this.setHidden(!hidden);
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type HeadersStore = ReturnType<typeof createHeadersStore>;
