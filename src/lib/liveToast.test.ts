import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveToast } from './liveToast';

function buildToast(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'live-toast';
  root.hidden = true;
  const message = document.createElement('span');
  message.className = 'live-toast__message';
  const action = document.createElement('button');
  action.className = 'live-toast__action';
  root.append(message, action);
  document.body.append(root);
  return root;
}

describe('createLiveToast', () => {
  beforeEach(() => {
    document.title = 'Original Title';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    document.title = '';
  });

  it('shows the message, unhides, and flashes the tab title', () => {
    const root = buildToast();
    const toast = createLiveToast(root);

    toast.show('foo', () => {});

    expect(root.hidden).toBe(false);
    expect(toast.isVisible()).toBe(true);
    expect(root.querySelector('.live-toast__message')?.textContent).toBe('foo is back live');
    expect(document.title).toBe('● foo is live — MultiStream.cc');
  });

  it('auto-hides after ~8s and restores the original tab title', () => {
    vi.useFakeTimers();
    const root = buildToast();
    const toast = createLiveToast(root);

    toast.show('foo', () => {});
    vi.advanceTimersByTime(8000);

    expect(root.hidden).toBe(true);
    expect(toast.isVisible()).toBe(false);
    expect(document.title).toBe('Original Title');
  });

  it('Reload runs the injected action, hides, and restores the title', () => {
    const root = buildToast();
    const toast = createLiveToast(root);
    const reload = vi.fn();

    toast.show('foo', reload);
    root.querySelector<HTMLButtonElement>('.live-toast__action')?.click();

    expect(reload).toHaveBeenCalledOnce();
    expect(root.hidden).toBe(true);
    expect(document.title).toBe('Original Title');
  });

  it('a second show while visible replaces the message but keeps the pre-flash title', () => {
    const root = buildToast();
    const toast = createLiveToast(root);

    toast.show('foo', () => {});
    toast.show('bar', () => {});
    expect(root.querySelector('.live-toast__message')?.textContent).toBe('bar is back live');
    expect(document.title).toBe('● bar is live — MultiStream.cc');

    toast.hide();
    expect(document.title).toBe('Original Title');
  });

  /*
   * Obscuring a Twitch embed pauses it (embed requirement 1.3), and without an
   * overlay hook the only thing that notices is the stall sentinel, ten
   * seconds later. The toast is docked clear of the players in CSS, but the
   * phone layout scrolls under the fixed dock, so the hooks are the net.
   *
   * Both edges are edge-triggered on purpose: re-firing while the toast is
   * still up cancels and restarts a recovery run faster than its own play()
   * offsets can land.
   */
  it('reports one overlay open edge and one close edge', () => {
    const root = buildToast();
    const onOverlayOpen = vi.fn();
    const onOverlayClose = vi.fn();
    const toast = createLiveToast(root, { onOverlayOpen, onOverlayClose });

    toast.show('foo', () => {});
    expect(onOverlayOpen).toHaveBeenCalledTimes(1);
    expect(onOverlayClose).not.toHaveBeenCalled();

    // A second channel flipping while the toast is already up is not a new
    // overlay — nothing newly covers a player.
    toast.show('bar', () => {});
    expect(onOverlayOpen).toHaveBeenCalledTimes(1);

    toast.hide();
    expect(onOverlayClose).toHaveBeenCalledTimes(1);

    // Hiding an already-hidden toast covers nothing and uncovers nothing.
    toast.hide();
    expect(onOverlayClose).toHaveBeenCalledTimes(1);
  });

  it('is a safe no-op when the toast element is missing', () => {
    const toast = createLiveToast(null);
    expect(() => {
      toast.show('foo', () => {});
      toast.hide();
    }).not.toThrow();
    expect(toast.isVisible()).toBe(false);
    expect(document.title).toBe('Original Title');
  });
});
