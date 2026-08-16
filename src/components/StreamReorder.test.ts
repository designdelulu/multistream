import { describe, expect, it, vi } from 'vitest';
import {
  applyDropIntent,
  bindStreamReorder,
  disposeOrphanDragClones,
  dropIntentFromPointer,
  logicalOrderAfterDrop,
  neuterDragCloneMedia,
  type CardRect,
} from './StreamReorder';
import type { HeadersStore } from '../state/headers';
import type { StreamStore } from '../state/streams';

function fakeHeadersStore(): HeadersStore {
  return {
    isHidden: () => false,
    subscribe: () => () => {},
  } as unknown as HeadersStore;
}

function sortableInstance(grid: HTMLElement): any {
  const key = Object.keys(grid).find((k) => k.includes('ortable'));
  return key ? (grid as any)[key] : null;
}

function mixedLineup(): string[] {
  return [
    ...Array.from({ length: 14 }, (_, i) => `twitch:l${i}`),
    'tiktok:portrait',
  ];
}

function landscapeGrid(count: number, cols = 4, w = 100, h = 80): CardRect[] {
  return Array.from({ length: count }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      id: `twitch:l${i}`,
      left: col * w,
      top: row * h,
      right: col * w + w,
      bottom: row * h + h,
    };
  });
}

function mockRect(
  el: HTMLElement,
  rect: { left: number; top: number; right: number; bottom: number },
): void {
  el.getBoundingClientRect = () =>
    ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON() {
        return this;
      },
    }) as DOMRect;
}

describe('logicalOrderAfterDrop', () => {
  const ids = mixedLineup();
  const portrait = 'tiktok:portrait';

  it('moves a landscape card onto another landscape card (before)', () => {
    const next = logicalOrderAfterDrop(ids, 'twitch:l3', 'twitch:l8', false);
    expect(next.indexOf('twitch:l3')).toBe(next.indexOf('twitch:l8') - 1);
    expect(next).toHaveLength(15);
    expect(new Set(next)).toEqual(new Set(ids));
  });

  it('moves the portrait from last into the middle of the lineup', () => {
    const next = logicalOrderAfterDrop(ids, portrait, 'twitch:l7', false);
    expect(next.indexOf(portrait)).toBe(7);
    expect(next[0]).toBe('twitch:l0');
    expect(next[next.length - 1]).toBe('twitch:l13');
  });

  it('moves the portrait farther down from a middle position', () => {
    const middle = logicalOrderAfterDrop(ids, portrait, 'twitch:l4', false);
    const next = logicalOrderAfterDrop(middle, portrait, 'twitch:l11', true);
    expect(next.indexOf(portrait)).toBeGreaterThan(next.indexOf('twitch:l11'));
    expect(next.indexOf(portrait)).toBeGreaterThan(8);
  });

  it('moves a landscape card from before the portrait to after it', () => {
    const withPortraitMid = logicalOrderAfterDrop(ids, portrait, 'twitch:l5', false);
    const portraitAt = withPortraitMid.indexOf(portrait);
    const next = logicalOrderAfterDrop(withPortraitMid, 'twitch:l2', portrait, true);
    expect(next.indexOf('twitch:l2')).toBe(next.indexOf(portrait) + 1);
    expect(next.indexOf(portrait)).toBeGreaterThanOrEqual(portraitAt - 1);
  });

  it('moves a landscape card from after the portrait to before it', () => {
    const withPortraitMid = logicalOrderAfterDrop(ids, portrait, 'twitch:l5', false);
    const next = logicalOrderAfterDrop(withPortraitMid, 'twitch:l12', portrait, false);
    expect(next.indexOf('twitch:l12')).toBe(next.indexOf(portrait) - 1);
  });

  it('does not invent, drop, or duplicate ids', () => {
    const next = logicalOrderAfterDrop(ids, portrait, 'twitch:l0', false);
    expect(next[0]).toBe(portrait);
    expect(next).toHaveLength(ids.length);
    expect(new Set(next).size).toBe(ids.length);
  });

  it('is a no-op when the target id is missing', () => {
    expect(logicalOrderAfterDrop(ids, portrait, 'missing', true)).toEqual(ids);
  });
});

