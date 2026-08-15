import Sortable from 'sortablejs';
import { logPlayerEvent } from '../lib/embedDebug';
import type { HeadersStore } from '../state/headers';
import type { StreamStore } from '../state/streams';

/**
 * Place `draggedId` before or after `targetId` in a logical id list.
 *
 * SortableJS `newIndex` follows visual CSS Grid geometry, which diverges
 * from DOM/store order when a portrait card spans two rows and dense packing
 * backfills holes. The drop result has to be computed from stable stream
 * ids, not from that visual index.
 */
export function logicalOrderAfterDrop(
  ids: readonly string[],
  draggedId: string,
  targetId: string,
  insertAfter: boolean,
): string[] {
  if (!draggedId || draggedId === targetId) return ids.slice();
  const next = ids.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return ids.slice();
  next.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedId);
  return next;
}

export interface CardRect {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type DropIntent =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'relative'; targetId: string; insertAfter: boolean };

const ROW_TOLERANCE_PX = 24;

/**
 * Map a pointer position onto a logical drop intent using rendered card
 * rectangles. Sortable's related/willInsertAfter is unreliable for a large
 * 2D jump: the pointer can land in empty grid space, past the last occupied
 * cell, or on the original (still-in-place) portrait slot.
 *
 * Drop after the last occupied visual region → logical end.
 * Drop before the first visual item → logical start.
 */
export function dropIntentFromPointer(
  pointer: { x: number; y: number },
  cards: readonly CardRect[],
  draggedId: string,
): DropIntent | null {
  const others = cards.filter(
    (card) => card.id && card.id !== draggedId && card.right - card.left >= 2 && card.bottom - card.top >= 2,
  );
  if (others.length === 0) return null;

  const dragged = cards.find((card) => card.id === draggedId);
  const ordered = [...others].sort((a, b) => {
    if (Math.abs(a.top - b.top) > ROW_TOLERANCE_PX) return a.top - b.top;
    return a.left - b.left;
  });

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const minTop = Math.min(...others.map((card) => card.top));
  const maxBottom = Math.max(...others.map((card) => card.bottom));
  const firstRow = ordered.filter((card) => Math.abs(card.top - first.top) <= ROW_TOLERANCE_PX);
  const lastRow = ordered.filter((card) => Math.abs(card.top - last.top) <= ROW_TOLERANCE_PX);
  const firstRowLeft = Math.min(...firstRow.map((card) => card.left));
  const lastRowRight = Math.max(...lastRow.map((card) => card.right));

  if (pointer.y < minTop || (pointer.y < first.bottom && pointer.x < firstRowLeft)) {
    return { kind: 'start' };
  }

  if (pointer.y > maxBottom || (pointer.y >= last.top && pointer.x > lastRowRight)) {
    return { kind: 'end' };
  }

  if (
    dragged &&
    pointer.x >= dragged.left &&
    pointer.x <= dragged.right &&
    pointer.y >= dragged.top &&
    pointer.y <= dragged.bottom
  ) {
    return null;
  }

  const containing = others.find(
    (card) =>
      pointer.x >= card.left &&
      pointer.x <= card.right &&
      pointer.y >= card.top &&
      pointer.y <= card.bottom,
  );
  const target = containing ?? nearestCard(others, pointer);
  const insertAfter = containing
    ? pointer.x >= (target.left + target.right) / 2
    : pointer.y > (target.top + target.bottom) / 2 || pointer.x >= (target.left + target.right) / 2;
  return { kind: 'relative', targetId: target.id, insertAfter };
}

function nearestCard(cards: readonly CardRect[], pointer: { x: number; y: number }): CardRect {
  let best = cards[0];
  let bestDist = Infinity;
  for (const card of cards) {
    const cx = Math.min(Math.max(pointer.x, card.left), card.right);
    const cy = Math.min(Math.max(pointer.y, card.top), card.bottom);
    const dist = (pointer.x - cx) ** 2 + (pointer.y - cy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = card;
    }
  }
  return best;
}

export function applyDropIntent(
  ids: readonly string[],
  draggedId: string,
  intent: DropIntent,
): string[] {
  if (intent.kind === 'start') {
    return [draggedId, ...ids.filter((id) => id !== draggedId)];
  }
  if (intent.kind === 'end') {
    return [...ids.filter((id) => id !== draggedId), draggedId];
  }
  return logicalOrderAfterDrop(ids, draggedId, intent.targetId, intent.insertAfter);
}

