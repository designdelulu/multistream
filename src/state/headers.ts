type Listener = () => void;

const STORAGE_KEY = 'multistream:headers-hidden';

function loadHidden(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistHidden(hidden: boolean): void {
  try {
    if (hidden) {
      localStorage.setItem(STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
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
