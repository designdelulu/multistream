export type ViewMode = 'grid' | 'focus';

type Listener = () => void;

const STORAGE_KEY = 'multistream:view-mode';

function loadMode(): ViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'focus' ? 'focus' : 'grid';
  } catch {
    return 'grid';
  }
}

function persistMode(mode: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
}

export function createViewModeStore() {
  let mode = loadMode();
  const listeners = new Set<Listener>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getMode(): ViewMode {
      return mode;
    },

    setMode(next: ViewMode): void {
      if (mode === next) return;
      mode = next;
      persistMode(mode);
      notify();
    },

    toggle(): void {
      this.setMode(mode === 'grid' ? 'focus' : 'grid');
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ViewModeStore = ReturnType<typeof createViewModeStore>;
