# Playback stability — baseline history

Tracks the known-good states for Twitch/Kick playback reliability and the
headers-hidden hover toolbar, and how to get back to either one.

## Baselines

| Tag | What it is |
|---|---|
| `baseline-known-good-e3a2891` | Earlier known-good baseline — pre-recovery-coordinator, pre-restored toolbar controls. Reverted to after two bad automatic-detector attempts (`180f12e`, `2b42e7c`) shipped regressions. |
| `stable-twitch-recovery` | Current baseline. Live-tested across ~11 concurrent streams: hover-related stopping dramatically reduced (1 brief stop in 20+ repeated hovers, self-recovered), add/remove recovery works without mouse input in the large majority of cases, one player occasionally still needed a hover nudge. Accepted as the new release candidate. |

To return to the current stable baseline:

```bash
git checkout stable-twitch-recovery
```

To compare what changed since the earlier baseline:

```bash
git diff baseline-known-good-e3a2891 stable-twitch-recovery
```

## What changed between the two baselines

1. **Headers-hidden hover toolbar** — a sibling element below
   `.stream-card__player` (never stacked over the iframe), closed at 0px,
   open at 30px on hover or `:focus-within`. Holds, left to right: channel
   identity (username + platform), then Drag, Focus, Reload, Close. All
   four right-side icons are inline SVG in matching 26×26 boxes — no emoji,
   no text glyphs. Opening it only shrinks the hovered player internally;
   the grid never reflows and no permanent space is reserved.
2. **Add/remove playback recovery** (`src/lib/playbackRecovery.ts`) — see
   below.
3. **Manual per-card reload**, available from both the header and the
   toolbar's Reload button, sharing one implementation
   (`reloadStreamCard`) so the two controls cannot drift apart.
4. **Drag-to-reorder in headers-hidden mode**, via the toolbar's Drag
   button. Reuses the same SortableJS instance and reorder logic as the
   header drag — only the `handle` selector changes with visibility.

## Why recovery does not depend on mouse movement

Before this baseline, an `api`-mode Twitch player had no recovery path of
its own after an add/remove — `recoverTwitchPlayersAfterLayout` only
force-remounted `fallback`-mode (bare-iframe) cards. The only things that
could ever un-stick an `api`-mode card were the 90-second watchdog, or a
mousemove/pointerdown-triggered nudge that only stays armed for 30 seconds
after a tab-resume or window resize — which is why hovering a stuck card
"fixed" it (any mouse movement inside that window re-checks every visible
card), and why a card stalled by an add/remove had to wait for one of
those two paths by coincidence.

`src/lib/playbackRecovery.ts` closes that gap with a bounded, timer-driven
coordinator that runs on its own, independent of any pointer event:

1. **Before** a stream is added or removed, `snapshotPlayingTwitchPlayers`
   records the ids of every `api`-mode player Twitch itself currently
   reports as not paused (`player.isPaused() === false`) and not latched
   `offline`/`blocked`. A stream the user had already paused is simply
   absent from this list and can never be restarted by recovery. (Earlier
   versions of this function trusted the `PLAYING` event latch instead —
   see "Mixed-provider add/remove regression" below for why that changed.)
2. `syncStreamGrid` mutates the DOM — only cards that actually change
   existence are touched; every surviving node and its `Twitch.Player`
   instance is reused.
3. Once the grid's final layout has settled (one extra animation frame
   after the CSS variables are written, so every surviving iframe has its
   new box), `beginAddRemoveRecovery` starts one independent check
   sequence per snapshotted id.
4. Each sequence is a **fixed, bounded schedule** — passes at
   0 / 750 / 1500 / 3000ms, then a final observe-only pass at +1000ms —
   because Twitch does not pause immediately when a card resizes; it
   reacts asynchronously, sometimes over a second later. A `play()` call
   fires only on a *confirmed* paused reading, and the run only ends on a
   real `PLAYING` event, a `PLAYBACK_BLOCKED` event, ineligibility (card
   removed, offline, user-focused, or the user visibly clicked into that
   specific iframe after the run started), or the schedule running out.
5. A freshly added card gets its own later-starting schedule
   (1500 / 3000 / 5000ms + 1000ms tail), tracked from its own `READY`
   event — verifying autoplay actually took, without interrupting a
   player that was already starting on its own.
6. A new add/remove **cancels only the previous transaction's still-running
   checks** — a new card's own autoplay-verification run is a different
   question and is left alone, even if it started moments earlier as part
   of the same edit.

None of this is wired to `ResizeObserver`, window resize, focus changes,
or the toolbar's hover transition — those already had their own, older
handling, and attaching a `play()`-capable mechanism to a high-frequency
event is how the original overlay-flashing regression happened. This path
fires only for add/remove transactions and for one freshly mounted card.

