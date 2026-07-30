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
   records the ids of every `api`-mode player Twitch has itself confirmed
   is playing (via a real `PLAYING` event, latched into state — never a
   guess). A stream the user had already paused is simply absent from this
   list and can never be restarted by recovery.
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
runs) and catches logic regressions instantly. **It says nothing about
whether Twitch actually resumes** — that is cross-origin `iframe`
behavior no unit test can reach. The live 11-stream test above is what
verified real playback; the automated suite is what keeps the decision
logic correct in between live checks.

## Rollback

The last untouched pre-recovery production snapshot lives outside this
repository at `archive/prod backup 07-31-26/` (sibling directories for
earlier dates cover the states before that). Nothing in this baseline's
work has read from or written to any `archive/` directory.
