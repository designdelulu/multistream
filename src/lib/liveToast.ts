/**
 * The "back live" toast (see docs/USER-GUIDE.md): status polling notices a
 * previously-offline Twitch/Kick channel returning (detectWentLive in
 * StreamGrid.ts), but a dead embed never reconnects on its own — so the
 * toast pairs the news with a Reload action that runs that card's own
 * reload path. Modeled on the undo toast (main.ts): one at a time, ~8s
 * auto-hide, aria-live polite.
 *
 * Also flashes document.title ("● NAME is live — MultiStream.cc") so a user
 * with the tab backgrounded notices on the tab strip; the original title is
 * restored when the toast hides (timeout or Reload). Pairs with the
 * visibility-resume status check — a returning user gets a fresh poll, and
 * if that poll found the flip, the toast is already waiting for them.
 *
 * Deliberately self-contained (no StreamGrid import): the reload action is
 * an injected callback, which keeps this module unit-testable in jsdom.
 */

const LIVE_TOAST_DURATION_MS = 8000;

export interface LiveToast {
  show(streamName: string, onReload: () => void): void;
  hide(): void;
  isVisible(): boolean;
}

/**
 * The same pair StreamToolbar reports for its suggestions dropdown and share
 * menu. Injected rather than imported so this module stays free of StreamGrid,
 * exactly as the reload action is.
 *
 * The toast is docked in the footer band and normally clears every player, so
 * these fire for the phone layout, where the page scrolls under the fixed dock
 * and a toast can still cover the one stacked card. Obscuring a Twitch embed
 * pauses it (embed requirement 1.3), and without a hook the only thing that
 * notices is the stall sentinel, ten seconds later.
 */
export interface LiveToastOverlayHooks {
  onOverlayOpen?(rect: DOMRect): void;
  onOverlayClose?(): void;
}

export function createLiveToast(
  root: HTMLElement | null,
  overlayHooks?: LiveToastOverlayHooks,
): LiveToast {
  const messageEl = root?.querySelector<HTMLElement>('.live-toast__message') ?? null;
  const actionEl = root?.querySelector<HTMLButtonElement>('.live-toast__action') ?? null;
  let hideTimer = 0;
  let reloadHandler: (() => void) | null = null;
  let savedTitle: string | null = null;

  function restoreTitle(): void {
    if (savedTitle !== null) {
      document.title = savedTitle;
      savedTitle = null;
    }
  }

  function hide(): void {
    const wasVisible = !!root && !root.hidden;
    window.clearTimeout(hideTimer);
    hideTimer = 0;
    if (root) root.hidden = true;
    reloadHandler = null;
    restoreTitle();
    if (wasVisible) overlayHooks?.onOverlayClose?.();
  }

  actionEl?.addEventListener('click', () => {
    const reload = reloadHandler;
    hide();
    reload?.();
  });

  function show(streamName: string, onReload: () => void): void {
    if (!root || !messageEl) return;
    // Edge only: a second channel flipping while the toast is already up must
    // not restart a recovery run that is mid-flight.
    const wasHidden = root.hidden;
    reloadHandler = onReload;
    messageEl.textContent = `${streamName} is back live`;
    root.hidden = false;
    if (wasHidden) overlayHooks?.onOverlayOpen?.(root.getBoundingClientRect());
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, LIVE_TOAST_DURATION_MS);
    // Save the pre-flash title once, so a second stream flipping while the
    // toast is already up doesn't snapshot the flashed title as "original".
    if (savedTitle === null) savedTitle = document.title;
    document.title = `● ${streamName} is live — MultiStream.cc`;
  }

  return {
    show,
    hide,
    isVisible: () => root !== null && !root.hidden,
  };
}