describe('dropIntentFromPointer', () => {
  const portrait: CardRect = { id: 'tiktok:portrait', left: 0, top: 0, right: 100, bottom: 160 };
  const landscape = landscapeGrid(14);
  const cards = [portrait, ...landscape];

  it('treats a pointer past the last occupied visual region as drop-at-end', () => {
    const intent = dropIntentFromPointer({ x: 350, y: 280 }, landscape, 'tiktok:portrait');
    expect(intent).toEqual({ kind: 'end' });
    expect(applyDropIntent(['tiktok:portrait', ...landscape.map((c) => c.id)], 'tiktok:portrait', intent!)).toEqual([
      ...landscape.map((c) => c.id),
      'tiktok:portrait',
    ]);
  });

  it('treats a pointer below every card as drop-at-end', () => {
    expect(dropIntentFromPointer({ x: 50, y: 400 }, landscape, 'tiktok:portrait')).toEqual({ kind: 'end' });
  });

  it('treats a pointer before the first visual item as drop-at-start', () => {
    const intent = dropIntentFromPointer({ x: 10, y: -10 }, landscape, 'tiktok:portrait');
    expect(intent).toEqual({ kind: 'start' });
    expect(applyDropIntent([...landscape.map((c) => c.id), 'tiktok:portrait'], 'tiktok:portrait', intent!)).toEqual([
      'tiktok:portrait',
      ...landscape.map((c) => c.id),
    ]);
  });

  it('treats empty cells to the right of the last row as drop-at-end', () => {
    // 14 landscape in 4 columns: last row is l12 (0,240) and l13 (100,240); cols 2-3 empty
    expect(dropIntentFromPointer({ x: 350, y: 260 }, landscape, 'tiktok:portrait')).toEqual({ kind: 'end' });
  });

  it('inserts before a card when the pointer is in its left half', () => {
    expect(dropIntentFromPointer({ x: 120, y: 40 }, landscape, 'tiktok:portrait')).toEqual({
      kind: 'relative',
      targetId: 'twitch:l1',
      insertAfter: false,
    });
  });

  it('inserts after a card when the pointer is in its right half', () => {
    expect(dropIntentFromPointer({ x: 180, y: 40 }, landscape, 'tiktok:portrait')).toEqual({
      kind: 'relative',
      targetId: 'twitch:l1',
      insertAfter: true,
    });
  });

  it('does not treat the dragged card as a drop target (cancel if pointer is still on it)', () => {
    expect(dropIntentFromPointer({ x: 50, y: 40 }, cards, 'tiktok:portrait')).toBeNull();
  });

  it('moves a landscape card first → last via drop-at-end', () => {
    const ids = landscape.map((c) => c.id);
    const intent = dropIntentFromPointer({ x: 350, y: 280 }, landscape, 'twitch:l0');
    expect(intent?.kind).toBe('end');
    const next = applyDropIntent(ids, 'twitch:l0', intent!);
    expect(next[next.length - 1]).toBe('twitch:l0');
    expect(next[0]).toBe('twitch:l1');
  });
});

