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

## Autoplay policy: automatic recovery is always muted

**The rule:** only a path running inside a real user gesture may start an
unmuted player. Every automatic path — the bounded add/remove passes, the 90s
watchdog, the layout circuit breaker, the stall sentinel — resumes **muted**
and defers the audio to the next gesture. Muted playback is always permitted;
unmuted playback outside a click is refused, every time, on every browser.

**The bug this came from:** with one stream unmuted, adding another killed it.
Adding resizes every tile, Twitch pauses the affected players, and recovery
answers with `player.play()` from a timer — no gesture. For the unmuted card
that is refused and Twitch fires `PLAYBACK_BLOCKED`. The handler then called
`replayTwitchPlayback`, i.e. `play()` again plus `enforcePreferredMute`, and
`enforcePreferredMute` deliberately does nothing to an unmuted card. So the one
action that clears a block — muting — was skipped for the only card that is
ever blocked. The card latched `blocked` with `data-embed-muted="0"`, so the
mute button kept drawing the unmuted icon over a dead player, and the mute poll
saw nothing to correct because `getMuted()` honestly reported `false` — the
player was unmuted, just not allowed to play. On desktop nothing ever retried:
`replayBlockedVisibleTwitchPlayers` was wired to a `pointerdown` on iPad only.
Escalation made it worse, since `rebuildTwitchPlayer` honoured the unmuted
preference and constructed a fresh `muted: false, autoplay: true` player —
blocked by construction.

**Fix:** `resumeBlockedTwitchPlayback` handles `PLAYBACK_BLOCKED`. On an
unmuted card it marks `data-audio-wanted`, mutes, syncs the button so it stops
lying, plays, and clears the `blocked` latch — the card is playing now, just
silently. `restoreWantedTwitchAudio` turns the audio back on at the next
`pointerdown`, at the stored `twitchVolume`, but only once the player is
confirmed running; unmuting a still-stuck player would just re-block it. An
explicit mute/unmute by the viewer clears any pending restore. `reloadStreamCard`
and `rebuildTwitchPlayer` take a `userInitiated` flag: the header/hover Reload
buttons, toolbar Refresh and the live-toast Reload keep `true`, while
`escalate()`, the circuit breaker and the watchdog pass `false` and construct
muted. The `pointerdown` retry now runs on every device, not just iPad.

**Regression coverage:** `StreamGrid.test.ts`'s "blocked playback — unmuted
Twitch recovery" suite fires a real `PLAYBACK_BLOCKED` at the constructed
player and pins the call *order* (`setMuted(true)` before `play()`), the
truthful button state, the deferred restore at the next gesture, the refusal to
restore onto a still-paused player, an explicit viewer choice cancelling a
pending restore, and that a user-clicked reload still builds unmuted.

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

## Theater tray promotion — primary audio handoff

**Behavior**: in Theater mode (primary plus tray visible), promoting a
tray stream via its header (`setFocusViewPrimary`, `StreamGrid.ts`)
resizes only — no remount — but also **unmutes the new primary at the
shared default volume (25%)** and **mutes the stream that drops into the
tray**. Solo Focus (primary only, tray hidden) does not swap audio on
promotion because the tray is not active.

**Regression coverage**: `StreamGrid.test.ts`'s Theater-entry suite includes
`'promoting a tray stream in Theater mode unmutes the new primary and mutes
the former primary'` and a companion test asserting solo Focus promotion
leaves tray audio unchanged.

## Theater tray layout — partial-row grid-column cleanup

**Symptom**: promoting a tray card from a partial last row (centered via
inline `grid-column`) could leave that offset on the new primary, breaking
Theater layout (cards floating left under the primary). Exiting Theater
via the primary × could leave the offset on grid cards, producing
double-width tiles until a hard refresh.

**Fix**: `updateFocusViewLayout` clears `grid-column` on every card before
re-applying the partial-row offset; `setFocusViewPrimary` clears it on the
promoted card; `syncViewMode(..., 'grid')` and the ordinary grid branch in
`updateGridLayout` clear stray offsets when returning to the grid.

**Regression coverage**: `StreamGrid.test.ts` includes tests for promoting
a partial-row offset card, exiting Theater to grid with all offsets cleared,
and iPad store-`focus` → display-`theater` solo layout.

