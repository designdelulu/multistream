import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindShortcuts, type ShortcutsDeps } from './shortcuts';
import type { StreamRef } from '../types';
import type { ViewMode } from '../state/viewMode';

const DESKTOP_MATCH_MEDIA = (query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }) as MediaQueryList;

function streams(count: number): StreamRef[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `twitch:ch${index + 1}`,
    platform: 'twitch',
    channel: `ch${index + 1}`,
    muted: true,
    orientation: 'landscape',
  }));
}

interface Harness {
  deps: ShortcutsDeps;
  calls: {
    activateCardTheater: ReturnType<typeof vi.fn>;
    promotePrimary: ReturnType<typeof vi.fn>;
    toggleTray: ReturnType<typeof vi.fn>;
    exitToGrid: ReturnType<typeof vi.fn>;
    toggleMute: ReturnType<typeof vi.fn>;
  };
  setMode(mode: ViewMode): void;
}

function harness(options: { streamCount?: number; mode?: ViewMode; primaryId?: string | null } = {}): Harness {
  let mode = options.mode ?? 'grid';
  const calls = {
    activateCardTheater: vi.fn(),
    promotePrimary: vi.fn(),
    toggleTray: vi.fn(),
    exitToGrid: vi.fn(),
    toggleMute: vi.fn(),
  };
  return {
    calls,
    setMode(next: ViewMode) {
      mode = next;
    },
    deps: {
      getStreams: () => streams(options.streamCount ?? 3),
      getViewMode: () => mode,
      getPrimaryId: () => options.primaryId ?? (mode === 'grid' ? null : 'twitch:ch1'),
      activateCardTheater: calls.activateCardTheater,
      promotePrimary: calls.promotePrimary,
      toggleTray: calls.toggleTray,
      exitToGrid: calls.exitToGrid,
      toggleMute: calls.toggleMute,
    },
  };
}

function press(key: string, init: KeyboardEventInit = {}, target?: HTMLElement): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (target ?? document).dispatchEvent(event);
}

