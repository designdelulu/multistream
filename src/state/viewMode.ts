export type ViewMode = 'grid' | 'theater' | 'focus';

type Listener = () => void;

const STORAGE_KEY = 'multistream:view-mode';
const VALID_MODES: ViewMode[] = ['grid', 'theater', 'focus'];

function loadMode(): ViewMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return (VALID_MODES as string[]).includes(stored ?? '') ? (stored as ViewMode) : 'grid';
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

    /** Grid <-> Theater. Never lands on 'focus' — that's reached only via the in-Theater Focus toggle, never as a restart point. */
    toggle(): void {
      this.setMode(mode === 'grid' ? 'theater' : 'grid');
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ViewModeStore = ReturnType<typeof createViewModeStore>;