describe('bindStreamReorder', () => {
  it('commits store order from the drop-target stream id, not Sortable newIndex', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    const a = document.createElement('div');
    a.className = 'stream-card';
    a.dataset.streamId = 'twitch:a';
    const b = document.createElement('div');
    b.className = 'stream-card';
    b.dataset.streamId = 'twitch:b';
    const p = document.createElement('div');
    p.className = 'stream-card';
    p.dataset.orientation = 'portrait';
    p.dataset.streamId = 'tiktok:p';
    grid.append(a, b, p);
    document.body.appendChild(grid);

    let committed: string[] | null = null;
    const store = {
      getStreams: () => [
        { id: 'twitch:a' },
        { id: 'twitch:b' },
        { id: 'tiktok:p' },
      ],
      reorderStreams: (next: string[]) => {
        committed = next;
      },
    } as unknown as StreamStore;

    bindStreamReorder(grid, store, fakeHeadersStore());
    const sortable = sortableInstance(grid);
    expect(sortable).toBeTruthy();

    sortable.options.onMove({
      related: b,
      willInsertAfter: false,
    });
    sortable.options.onEnd({ item: p });

    expect(committed).toEqual(['twitch:a', 'tiktok:p', 'twitch:b']);
    expect(grid.classList.contains('is-reordering')).toBe(false);

    document.body.removeChild(grid);
  });

  it('commits a pointer drop past the last card as logical end even without a Sortable related target', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    const cards: HTMLElement[] = [];
    const ids = ['tiktok:p', ...Array.from({ length: 4 }, (_, i) => `twitch:l${i}`)];
    for (const [index, id] of ids.entries()) {
      const card = document.createElement('div');
      card.className = 'stream-card';
      card.dataset.streamId = id;
      if (id === 'tiktok:p') card.dataset.orientation = 'portrait';
      mockRect(card, {
        left: (index % 3) * 100,
        top: Math.floor(index / 3) * 80,
        right: (index % 3) * 100 + 100,
        bottom: Math.floor(index / 3) * 80 + (id === 'tiktok:p' ? 160 : 80),
      });
      cards.push(card);
      grid.append(card);
    }
    document.body.appendChild(grid);

    let committed: string[] | null = null;
    const store = {
      getStreams: () => ids.map((id) => ({ id })),
      reorderStreams: (next: string[]) => {
        committed = next;
      },
    } as unknown as StreamStore;

    bindStreamReorder(grid, store, fakeHeadersStore());
    const sortable = sortableInstance(grid);
    sortable.options.onStart({ originalEvent: { clientX: 20, clientY: 20 } });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 280, clientY: 200 }));
    sortable.options.onEnd({ item: cards[0] });

    expect(committed).toEqual(['twitch:l0', 'twitch:l1', 'twitch:l2', 'twitch:l3', 'tiktok:p']);

    document.body.removeChild(grid);
  });

  it('commits a pointer drop before the first card as logical start', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    const ids = [...Array.from({ length: 4 }, (_, i) => `twitch:l${i}`), 'tiktok:p'];
    const cards: HTMLElement[] = [];
    for (const [index, id] of ids.entries()) {
      const card = document.createElement('div');
      card.className = 'stream-card';
      card.dataset.streamId = id;
      mockRect(card, {
        left: (index % 3) * 100,
        top: Math.floor(index / 3) * 80,
        right: (index % 3) * 100 + 100,
        bottom: Math.floor(index / 3) * 80 + 80,
      });
      cards.push(card);
      grid.append(card);
    }
    document.body.appendChild(grid);

    let committed: string[] | null = null;
    const store = {
      getStreams: () => ids.map((id) => ({ id })),
      reorderStreams: (next: string[]) => {
        committed = next;
      },
    } as unknown as StreamStore;

    bindStreamReorder(grid, store, fakeHeadersStore());
    const sortable = sortableInstance(grid);
    sortable.options.onStart({ originalEvent: { clientX: 220, clientY: 100 } });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: -20 }));
    sortable.options.onEnd({ item: cards[cards.length - 1] });

    expect(committed?.[0]).toBe('tiktok:p');
    expect(committed).toHaveLength(5);

    document.body.removeChild(grid);
  });

  it('notifies onDragStart before the drop is committed', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    const card = document.createElement('div');
    card.className = 'stream-card';
    card.dataset.streamId = 'twitch:a';
    grid.append(card);
    document.body.appendChild(grid);

    const events: string[] = [];
    const store = {
      getStreams: () => [{ id: 'twitch:a' }],
      reorderStreams: () => {
        events.push('reorder');
      },
    } as unknown as StreamStore;

    bindStreamReorder(grid, store, fakeHeadersStore(), {
      onDragStart: () => {
        events.push('start');
      },
    });
    const sortable = sortableInstance(grid);
    sortable.options.onStart({});
    expect(events).toEqual(['start']);
    sortable.options.onEnd({ item: card });

    document.body.removeChild(grid);
  });

  it('does not shuffle iframe-bearing cards while the pointer is moving', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    document.body.appendChild(grid);

    bindStreamReorder(grid, { getStreams: () => [], reorderStreams: () => {} } as unknown as StreamStore, fakeHeadersStore());
    const sortable = sortableInstance(grid);
    const related = document.createElement('div');
    related.className = 'stream-card';
    related.dataset.streamId = 'twitch:x';

    expect(sortable.options.onMove({ related, willInsertAfter: true })).toBe(false);

    document.body.removeChild(grid);
  });

  it('disables iframe hit-testing for the whole chosen/drag gesture and restores it after', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    const card = document.createElement('div');
    card.className = 'stream-card';
    card.dataset.streamId = 'kick:deen';
    grid.append(card);
    document.body.appendChild(grid);

    bindStreamReorder(grid, { getStreams: () => [{ id: 'kick:deen' }], reorderStreams: () => {} } as unknown as StreamStore, fakeHeadersStore());
    const sortable = sortableInstance(grid);

    expect(sortable.options.forceFallback).toBe(true);
    expect(sortable.options.fallbackOnBody).toBe(true);

    sortable.options.onChoose({});
    expect(grid.classList.contains('is-dragging')).toBe(true);
    sortable.options.onStart({});
    expect(grid.classList.contains('is-dragging')).toBe(true);
    sortable.options.onEnd({ item: card });
    expect(grid.classList.contains('is-dragging')).toBe(false);

    sortable.options.onChoose({});
    sortable.options.onUnchoose({});
    expect(grid.classList.contains('is-dragging')).toBe(false);

    document.body.removeChild(grid);
  });

  it('fires onDragChoose before is-dragging so the recovery snapshot precedes iframe punch-through', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    const card = document.createElement('div');
    card.className = 'stream-card';
    card.dataset.streamId = 'twitch:a';
    grid.append(card);
    document.body.appendChild(grid);

    let sawDragging = true;
    bindStreamReorder(
      grid,
      { getStreams: () => [{ id: 'twitch:a' }], reorderStreams: () => {} } as unknown as StreamStore,
      fakeHeadersStore(),
      {
        onDragChoose: () => {
          sawDragging = grid.classList.contains('is-dragging');
        },
      },
    );
    const sortable = sortableInstance(grid);
    sortable.options.onChoose({});
    expect(sawDragging).toBe(false);
    expect(grid.classList.contains('is-dragging')).toBe(true);

    document.body.removeChild(grid);
  });

  it('uses the overlay drag grip as the handle when headers are hidden', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    document.body.appendChild(grid);

    const headers = {
      hidden: false,
      isHidden() {
        return this.hidden;
      },
      subscribe(listener: () => void) {
        this.listener = listener;
        return () => {};
      },
      listener: undefined as undefined | (() => void),
    };

    bindStreamReorder(
      grid,
      { getStreams: () => [], reorderStreams: () => {} } as unknown as StreamStore,
      headers as unknown as HeadersStore,
    );
    const sortable = sortableInstance(grid);
    expect(sortable.options.handle).toBe('.stream-card__header');

    headers.hidden = true;
    headers.listener?.();
    expect(sortable.options.handle).toBe('.stream-card__overlay-drag');

    document.body.removeChild(grid);
  });

  it('disables Sortable on a phone viewport so header drags do not steal scroll', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 640px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));

    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    document.body.appendChild(grid);
    try {
      const { sync } = bindStreamReorder(
        grid,
        { getStreams: () => [], reorderStreams: () => {} } as unknown as StreamStore,
        fakeHeadersStore(),
      );
      sync();
      const sortable = sortableInstance(grid);
      expect(sortable.options.disabled).toBe(true);
    } finally {
      document.body.removeChild(grid);
      vi.unstubAllGlobals();
    }
  });
});