describe('bindShortcuts', () => {
  let unbind: () => void = () => {};

  beforeEach(() => {
    // jsdom has no matchMedia — desktop by default (matches: false).
    vi.stubGlobal('matchMedia', DESKTOP_MATCH_MEDIA);
  });

  afterEach(() => {
    unbind();
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('show-welcome');
    document.body.innerHTML = '';
  });

  it('digit in Grid enters Theater on the nth stream', () => {
    const { deps, calls } = harness({ streamCount: 3 });
    unbind = bindShortcuts(deps);

    press('2');

    expect(calls.activateCardTheater).toHaveBeenCalledWith('twitch:ch2');
    expect(calls.promotePrimary).not.toHaveBeenCalled();
  });

  it('digit in Focus promotes the nth stream to primary instead of re-entering Theater', () => {
    const { deps, calls } = harness({ streamCount: 3, mode: 'focus' });
    unbind = bindShortcuts(deps);

    press('3');

    expect(calls.promotePrimary).toHaveBeenCalledWith('twitch:ch3');
    expect(calls.activateCardTheater).not.toHaveBeenCalled();
  });

  it('digit beyond the lineup length is a no-op', () => {
    const { deps, calls } = harness({ streamCount: 2 });
    unbind = bindShortcuts(deps);

    press('9');

    expect(calls.activateCardTheater).not.toHaveBeenCalled();
    expect(calls.promotePrimary).not.toHaveBeenCalled();
  });

  it('f toggles the tray in Theater/Focus, and is a no-op in Grid', () => {
    const { deps, calls, setMode } = harness();
    unbind = bindShortcuts(deps);

    press('f');
    expect(calls.toggleTray).not.toHaveBeenCalled();

    setMode('theater');
    press('f');
    setMode('focus');
    press('F');
    expect(calls.toggleTray).toHaveBeenCalledTimes(2);
  });

  it('m mutes the primary in Theater/Focus, and is a no-op in Grid', () => {
    const { deps, calls, setMode } = harness({ primaryId: 'twitch:ch1' });
    unbind = bindShortcuts(deps);

    press('m');
    expect(calls.toggleMute).not.toHaveBeenCalled();

    setMode('theater');
    press('m');
    expect(calls.toggleMute).toHaveBeenCalledWith('twitch:ch1');
  });

  it('Escape exits Theater/Focus to Grid, and is a no-op in Grid', () => {
    const { deps, calls, setMode } = harness();
    unbind = bindShortcuts(deps);

    press('Escape');
    expect(calls.exitToGrid).not.toHaveBeenCalled();

    setMode('focus');
    press('Escape');
    expect(calls.exitToGrid).toHaveBeenCalledOnce();
  });

  it('ignores keypresses while typing in an input', () => {
    const { deps, calls, setMode } = harness({ mode: 'grid' });
    unbind = bindShortcuts(deps);
    const input = document.createElement('input');
    document.body.append(input);

    press('2', {}, input);
    expect(calls.activateCardTheater).not.toHaveBeenCalled();

    setMode('theater');
    press('f', {}, input);
    press('m', {}, input);
    press('Escape', {}, input);
    expect(calls.toggleTray).not.toHaveBeenCalled();
    expect(calls.toggleMute).not.toHaveBeenCalled();
    expect(calls.exitToGrid).not.toHaveBeenCalled();
  });

  it('ignores keypresses while a contenteditable element is focused', () => {
    const { deps, calls } = harness();
    unbind = bindShortcuts(deps);
    const editable = document.createElement('div');
    // setAttribute rather than the IDL setter — jsdom's contentEditable
    // property doesn't reflect to the attribute closest() matches on.
    editable.setAttribute('contenteditable', 'true');
    document.body.append(editable);

    press('1', {}, editable);
    expect(calls.activateCardTheater).not.toHaveBeenCalled();
  });

  it('ignores keypresses with modifier keys held', () => {
    const { deps, calls, setMode } = harness();
    unbind = bindShortcuts(deps);

    press('1', { ctrlKey: true });
    press('1', { metaKey: true });
    press('1', { altKey: true });
    expect(calls.activateCardTheater).not.toHaveBeenCalled();

    setMode('theater');
    press('f', { ctrlKey: true });
    press('m', { metaKey: true });
    press('Escape', { altKey: true });
    expect(calls.toggleTray).not.toHaveBeenCalled();
    expect(calls.toggleMute).not.toHaveBeenCalled();
    expect(calls.exitToGrid).not.toHaveBeenCalled();
  });

  it('ignores keypresses while the welcome modal, share menu, or story preview is open', () => {
    const { deps, calls, setMode } = harness({ mode: 'grid' });
    unbind = bindShortcuts(deps);

    document.documentElement.classList.add('show-welcome');
    press('1');
    expect(calls.activateCardTheater).not.toHaveBeenCalled();
    document.documentElement.classList.remove('show-welcome');

    const shareMenu = document.createElement('div');
    shareMenu.id = 'share-menu';
    document.body.append(shareMenu);
    press('1');
    expect(calls.activateCardTheater).not.toHaveBeenCalled();
    shareMenu.hidden = true;

    setMode('theater');
    const preview = document.createElement('div');
    preview.id = 'story-preview';
    document.body.append(preview);
    press('Escape');
    expect(calls.exitToGrid).not.toHaveBeenCalled();
  });

  it('does nothing on a phone viewport', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      ...DESKTOP_MATCH_MEDIA(query),
      matches: true,
    }));
    const { deps, calls, setMode } = harness({ mode: 'grid' });
    unbind = bindShortcuts(deps);

    press('1');
    expect(calls.activateCardTheater).not.toHaveBeenCalled();

    setMode('theater'); // unreachable in practice — main.ts forces grid on phones
    press('f');
    press('m');
    expect(calls.toggleTray).not.toHaveBeenCalled();
    expect(calls.toggleMute).not.toHaveBeenCalled();
  });

  it('stops handling keys after unbind', () => {
    const { deps, calls } = harness();
    const off = bindShortcuts(deps);
    off();

    press('1');
    expect(calls.activateCardTheater).not.toHaveBeenCalled();
  });
});
