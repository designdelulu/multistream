import { beforeEach, describe, expect, it } from 'vitest';
import { createViewModeStore } from './viewMode';

describe('view mode primary persistence', () => {
  beforeEach(() => localStorage.clear());

  it('restores the selected primary in a new store', () => {
    const first = createViewModeStore();
    first.setMode('focus');
    first.setPrimary('tiktok:yonna.jay');

    const restored = createViewModeStore();
    expect(restored.getMode()).toBe('focus');
    expect(restored.getPrimary()).toBe('tiktok:yonna.jay');
  });

  it('removes a cleared primary and ignores oversized storage', () => {
    const store = createViewModeStore();
    store.setPrimary('twitch:a');
    store.setPrimary(null);
    expect(createViewModeStore().getPrimary()).toBeNull();

    localStorage.setItem('multistream:view-primary', 'x'.repeat(257));
    expect(createViewModeStore().getPrimary()).toBeNull();
  });
});