## Theater tray tiles — stretched boxes, hover pauses, and no way back

**Symptom**: in Theater (store `focus` — primary plus tray), every tray video
sat pillarboxed between black bars. Moving the cursor over a Twitch tray tile
paused it, and it usually never restarted.

Three separate faults, all rooted in tray tile geometry.

**1. The tile was never 16:9.** `computeFocusViewLayout` computed the correct
width (`trayColumnWidth = round(trayHeight * 16 / 9)`) and
`updateFocusViewLayout` wrote it to `--focus-tray-column-width` — and no CSS
rule read it. Tiles instead took `width: 100%` of a `1fr` track by a fixed
pixel height, so the box aspect drifted with the track. Where row-balancing
produced fewer columns than fit (6 secondaries at `fitColumns = 5` becomes 2
rows of 3), the track came out far wider than the capped height allowed:
618×220, i.e. 2.81:1, and the provider letterboxed the rest. Kick was wrong in
the same way from the other side — its shared scale basis was already
`trayColumnWidth`, so it rendered sized for a box it was not being given.

**Fix**: the tile is now a contain-fit between the track width and the per-row
share of the 40% under-grid budget, so it is exactly 16:9 whichever constraint
binds. The fixed `MAX_TRAY_HEIGHT` cap is gone — it was a second limiter that
ignored the track, and the 40% budget already provides the "primary stays
dominant" guarantee it existed for. Tray tracks are now half a tile wide rather
than `1fr`, with `justify-content: center`, so a row is exactly as wide as its
tiles and centers for any count. Portrait tray cards take the 9:16 width that
matches the player rule they already had.

**2. Hover moved the iframe.** Tray cards ran `transform: translateY(-4px)` on
hover, which moves and re-composites the embed; Twitch answered by pausing it.
(This is the same failure mode `main.css` already records for painting controls
over a player, and why the headers-hidden toolbar opens *below* the iframe
instead.) Five shapes were then tried, and none of them landed. The list is
worth reading in full before proposing a sixth, because each one was designed
against the failure of the one before it and still broke playback:

- An `outline` was first, and worked — outlines are painted after descendants
  *and* outside the border box, so it never overlapped the iframe. It was
  dropped only because a hard 2px line read as a box pasted onto the tile.
- An **inset `box-shadow`** replaced it, and was wrong. An inset shadow is
  painted with the element's background, which sits below every descendant, and
  `.stream-card__player` is opaque black across the card's full width — so it
  covered the ring on the left, right and bottom. The whole affordance
  collapsed to the strip of header that has no background of its own, which is
  what shipped and what the user reported as "the border only shows for the top
  part".
- A **masked `::after` at `z-index: 2`**, created on hover, carrying a
  conic-gradient comet in the 3px band just outside the card's padding box. The
  band was placed there deliberately so it never geometrically overlaps the
  video — and that was **not enough**. Reported from production: hovering a
  Theater tray tile paused the Twitch embed every time, for 10+ seconds, until
  the stall sentinel escalated and recovered it. Grid view was unaffected,
  because Grid cards have no ring. A masked, animating element appearing above a
  cross-origin iframe makes Chrome rebuild compositing around it, and Twitch
  answers by pausing.
- **Mounting it permanently and painting it under the player** was the last
  attempt, and the shape that was supposed to be safe. The band stayed, at
  `opacity: 0` with its animation paused, so hover changed only `opacity`
  (compositor-only) and `animation-play-state` — nothing created, destroyed or
  re-parented under the cursor — and it moved to a `::before` at `z-index: -1`
  inside a card made a stacking context with `isolation: isolate`. It made
  things **worse**, and in two separable ways. Reported from production:
  hovering one tile now paused *every* Twitch tile in the tray, with a longer
  recovery than before; and Twitch embeds in Theater started measurably slower
  than the same embeds in Grid, before any hover at all.

  The second symptom is the informative one, because it has nothing to do with
  hover. It indicts what tray cards carried **at rest**: `position: relative`,
  `isolation: isolate`, `overflow: clip` with `overflow-clip-margin`, and a
  masked `::before` mounted on all eight tiles. Grid cards carry none of that
  and start normally. The first symptom follows from what the animation is:
  `--beam-angle` is a registered custom property feeding a `conic-gradient`
  through a two-layer `mask`, which cannot be composited, so running it
  repaints on the main thread every frame inside a grid of eight cross-origin
  iframes — and every isolated sibling card is part of the same recalculation.
  Confining the ring to one card's stacking context confined the *paint*, not
  the cost.