export function collectVisualCardRects(grid: HTMLElement): CardRect[] {
  const rects: CardRect[] = [];
  for (const card of grid.querySelectorAll<HTMLElement>('.stream-card')) {
    if (card.classList.contains('stream-card--drag')) continue;
    if (card.classList.contains('stream-card--ghost')) continue;
    if (card.classList.contains('stream-card--drag-clone')) continue;
    const id = card.dataset.streamId;
    if (!id) continue;
    const r = card.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    rects.push({ id, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return rects;
}

/**
 * Sortable `forceFallback` cloneNode()s the dragged card, including any
 * TikTok <video>. The live `muted` IDL does not copy (only the muted
 * content attribute / defaultMuted does), and `autoplay` does — so a clone
 * of a muted playing tile starts a second unmuted audio source. Removing
 * that clone from the DOM does not stop playback. Strip media immediately.
 */
export function neuterDragCloneMedia(clone: HTMLElement): void {
  clone.classList.add('stream-card--drag-clone');
  delete clone.dataset.streamId;
  for (const media of [...clone.querySelectorAll<HTMLMediaElement>('video, audio')]) {
    try {
      media.pause();
    } catch {
      // clone may already be detached
    }
    media.autoplay = false;
    media.muted = true;
    media.defaultMuted = true;
    media.removeAttribute('src');
    media.srcObject = null;
    while (media.firstChild) media.removeChild(media.firstChild);
    try {
      media.load();
    } catch {
      // jsdom / already-disposed
    }
    media.remove();
  }
  for (const iframe of [...clone.querySelectorAll('iframe')]) {
    iframe.src = 'about:blank';
    iframe.remove();
  }
}

/** Fallback clones are appended to document.body; leftovers keep playing audio. */
export function disposeOrphanDragClones(root: ParentNode = document.body): void {
  const orphans = [
    ...root.querySelectorAll<HTMLElement>(':scope > .stream-card--drag'),
    ...root.querySelectorAll<HTMLElement>(':scope > .sortable-fallback'),
    ...root.querySelectorAll<HTMLElement>(':scope > .stream-card--drag-clone'),
  ];
  const seen = new Set<HTMLElement>();
  for (const el of orphans) {
    if (seen.has(el)) continue;
    seen.add(el);
    neuterDragCloneMedia(el);
    el.remove();
  }
}

/**
 * Headers visible → drag the card header (the whole row is the handle).
 * Headers hidden → drag the toolbar's dedicated grip button instead; the
 * SortableJS instance and its onEnd/reorder logic are unchanged, only the
 * `handle` selector moves to match whichever surface is actually visible.
 *
 * Theater/Focus (any non-'grid' view mode) → dragging disabled entirely.
 * This is load-bearing, not cosmetic: a completed drag calls
 * store.reorderStreams -> setStreams -> syncStreamGrid. Grid placement is
 * CSS `order` (store index), not insertBefore of iframe-bearing cards —
 * reparenting those nodes pauses/reloads Twitch/Kick/YouTube. Dragging
 * stays disabled outside Grid so a tray scroll-grab cannot start a
 * reorder at all. Read the live view mode off the grid element itself
 * rather than a module-level flag so this can never drift out of sync
 * with what's actually rendered.
 */
export function bindStreamReorder(
  grid: HTMLElement,
  store: StreamStore,
  headersStore: HeadersStore,
  hooks?: { onDragStart?: () => void; onDragChoose?: () => void },
): { sync: () => void } {
  function isPrimaryModeActive(): boolean {
    return grid.dataset.viewMode !== 'grid';
  }

  let dropTargetId: string | null = null;
  let dropInsertAfter = false;
  let lastPointer: { x: number; y: number } | null = null;

  function setDragging(active: boolean): void {
    grid.classList.toggle('is-dragging', active);
  }

  function onPointerMove(event: PointerEvent): void {
    lastPointer = { x: event.clientX, y: event.clientY };
  }

  function startPointerTracking(event?: Event): void {
    lastPointer = pointerFromEvent(event);
    document.addEventListener('pointermove', onPointerMove, true);
  }

  function stopPointerTracking(): void {
    document.removeEventListener('pointermove', onPointerMove, true);
  }

  const gridSortable = Sortable.create(grid, {
    animation: 0,
    // Native HTML5 drag-and-drop stops delivering dragover to this document
    // once the pointer crosses a cross-origin <iframe> (Twitch/Kick/YouTube
    // embeds fill most cards), silently breaking the drop mid-gesture.
    // forceFallback makes Sortable simulate the drag with its own
    // mouse/touch tracking instead, which keeps working over iframes.
    forceFallback: true,
    fallbackOnBody: true,
    handle: '.stream-card__header',
    draggable: '.stream-card',
    ghostClass: 'stream-card--ghost',
    chosenClass: 'stream-card--chosen',
    dragClass: 'stream-card--drag',
    filter:
      '.stream-card__focus, .stream-card__reload, .stream-card__close, .stream-card__overlay-focus, .stream-card__overlay-reload, .stream-card__overlay-remove, a, input, select, textarea',
    preventOnFilter: false,
    disabled: isPrimaryModeActive(),
    onChoose: () => {
      // Snapshot before is-dragging punches through iframes / freezes
      // headers-hidden hover toolbars. Hover-open already may have paused
      // Twitch; onDragChoose must see the pre-punch-through playing set.
      hooks?.onDragChoose?.();
      setDragging(true);
    },
    onUnchoose: () => {
      setDragging(false);
      stopPointerTracking();
      disposeOrphanDragClones();
    },
    onClone: (evt) => {
      const clone = evt.clone as HTMLElement | undefined;
      if (clone) neuterDragCloneMedia(clone);
    },
    onStart: (evt) => {
      setDragging(true);
      startPointerTracking(sortableOriginalEvent(evt));
      // Snapshot before layout. "Was playing beforehand" is the only thing
      // that authorises a later play() — a user pause is simply absent.
      hooks?.onDragStart?.();
    },
    onMove: (evt, originalEvent) => {
      const fromEvent = pointerFromEvent(originalEvent ?? sortableOriginalEvent(evt));
      if (fromEvent) lastPointer = fromEvent;
      const related = evt.related as HTMLElement | undefined;
      const relatedId = related?.dataset.streamId;
      if (related?.classList.contains('stream-card') && relatedId) {
        dropTargetId = relatedId;
        dropInsertAfter = Boolean(evt.willInsertAfter);
      }
      // Returning false keeps Sortable from insertBefore/appendChild of
      // iframe-bearing cards while the pointer is still moving. `related`
      // still updates, so onEnd can commit a logical store order from ids.
      return false;
    },
    onEnd: (evt) => {
      setDragging(false);
      const draggedId = (evt.item as HTMLElement | undefined)?.dataset.streamId;
      const relatedId = dropTargetId;
      const relatedInsertAfter = dropInsertAfter;
      const pointer = lastPointer ?? pointerFromEvent(sortableOriginalEvent(evt));
      dropTargetId = null;
      dropInsertAfter = false;
      stopPointerTracking();
      lastPointer = null;
      disposeOrphanDragClones();

      if (!draggedId) return;

      const ids = store.getStreams().map((stream) => stream.id);
      const rects = collectVisualCardRects(grid);
      const intent = pointer ? dropIntentFromPointer(pointer, rects, draggedId) : null;
      logPlayerEvent('reorder-drop', {
        draggedId,
        pointer,
        relatedId,
        relatedInsertAfter,
        intent,
      });

      let next: string[] | null = intent ? applyDropIntent(ids, draggedId, intent) : null;
      if (!next && relatedId) {
        next = logicalOrderAfterDrop(ids, draggedId, relatedId, relatedInsertAfter);
      }
      if (!next) return;

      logPlayerEvent('reorder-commit', {
        draggedId,
        nextIndex: next.indexOf(draggedId),
        next,
      });

      if (next.length === ids.length && next.every((id, index) => id === ids[index])) return;
      store.reorderStreams(next);
    },
  });

  function sync(): void {
    const hidden = headersStore.isHidden();
    gridSortable.option('disabled', isPrimaryModeActive());
    // Only the element matching `handle` can start a drag — Focus/Reload/
    // Close in the toolbar are siblings of the grip button, not descendants
    // of it, so switching this selector is what makes them un-draggable
    // without needing anything else to change.
    gridSortable.option('handle', hidden ? '.stream-card__overlay-drag' : '.stream-card__header');
  }

  headersStore.subscribe(sync);
  return { sync };
}

function pointerFromEvent(event: Event | undefined): { x: number; y: number } | null {
  if (!event) return null;
  if (!('clientX' in event) || !('clientY' in event)) return null;
  const x = Number((event as { clientX: number }).clientX);
  const y = Number((event as { clientY: number }).clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function sortableOriginalEvent(evt: object): Event | undefined {
  if (!('originalEvent' in evt)) return undefined;
  const original = (evt as { originalEvent?: unknown }).originalEvent;
  return original instanceof Event ? original : undefined;
}
