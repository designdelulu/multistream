/**
 * Global keyboard shortcuts (see docs/REFERENCE-RESEARCH.md's "future"
 * list, now implemented). One delegated keydown listener on document,
 * wired once from main.ts with real app actions.
 *
 *   1–9    Grid: enter Theater on the nth stream (same path as that card's
 *          Theater button — entry is itself the unmute gesture). Theater /
 *          Focus: promote the nth stream to primary (same as a tray click —
 *          no mute change).
 *   f      Theater ↔ Focus tray toggle. No-op in Grid (there is no tray).
 *   m      Mute/unmute the primary. Kick primaries no-op (Kick has no
 *          postMessage mute API — see toggleMuteForStream in StreamGrid.ts).
 *   Escape Exit Theater/Focus back to Grid.
 *
 * Everything no-ops while the user is typing in a field, while a modal or
 * menu is open (those have their own Escape/arrow handling), with modifier
 * keys held, or on a phone viewport (Theater/Focus don't exist there — see
 * main.ts's phone sync and handleCardFocusClick's own guard).
 */

import type { StreamRef } from '../types';
import type { ViewMode } from '../state/viewMode';
import { isPhoneViewport } from './viewport';

export interface ShortcutsDeps {
  getStreams(): StreamRef[];
  getViewMode(): ViewMode;
  getPrimaryId(): string | null;
  /** Click-equivalent of a card's Theater button (StreamGrid.activateCardTheaterById). */
  activateCardTheater(streamId: string): void;
  /** Tray-click-equivalent primary promotion (StreamGrid.setFocusViewPrimary semantics). */
  promotePrimary(streamId: string): void;
  /** Theater ↔ Focus toggle (the same callback main.ts gives bindFocusViewToggle). */
  toggleTray(): void;
  /** Back to Grid (the same callback main.ts gives bindFocusViewExit). */
  exitToGrid(): void;
  /** Per-platform mute dispatch (StreamGrid.toggleMuteForStream; Kick no-ops). */
  toggleMute(streamId: string): void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // The closest() fallback covers contenteditable="" (valid, means true) and
  // jsdom's incomplete isContentEditable support.
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  return target.closest('input, textarea, select') !== null;
}

/**
 * Modals/menus with their own keyboard handling. The welcome modal is
 * class-gated on <html> (see WelcomeModal.ts / index.html's inline script);
 * the share menu and story preview use the `hidden` attribute.
 */
function isOverlayOpen(): boolean {
  if (document.documentElement.classList.contains('show-welcome')) return true;
  const shareMenu = document.getElementById('share-menu');
  if (shareMenu && !shareMenu.hidden) return true;
  const storyPreview = document.getElementById('story-preview');
  if (storyPreview && !storyPreview.hidden) return true;
  return false;
}

function shouldSkip(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  if (isEditableTarget(event.target)) return true;
  return isOverlayOpen();
}

function handleShortcut(event: KeyboardEvent, deps: ShortcutsDeps): void {
  if (shouldSkip(event)) return;

  if (event.key === 'Escape') {
    if (deps.getViewMode() !== 'grid') {
      deps.exitToGrid();
    }
    // Never preventDefault on Escape — menus/modals may share it.
    return;
  }

  // Everything below drives Theater/Focus, which don't exist on phones.
  // (matchMedia guard mirrors StreamGrid.ts's — jsdom has no matchMedia.)
  if (typeof window.matchMedia === 'function' && isPhoneViewport()) return;

  const key = event.key.toLowerCase();

  if (key === 'f') {
    if (deps.getViewMode() !== 'grid') {
      event.preventDefault();
      deps.toggleTray();
    }
    return;
  }

  if (key === 'm') {
    const primaryId = deps.getPrimaryId();
    if (deps.getViewMode() !== 'grid' && primaryId) {
      event.preventDefault();
      deps.toggleMute(primaryId);
    }
    return;
  }

  if (/^[1-9]$/.test(key)) {
    const stream = deps.getStreams()[Number(key) - 1];
    if (!stream) return;
    event.preventDefault();
    if (deps.getViewMode() === 'grid') {
      deps.activateCardTheater(stream.id);
    } else {
      deps.promotePrimary(stream.id);
    }
  }
}

/**
 * Binds the global listener. Returns an unbind function (used by tests; the
 * app binds once for the page's lifetime).
 */
export function bindShortcuts(deps: ShortcutsDeps): () => void {
  const handler = (event: KeyboardEvent) => handleShortcut(event, deps);
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