**The rule, and it is a rule and not a warning: a Theater tray tile carries no
per-card hover affordance and no pseudo-element. Its box is left exactly as Grid
leaves it** — no `position`, no `isolation`, no `overflow` override, no
`box-shadow`, no `transition`, nothing on `:hover`. Five shapes were tried
against a live eight-stream lineup and all five degraded playback; the search is
closed, not paused. `StreamGrid.test.ts` asserts each of those absences
individually, because the reverted rule looks like an oversight to anyone
reading only the CSS.

Promotability is still signalled, without touching the card box:
`.stream-card__header` has `cursor: pointer` and a `:focus-visible` outline in
the tray, and its `title` names the action.

### Why any of this pauses Twitch: the actual mechanism

Earlier revisions of this document guessed at compositing. The real answer is
simpler and it is Twitch's, not Chrome's.

[Twitch's embed requirements](https://dev.twitch.tv/docs/embed/), item 1.3:
embeds "should not be obscured in any way by other page elements in whatever
domain context they may appear," and Twitch documents that features are
disabled "if the iframe is obscured or not visible." A cross-origin iframe can
enforce that on itself with
[IntersectionObserver v2](https://web.dev/articles/intersectionobserver-v2)
(`trackVisibility: true`), which is Chromium-only and works in out-of-process
iframes. Its `isVisible` flag goes false when either:

- the implementation cannot guarantee the target is **completely unoccluded** —
  and occlusion is computed from **bounding boxes**, not per-pixel shapes; or
- the target, or anything in its **containing-block chain**, has a transform
  other than a 2D translate or proportional upscale, an opacity below 1, or any
  filter. The spec is deliberately conservative: `opacity: 0.99` alone is
  enough.

Three consequences, and they replace the paint-order rule this section used to
state:

1. **"Outside the padding box" is not clearance.** A ring at `inset: -3px` was
   designed so it never geometrically overlapped the video; its bounding box
   *contains* the player's box. That attempt could not have worked, and the
   reason had nothing to do with `z-index`.
2. **An ancestor's transform or opacity trips it independently of occlusion.**
   That is the general form of the `translateY(-4px)` hover lift and the
   render-big-and-scale-down mount, both recorded above as separate mysteries.
   They are one mystery.
3. **Resizing the player's box is not on the list and stays permitted.** This is
   why the headers-hidden hover rule may shrink a tray player, and why a window
   resize has never been a pause trigger.

So a transient overlay landing on a player is a pause **by design**. It cannot
be styled around, and defeating the detector would be circumventing a
documented embed requirement. Two responses are available, in this order:

- **Place the overlay clear of every player.** The undo and "back live" toasts
  used to sit at `bottom: 24px`, centred — squarely on the Theater tray. They
  now live in `.toast-dock`, a fixed strip whose height `.site-footer` reserves
  as its `min-height`, so no toast rect ever meets a player rect. Both read
  `--toast-dock-height`; changing one without the other puts them back on the
  video.
- **Where the overlay must cover a player, hook it into overlay recovery.** The
  add-stream suggestions dropdown has to open under the toolbar and every
  position there is over a player at some viewport size. `StreamToolbar.ts`
  reports its open/close edges with its own rect, `main.ts`'s
  `handleOverlayOpen` / `handleOverlayClose` snapshot the playing players under
  that rect (`snapshotPlayingTwitchPlayersUnder`), and `beginOverlayRecovery`
  replays them on `RECOVERY_RETRY_OFFSETS_MS` = `[0, 750, 1500, 3000]` with
  `remountOnEscalate: false`. The toasts call the same pair, for the phone
  layout where the page scrolls under the fixed dock. Both edges are
  edge-triggered on purpose — re-firing while the overlay is still up cancels
  and restarts a run faster than its own `play()` offsets can land.

Prevention for the dropdown was considered and rejected: it would mean
permanently reserving ~130px under the toolbar, or reflowing the grid on every
open — and a reflow resizes every player through the `ResizeObserver`, which is
worse than a sub-second resume.

**Finally, the ~10 second number is ours, not Twitch's.** It is the stall
sentinel's confirmation window: `STALL_SENTINEL_POLL_MS` (5000) ×
`STALL_SENTINEL_CONFIRM_TICKS` (3) means a pause is confirmed exactly 10s after
the first paused poll (`src/lib/stallSentinel.ts`). Anything that pauses a
player and has no overlay hook waits that long. That is the entire difference
between the toast's old behaviour and the dropdown's.

What is *not* implicated: the Add Stream button's beam, which uses exactly this
technique — a masked, animating conic band — and is fine on production. Nothing
near it is an iframe. That button also demonstrates the same stacking-context
arithmetic from the other direction: its beam was first written as `z-index: -1`
pseudos peeking out from behind the button's opaque face, and rendered nothing
at all, because that needs an ancestor stacking context to contain the negative
index and neither `.toolbar` (opaque background, no position or z-index) nor
`#app` is one. The pseudos escaped to the root and painted *behind the toolbar's
own background*; only the blurred glow spilling past the toolbar's edges was
ever visible. It is now a masked band painted above the button, where no
stacking context is required.

One hover-time change to a tray player does survive all of this, unexamined:
under `html.headers-hidden`, hovering a tray tile shrinks its player to make
room for the toolbar (`main.css`, the `html.headers-hidden … :hover
.stream-card__player` rule). It predates every attempt above and is off by
default. If tray pauses persist *with headers hidden*, that rule is the next
suspect.

**3. A paused tray tile could not be recovered.** The remount gate used one
global floor — Twitch's documented 400×300 embed minimum. Tray tiles are
deliberately built below that (see `MIN_TRAY_HEIGHT`: a tray tile is a
glanceable thumbnail, and ~160–172px is empirically enough for Twitch to
start), so *every* tray tile failed the gate and was excluded from both remount
paths — the layout circuit breaker and recovery escalation. The stall sentinel
still reached them, but it runs `remountOnEscalate: false`, so all it could do
was retry a `play()` the provider kept refusing. The gate was made region-aware for a while:
400×300 for grid cards, the tray's own floor (306×160) for tray tiles.
**That is no longer the code.** The gate is one global 400×300 measured on
`getBoundingClientRect()`, so tray tiles below it are once again excluded
from both remount paths — the limitation described here is open again, and
is part of the "still open" list in the reverted-scaling section below.

**Regression coverage**: `gridLayout.test.ts` pins `trayColumnWidth ===
round(trayHeight * 16 / 9)` across the width sweep and for secondary counts
1–10, that a tile never exceeds its track, that the under-grid keeps its 40%
share, and the reported 6-stream case specifically. `StreamGrid.test.ts` pins
the written variable, the CSS that consumes it for both orientations, the
absence of any `transform` on tray cards, and — differentially, grid mode
versus tray — that a 501×282 box is refused a remount as a grid card and
granted one as a tray tile.

Note the 160–220 band assertion this replaces was deliberate, and is partly
reversed on purpose: the 40% budget is kept, the hard height cap is not.

## The bottom row reloading after a removal, and how three rounds chased it

Reported as: removing a stream from the top row of a Grid moved everything with
no interruption, but removing one that reflowed the bottom row made that whole
row go black and come back. In Theater, removing a tray stream stopped every
tray tile for 30-90 seconds.

Settled by comparing the 2026-08-21 21:30 production build — which the user
restored and confirmed behaves well — against the current bundle. That backup
lives in `archive/prod backup 08-21-26-3/`, and probing the two for marker
strings and constants is what finally separated cause from response:

| | 21:30 build (good) | the regressed builds |
|---|---|---|
| remount gate | 400×300 | 320×180 |
| toast position | bottom-centre, over the grid | docked in footer band |
| escalate | immediate | deferred to 15s, then 5s |

### What is actually true

**The bottom row pauses briefly on a removal in every build, including the good
one, and recovers on its own fast enough to be invisible.** The pause was never
the thing that needed fixing. Everything the user saw follows from that:

- The 400×300 pair is Twitch's documented minimum *embed* size, and **no 16:9
  player can satisfy it** — 300px of height needs 533px of width. That is not an
  oversight in this codebase, it is load-bearing: it keeps `escalate()` a no-op
  for every grid card (~480×270 at three or four columns) and every Focus tray
  tile (428×241 at four columns). Nothing could auto-remount them, so the blip
  stayed invisible.
- In the 21:30 build exactly two cards visibly stopped on a removal, and they
  restarted instantly. Two is what a bottom-centre toast covers in a
  three-column grid — those were the only cards with a *real* pause, from being
  obscured, and they resumed the moment the toast hid.
- Lowering the gate to 320×180 to address the Theater complaint made grid and
  tray cards eligible for remount. It did not cause a single pause. It **armed
  the reload** for cards that were already recovering by themselves, turning a
  sub-second blip into a multi-second black reload of the whole row.
- Deferring that reload to 15s made the black period longer, not shorter.

The Theater complaint that prompted the gate change was, on this reading, the
same toast covering the tray — the tray sits at the bottom, which is where the
toast was. The toast dock fixed that at the source, so widening the gate was
never the right fix for it either.

### Where it landed

The gate is back at **400×300**, the deferred-escalate machinery is gone, and
the sentinel's stampede guard is back to skipping. The one improvement kept over
the 21:30 baseline is the toast dock, which should take those two blipping cards
to zero. The Focus primary (~1457×820) passes the gate and is still remounted
when its passes are exhausted, exactly as it was.

`never auto-remounts a tray-sized tile when its play() passes are exhausted` in
`StreamGrid.test.ts` locks the contract in: play() is still attempted on every
tile, `destroyCallCount` stays 0 for the tray, and the primary beside it is
still remounted. Setting the gate back to 320×180 makes it fail, which is the
regression guard this round-trip lacked.

### Two things worth not re-learning

**The layout circuit breaker is unreachable on add/remove.** It is armed at both
call sites (`StreamGrid.ts:5150`, `:5184`) immediately after
`playbackRecovery.begin`/`focusExit`, and it skips ids in `pendingIds()` — which
at its 250ms delay is every id in the snapshot, since the coordinator's passes
run to 3000ms. Its candidate list is always empty. Whenever a whole row appears
to reload in unison, that is per-card `escalate()` firing at ~4s, not this.

**A browser-driven repro contaminates itself.** Twitch pauses every embed when
the window is obscured and resumes them all when it is not — three full cycles
appeared in one 10-minute log, each triggered by a screenshot activating the
window, and the pre-mutation snapshot read `playing: []` because everything was
already paused before the click. Any measurement needs the window in front and
untouched for the whole run. The 21:30 backup comparison was worth more than any
of that instrumentation, because it isolated one variable against a build whose
behaviour a human had already judged.

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

## Kick has no header mute/volume control, by design

Kick's embed exposes exactly one audio lever: a `muted=true/false` URL
query param, applied by reassigning the iframe's `src` (`mountKickIframe`
in `StreamGrid.ts`) — there is no postMessage or JS volume API to call
instead. Re-verified 2026-08-15 against Kick's official embed docs
(https://help.kick.com/en/articles/8010826-how-to-embed-your-kick-livestream):
customisation is URL query params only (`autoplay`, `muted`,
`allowfullscreen`). Unofficial userscripts that "control Kick volume"
inject into the iframe's own origin; a cross-origin parent page cannot.
KICK APP-LEVEL AUDIO CONTROL: NOT SAFELY AVAILABLE. That reassignment is a full iframe reload: re-buffering, and a
real chance of resetting Kick's own in-player volume back to its default
(this is exactly what commit `e1799f8` removed — an automatic periodic
Kick reload that was "fixing" stuck streams by resetting their volume
far more often than it helped).

A header mute *button* invites repeated clicking, and each click would
pay that same reload cost — unlike the existing one-time reload already
accepted when entering Focus View (`'focus-unmute'`), which happens at
most once per view-mode transition. Rather than ship a control that
looks identical to Twitch/YouTube/TikTok's but silently reloads the
whole player on every click, Kick has no header audio control at all;
viewers use Kick's own native player chrome (visible inside the iframe)
to mute/adjust volume. Revisit only if Kick ever ships a real postMessage
volume API.

## Debugging

Add `?debugPlayers=1` to the URL (persists for the tab session via
`sessionStorage`) to log, per player: construct/destroy/rebuild, every
Twitch event (`READY`/`PLAY`/`PLAYING`/`PAUSE`/`ENDED`/`OFFLINE`/`ONLINE`/
`PLAYBACK_BLOCKED`), the pre-mutation snapshot, when layout settles, and
every recovery pass (`check`/`play`/`success`/`blocked`/`skip`/
`exhausted`/`cancel`). `?debug=embeds` and `?debug=stats` remain the
existing iframe-lifecycle and playback-stats probes; `?debug=off` clears
all of them.

## Tried and reverted: laying tray Twitch embeds out big and scaling them down

Twitch refuses to autoplay an embed below its documented 400x300, and the
Theater tray routinely builds tiles at half that — seven secondaries in a
normal 1900px window gives roughly 231x130 per tile, where no Twitch
embed ever starts.

Sizing cannot solve it. Seven tiles at 391x220 (16:9 at the reported
~220px floor) only fit four per row at that width, so two rows cost about
62% of the stream area and leave the primary barely larger than a single
tray tile. A hard pixel floor and Theater mode are in direct conflict at
that stream count.

So the tray was made to do what the Kick path has always done for its own
769px desktop-chrome floor: lay the embed out at a fixed large size
(534x300, clearing the documented minimum on both axes) and CSS-scale it
into the tile with `transform: translate(-50%,-50%) scale(...)`.

**It shipped, and it made things strictly worse.** In production the
geometry was exactly as designed — mount `offsetWidth/Height` 534x300,
visual rect 240x135, scale 0.449, primary untouched at `transform: none` —
and *no* Twitch tray tile autoplayed at any window size, before or after a
reload. Each one had to be clicked by hand. Grid view, which has no such
transform, was unaffected. Reverted in full: the scale vars, the CSS rule,
and the remount-gate change that existed only to serve them.

That makes three findings in the same family, and the rule they add up to
is now unconditional: **do not put a transform on, or above, a live Twitch
iframe.** A `translateY` hover lift paused it. Painting controls over it
paused it. A permanent `scale()` on its mount stops it starting at all.
Resizing the iframe's box is fine — an ordinary window resize does that
constantly — it is specifically the transform that Twitch will not
tolerate.

Caveat on the evidence: this is an observational finding from production,
not a reproducible local test. The dev browser pane reports
`document.visibilityState === 'hidden'` permanently, and the app defers
embed construction while the tab is frozen, so no Twitch player ever
mounts there and no playback claim can be checked locally — only geometry.

**Still open**: tray tiles under Twitch's floor do not autoplay. Candidate
directions, none of them yet backed by evidence — CSS `zoom` (a
layout-level scale with no compositing change) instead of `transform`;
showing fewer, larger tray tiles via `targetVisibleTrayCount` /
`TRAY_FIT_COLUMN_WIDTH`; or accepting it and offering one "start all"
control. Note also that `MIN_TRAY_HEIGHT`'s own comment claims ~160px was
"empirically large enough for Twitch to start", which contradicts the
~220px floor reported now — one of the two is stale, and knowing which
would narrow the problem considerably.

## Headers-hidden: the hover toolbar makes room by shrinking the player

Headers-hidden replaces the card header with a toolbar that opens below
the player on hover. Grid pays for that space by shrinking the player,
but those rules are scoped grid-only (the Theater primary must not
inherit Grid's `--player-height` lock) while the rule that *opens* the
toolbar is not. In Theater the tray card therefore grew 30px past its
fixed `--focus-tray-row-height` track: the next row painted over the
overflow and the last row's toolbar was clipped by the focus grid's own
`overflow: hidden`.

The tray now shrinks its player on hover too, with two differences from
the Grid rule:

- **Hover-only**, not Grid's always-on `flex: 1 1 auto`. The resting tile
  has to keep its exact `aspect-ratio: 16 / 9` — that pin exists because
  the card's 1px border otherwise pushes a pixel-height box off ratio and
  the provider letterboxes the difference.
- **Kick re-scales; Twitch deliberately does not, and must not.** Kick's
  wide iframe would have its bottom chrome clipped by the shorter box, so
  it gets the same `min(widthScale, heightScale)` treatment Grid already
  uses. A tray Twitch iframe is plain `inset: 0`, so it just resizes with
  the player — the same thing an ordinary window resize does to it, and
  not a pause trigger. Giving it a hover transform instead is precisely
  the pattern that paused it before (see the reverted scaling section
  above), and Twitch's own chrome is redundant in a tray tile where the
  hover toolbar is the control surface.

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