describe('neuterDragCloneMedia', () => {
  it('strips cloned TikTok video so a fallback clone cannot play audio', () => {
    const card = document.createElement('article');
    card.className = 'stream-card';
    card.dataset.streamId = 'tiktok:creator';
    const wrap = document.createElement('div');
    wrap.className = 'stream-card__tiktok-wrap';
    const video = document.createElement('video');
    video.className = 'stream-card__tiktok-video';
    video.autoplay = true;
    video.muted = true; // IDL only — cloneNode does not copy this
    video.src = 'https://example.com/live.flv';
    wrap.append(video);
    card.append(wrap);

    const clone = card.cloneNode(true) as HTMLElement;
    expect(clone.querySelector('video')).not.toBeNull();

    neuterDragCloneMedia(clone);

    expect(clone.querySelector('video')).toBeNull();
    expect(clone.querySelector('audio')).toBeNull();
    expect(clone.dataset.streamId).toBeUndefined();
    expect(clone.classList.contains('stream-card--drag-clone')).toBe(true);
    expect(card.querySelector('video')).toBe(video);
    expect(card.contains(video)).toBe(true);
  });

  it('bindStreamReorder wires onClone to neutralize the fallback clone', () => {
    const grid = document.createElement('div');
    grid.dataset.viewMode = 'grid';
    document.body.appendChild(grid);
    bindStreamReorder(
      grid,
      { getStreams: () => [], reorderStreams: () => {} } as unknown as StreamStore,
      fakeHeadersStore(),
    );
    const sortable = sortableInstance(grid);
    expect(typeof sortable.options.onClone).toBe('function');

    const clone = document.createElement('article');
    clone.className = 'stream-card stream-card--drag';
    clone.dataset.streamId = 'tiktok:creator';
    const video = document.createElement('video');
    video.autoplay = true;
    clone.append(video);
    document.body.append(clone);

    sortable.options.onClone({ clone });

    expect(clone.querySelector('video')).toBeNull();
    expect(clone.dataset.streamId).toBeUndefined();

    clone.remove();
    document.body.removeChild(grid);
  });

  it('disposeOrphanDragClones removes leftover body-level fallback clones', () => {
    const leftover = document.createElement('article');
    leftover.className = 'stream-card stream-card--drag';
    leftover.dataset.streamId = 'tiktok:creator';
    const video = document.createElement('video');
    video.autoplay = true;
    leftover.append(video);
    document.body.append(leftover);

    disposeOrphanDragClones();

    expect(leftover.isConnected).toBe(false);
    expect(document.querySelectorAll('body > .stream-card--drag').length).toBe(0);
  });
});