## Mixed-provider add/remove regression (Twitch pause-on-YouTube-add)

**Symptom:** adding a YouTube stream (a Short, in the reproduction case) to
a grid with several already-playing Twitch streams caused every existing
Twitch player to stop, and they only resumed on their own after roughly
60-90 seconds — without any manual reload.

**Investigation:** a `data-test-marker`-based reference-equality check
across the mutation proved every existing Twitch card, its mount element,
and its `Twitch.Player` instance were untouched — `syncStreamGrid`'s
stable-`data-stream-id` Map diff (see [Architecture](../README.md#architecture))
only ever creates a card for a genuinely new id and never rebuilds a
surviving one. `detectOrientation` (`state/streams.ts`) is also a plain
synchronous regex check with no async step that could re-classify a Short
after mount. Both hypotheses that pointed at YouTube itself, or at a
teardown/rebuild, were ruled out this way.

**Root cause:** `snapshotPlayingTwitchPlayers` — the "which players were
actually playing right before this mutation" list `beginAddRemoveRecovery`
(step 3-4 above) resumes from — relied solely on the `PLAYING` event latch.
Live testing with `?debugPlayers=1` showed that latch does not reliably
reach `'playing'` for every stream Twitch is genuinely playing; a channel
`player.isPaused()` confirmed as running sometimes never received a
`PLAYING` event at all. The snapshot came back **empty** on a real,
already-playing lineup, so the fast (~4-5 second) bounded recovery pass had
no targets to resume — the only thing left to un-stick those players was
the periodic 90-second watchdog (`recoverStalledTwitchPlayers`), which
matches the reported 60-90s delay.

**Fix:** `snapshotPlayingTwitchPlayers` now reads `player.isPaused()`
directly — the same primitive `checkPaused`/the watchdog already trust —
instead of the `PLAYING` latch, while still excluding anything already
latched `offline`/`blocked` (states `isPaused()` alone can't distinguish
from ordinary buffering). See `src/components/StreamGrid.ts`'s doc comment
on the function for the full reasoning.

**Regression coverage:** `src/components/StreamGrid.test.ts`'s
"mixed-provider player identity" suite drives the real
`createPlayerElement -> mountStreamMedia -> constructTwitchPlayer` path
against a fake `Twitch.Player`/`YT.Player`, and asserts, across an actual
add: every existing card/mount DOM node keeps its exact object identity,
no existing `Twitch.Player` is paused or destroyed, exactly one new player
(YouTube) is constructed, and the snapshot correctly reports the same
Twitch ids as playing both before and after the mutation — the regression's
literal, formerly-empty-array symptom. A second test confirms the
`offline`/`blocked` exclusion still works via a real `OFFLINE` event, not a
hand-set flag.

## The 11-stream live test result

Manually tested in production-equivalent conditions with ~11 concurrent
Twitch streams:

- Hovering repeatedly (20+ times) caused only one brief stop, which
  resumed on its own.
- Adding or removing a stream recovered the affected player(s) without
  the user moving the mouse, in the large majority of trials.
- One player occasionally still needed a hover to resume — see
  Remaining limitation below.
- The restored toolbar identity (username + platform) and the corrected
  SVG icons (magnifier / reload / close, and now the drag grip) were
  reviewed and accepted as-is.

## Phone-breakpoint portrait collapse (found during the responsive pass)

**Symptom**: a portrait stream (a YouTube Short) rendered at 0px tall on
phone-width viewports (≤640px) — invisible, no error. Landscape cards on
the same breakpoint rendered fine.

**Root cause**: the desktop portrait rule gives a portrait card's player
`flex: 1 1 auto` with no `aspect-ratio`, relying on the card's own height
— set by `grid-row: span 2` against the JS-computed `--player-height`
row track — to give the flex child something definite to stretch into.
`isStackedStreamLayout()` (`src/lib/viewport.ts`, phone breakpoint =
640px, same constant the CSS media query uses) deliberately clears
`--player-height` at that width and falls back to a single CSS-only
column. The existing phone media query already re-fixes this for
landscape cards (`aspect-ratio: 16/9; height: auto` — see the comment
above that rule in `main.css`), but never had a matching fix for
portrait cards, which kept the desktop `flex: 1 1 auto` with nothing to
flex into and collapsed to their minimum content size (0, since the
iframe inside is `position: absolute`).

**Fix**: inside the existing `@media (max-width: 640px)` block in
`main.css`, a portrait card now resets `grid-row: auto; order: 0`
(opting out of the 2-row-span/pinned-first placement, which only exists
to solve multi-column packing that doesn't apply to a single column) and
its player gets `aspect-ratio: 9/16; height: auto` directly — the same
"own full-width row, sized by its own real ratio" fallback the desktop
weighted grid was always meant to degrade to at smaller breakpoints. The
`.stream-card__iframe` fills that box edge-to-edge (dropping the
absolute-positioned/letterboxed sizing that exists on desktop to leave
room around a fixed-content-box for `computeWeightedGridLayout`'s
per-cell letterboxing, which has no equivalent at this breakpoint).

**Verification**: live-tested at 375×812 (phone preset) with a fresh
portrait YouTube Short — confirmed full-width card, 349×620px player
(ratio 1.778, matching 9:16), no collapse, header and controls intact.
No jsdom-based CSS layout test exists for this (jsdom does not compute
real layout/box sizes — see "What automated tests do and do not prove"
below); this is a documented manual/live-browser finding, not an
automated regression test.

## Focus View tray promotion — keyboard access (found during the a11y pass)

**Symptom**: promoting a tray stream to primary in Focus View
(`bindFocusViewPromotion`, `StreamGrid.ts`) only ever listened for
`click` on the delegated container — a `.stream-card__header` had
`cursor: pointer` and a `title` tooltip, but no `role`, no `tabindex`,
and no keyboard handler. Mouse/touch-only.

**Fix**: `syncFocusViewDom` now sets `role="button"`, `tabindex="0"`,
and a live `aria-label` ("Make {channel} the primary stream") on every
promotable (non-primary, Focus View active) header, and clears all
three when a header stops being promotable. `bindFocusViewPromotion`
gained a matching delegated `keydown` listener: Enter or Space on a
`.stream-card__header` promotes it exactly like a click. A
`:focus-visible` outline was added so keyboard users can see which
header is focused.

**Regression coverage**: `StreamGrid.test.ts`'s
`'syncViewMode / setFocusViewPrimary — DOM identity across Grid <-> Focus toggles'`
suite has a test dispatching real `KeyboardEvent('keydown', { key:
'Enter' })` / `{ key: ' ' }` against tray headers and asserting the
promotion happens, plus asserting the primary's own header carries
neither `role` nor `tabindex` (it isn't a promotion target). Also
live-verified against the built app in-browser via a real `dispatchEvent`
on the production bundle (OS-level key injection does not reach the page
in this sandbox — a tooling limitation, not something the fix depends
on).

## Remaining limitation

This closes the specific gap that had no recovery path at all. It does
not claim 100% automatic recovery: Twitch's own buffering/CDN behavior,
browser resource pressure, and background-tab throttling can still pause
a stream in ways no client-side heuristic can distinguish from "buffering
that will clear itself" without risking false positives (see
`playbackRecovery.ts`'s design comments on why `isPaused()` is a
deliberately weak signal). The 90-second watchdog and the mouse-driven
nudge remain in place underneath this as a second and third layer for
whatever gets past it, and the manual Reload button is the explicit
last-resort escape hatch.

## Debugging

Add `?debugPlayers=1` to the URL (persists for the tab session via
`sessionStorage`) to log, per player: construct/destroy/rebuild, every
Twitch event (`READY`/`PLAY`/`PLAYING`/`PAUSE`/`ENDED`/`OFFLINE`/`ONLINE`/
`PLAYBACK_BLOCKED`), the pre-mutation snapshot, when layout settles, and
every recovery pass (`check`/`play`/`success`/`blocked`/`skip`/
`exhausted`/`cancel`). `?debug=embeds` and `?debug=stats` remain the
existing iframe-lifecycle and playback-stats probes; `?debug=off` clears
all of them.

## What automated tests do and do not prove

`src/lib/playbackRecovery.test.ts` runs the coordinator against a fake
player and a virtual clock — it pins every rule the coordinator is
supposed to enforce (bounded retries, positive-confirmation-only
`play()`, superseded-transaction cancellation, ineligibility handling,
offline/blocked termination, independent new-player vs. transaction
runs) and catches logic regressions instantly. `StreamGrid.test.ts`'s
mixed-provider identity suite (described above) additionally exercises
the real card-construction path with a fake `Twitch.Player`/`YT.Player`,
so it can assert real DOM/object identity and real construct/destroy call
counts, not just the recovery coordinator's internal state machine.
**None of this says whether Twitch's actual cross-origin iframe resumes
playback** — that is real embed behavior no unit test (fake player or
not) can reach, since a fake player's `isPaused()`/`play()` are just
plain JS methods, not a real postMessage round trip. The live 11-stream
test above, and the live before/after console-log comparison done while
diagnosing the mixed-provider regression, are what verified real
playback; the automated suite is what keeps the decision logic and DOM
identity correct in between live checks.

## Rollback

The last untouched pre-recovery production snapshot lives outside this
repository at `archive/prod backup 07-31-26/` (sibling directories for
earlier dates cover the states before that). Nothing in this baseline's
work has read from or written to any `archive/` directory.
