# Final self-audit report

Covers the full upgrade pass: Focus View, the portrait/Shorts-aware
weighted grid, the mixed-provider Twitch pause regression fix, TikTok
LIVE research, automated regression coverage, a performance/resource
audit, an accessibility pass, a responsive-breakpoint fix, documentation,
and a cross-project sweep. Written as a permanent record, not a
one-off status update — kept in `docs/` alongside the other living docs
it cross-references.

## 1. Scope and objective

Ship a comprehensive upgrade to MultiStream.cc covering: a root-caused
fix for a real playback regression, a new Focus View layout mode, a
portrait/Shorts-aware grid, TikTok LIVE feasibility research, permanent
automated regression tests (not just manual verification), a
performance/resource audit with honest tooling-limit disclosure, a
responsive/accessibility/persistence pass, full documentation, and a
cross-project consistency sweep — all without stopping for check-ins
except where destructive, credential-gated, or cross-project actions
required explicit sign-off.

## 2. Environment and baseline

Vanilla TypeScript + Vite SPA, Vitest/jsdom for tests, SortableJS for
drag-reorder, PHP-backed status endpoints (not runnable locally — `500`s
from `/api/twitch-status.php` in local dev are expected noise, not a
bug). No CI/CD — `dist/` is a local build the user uploads to DreamHost
by hand (see `CLAUDE.md`). Baseline test count at the start of this
session's visible history: 265 passing. Final: **278 passing, 13 test
files, 0 failures**, `tsc --noEmit` clean throughout.

## 3. Root-caused bug: mixed-provider Twitch pause regression

**Symptom**: adding a YouTube stream (in particular a Short) alongside
already-playing Twitch streams caused the existing Twitch players to
stop, self-recovering after 60–90s.

**Investigation**: ruled out DOM/player rebuild via `data-test-marker`
reference-equality checks, and ruled out an orientation-detection race
via a dedicated synchronicity test. Root cause: `snapshotPlayingTwitchPlayers`
trusted a `PLAYING`-event latch that Twitch's own embed does not
reliably re-fire, confirmed live via `?debugPlayers=1`.

**Fix**: read `player.isPaused()` directly (excluding `offline`/`blocked`
latched states first) instead of trusting the latch.

**Regression coverage**: `StreamGrid.test.ts` — real fake-Twitch-player
identity-preservation test (adding a YouTube stream never touches an
existing Twitch player's DOM identity, mount id, or playback state) and
a real-event offline-exclusion test (dispatches the actual `OFFLINE`
Twitch event rather than hand-setting a flag). Full writeup:
[`docs/PLAYBACK_STABILITY.md` § Mixed-provider add/remove regression](./PLAYBACK_STABILITY.md#mixed-provider-addremove-regression-twitch-pause-on-youtube-add).

## 4. Focus View

New toolbar-toggled layout mode: one large primary stream plus a
horizontal tray of the rest. Click (or, after the a11y pass below,
Enter/Space on) a tray stream's **header** to promote it — no remount,
same DOM/player identity preserved across the toggle. Confirmed live via
direct browser interaction (grid → focus → promote → grid, all DOM/player
references stable) and via `StreamGrid.test.ts`'s dedicated identity
suite.

## 5. Portrait/Shorts-aware weighted grid

A portrait stream (YouTube Short) spans exactly 2 landscape rows
(`PORTRAIT_ROW_SPAN` in `src/lib/gridLayout.ts`) rather than a partial
row, keeping its bottom edge aligned with the surrounding grid. It uses
the same column width as a landscape tile — never widened — and the
video itself is letterboxed at its true 9:16 shape inside that 2-row
box, centered with side whitespace where the box is wider than the
video's own aspect (never stretched to fill it). `order: -1` places
every portrait card first in placement order (without touching the
underlying stream-array/drag-order data) so landscape cards correctly
flow around it — documented in-code with the specific auto-placement
failure mode this solves.

**Revision note**: this was originally shipped as a fixed 3-row span
earlier in this pass, then corrected to 2 rows per updated product
direction (a 3-row tile read as oversized for a single Short; 2 rows —
landscape=1 row, portrait=2 rows — was judged the more practical
mixed-grid treatment). `PORTRAIT_ROW_SPAN`, its CSS `grid-row: span`
consumer, and every test/doc reference were updated together; Focus
View's separate portrait-primary sizing (`computeFocusViewLayout`) was
never coupled to this constant and required no change. See §16 for
live pixel measurements taken after the correction.

27 unit tests in `src/lib/gridLayout.test.ts` cover the packing math
directly.

## 6. TikTok LIVE — researched, correctly not implemented

`docs/TIKTOK.md` (new) documents why: TikTok's oEmbed API only resolves
published `video/{id}` URLs, not a live room; the TikTok Live API is a
partner metadata product, not an embed product. No unofficial
workaround was pursued (ToS risk, fragility, inconsistent with this
project's stable-embed-only approach for Twitch/Kick/YouTube). The type
system already treats `StreamOrientation` and `PlatformAdapter` as
capability questions, not YouTube-specific special cases, so adding
TikTok later — if it ever ships an official embed — is a contained
adapter addition, not a rewrite.

## 7. Automated regression tests added this pass

- Mixed-provider Twitch identity preservation + real-event offline
  exclusion (§3).
- Focus View DOM/player identity across Grid↔Focus toggles, including a
  portrait stream's `data-orientation` surviving the toggle.
- Orientation-detection synchronicity (`streams.test.ts`) — proves
  `detectOrientation` resolves within `addStream()`'s own synchronous
  call, ruling out an async-race hypothesis raised during investigation.
- Focus View tray-header keyboard accessibility (§9) — dispatches real
  `KeyboardEvent`s and asserts promotion + attribute correctness.
- `gridLayout.test.ts` (27 tests, pre-existing from earlier in this
  session) covering the weighted-grid packing math directly.

Net: 265 → 278 passing tests across this session's visible history.

## 8. Performance/resource audit

Verified via repeated real browser interaction cycles (6 Focus/Grid
toggles, 2 full add/remove/re-add cycles): DOM card/iframe counts return
to their exact prior baseline after each removal (no growth), Twitch
card/mount object references stay `===`-identical throughout, and
Twitch `player-ready` counts never exceed the true stream count despite
repeated mutations.

**What this does and does not prove** (stated explicitly, per the
no-fabrication requirement): DOM-node-count and object-reference
stability over ~10 interaction cycles is what was actually measured.
This tooling has no heap-snapshot access, so it cannot prove the
absence of a JS-heap-level memory leak — only that the observable
DOM/registry surface doesn't grow. See
[`PLAYBACK_STABILITY.md` § What automated tests do and do not prove](./PLAYBACK_STABILITY.md#what-automated-tests-do-and-do-not-prove).

## 9. Accessibility pass — one real gap found and fixed

Focus View's tray-header promotion (`bindFocusViewPromotion`) was
mouse/touch-only: no `role`, no `tabindex`, no keyboard handler, despite
a `cursor: pointer` affordance. Fixed: promotable headers now get
`role="button"`, `tabindex="0"`, a live `aria-label`, and a
`:focus-visible` outline; a delegated `keydown` listener promotes on
Enter/Space, matching the click path exactly. Covered by a dedicated
test dispatching real `KeyboardEvent`s and verified against the built
production bundle in-browser (OS-level key injection does not reach the
page in this sandbox — a tooling limitation of the test environment,
not of the fix; verified instead via `dispatchEvent` against the real
running app). Full writeup:
[`PLAYBACK_STABILITY.md` § Focus View tray promotion — keyboard access](./PLAYBACK_STABILITY.md#focus-view-tray-promotion--keyboard-access-found-during-the-a11y-pass).

No other interactive element was found missing a keyboard path during
this pass — every other control (header buttons, hover-toolbar buttons,
toolbar buttons) is a real `<button>` and was already keyboard-operable.

## 10. Responsive breakpoint — one real bug found and fixed

At the ≤640px phone breakpoint, a portrait stream's player collapsed to
0px height (invisible video) — the desktop portrait rule depends on a
JS-computed `--player-height` grid-row track that the phone layout path
deliberately clears. Landscape cards already had a matching phone-only
fallback (`aspect-ratio: 16/9`); portrait cards did not. Fixed by giving
portrait cards their own phone-only fallback: a full-width row sized by
`aspect-ratio: 9/16` instead of the 2-row-span/`flex` mechanism, which
only makes sense against the desktop weighted grid. Live-verified at
375×812: 349×620px player, exact 16:9 ratio (9:16 orientation), no
collapse. This is the "portrait becomes its own full-width row at
smaller breakpoints" fallback strategy, now actually implemented rather
than assumed. No jsdom test exists for this (jsdom does not compute real
box layout) — documented as a manual/live-browser finding.

## 11. Persistence audit

`viewMode` (Grid/Focus) persists correctly to `localStorage` under
`multistream:view-mode`, confirmed via full read of `src/state/viewMode.ts`.
Pre-existing, unrelated-to-this-session limitation confirmed and left
as-is (not a regression): `loadFromStorage`/URL-restore always resets a
stream's `orientation` to `'landscape'` on reload — `detectOrientation`
only runs on a fresh `addStream()` call, not on restore. Not fixed in
this pass; noted here for visibility since it directly interacts with
the portrait-grid feature.

## 12. Documentation

New: `docs/TIKTOK.md`, `docs/RELEASE-CHECKLIST.md`, this file. Updated:
`README.md` (Focus View, portrait/Shorts grid, doc index links),
`docs/USER-GUIDE.md` (Focus View section, portrait-grid behavior
including the phone-breakpoint fallback), `docs/PLAYBACK_STABILITY.md`
(mixed-provider regression writeup, phone-breakpoint fix writeup,
keyboard-access fix writeup), `index.html` welcome-modal copy (Focus
View onboarding line). All Focus-View-promotion copy was corrected
mid-session from an inaccurate "click any tray stream" claim to the
accurate "click a tray stream's **header**" (verified against
`main.css`'s own code comment on why the player area can't be clickable
— cross-origin iframe clicks never bubble to the delegated listener —
then live-verified in-browser).

`remove-ai-marks` hygiene pass run on all site-visitor-facing text
touched this session (the `index.html` welcome-modal copy, and the
Design-Delulu marketing copy in §13) — zero suspicious Unicode found in
any pass, no cleaning action needed. Internal dev docs (README,
USER-GUIDE, PLAYBACK_STABILITY, RELEASE-CHECKLIST, TIKTOK, this file)
were correctly left out of scope per the skill's own exclusion list.

## 13. Cross-project sweep

Per the workspace-level `Dropbox/Projects/CLAUDE.md` rule ("show diffs
before applying, no exceptions"), findings were presented to the user
before any edit and applied only after explicit approval — twice: once
for accuracy fixes, once for new feature copy.

**ericbarker.co**: no MultiStream references found — nothing to do.

**Design-Delulu** (`designdelulu-site/`), all approved and applied:

- `work.html` — fixed alt-text (YouTube was missing), added Focus
  View + portrait-grid checklist bullets.
- `blog/launching-multistream-cc-watch-twitch-kick-together.html` —
  fixed alt-text, added Focus View + portrait-grid checklist bullets
  (kept the existing "Focus mode" bullet — a still-accurate, distinct
  feature — rather than overwriting it).
- `feed.xml` — fixed the RSS item's title/description, which only
  mentioned Twitch and Kick even though the post it links to already
  mentioned YouTube in its own on-page metadata.

`remove-ai-marks` hygiene pass run on all three Design-Delulu files
after editing (both the accuracy-fix pass and the new-copy pass) — zero
suspicious Unicode found each time.

Not touched, by deliberate choice: the blog post's JSON-LD
`dateModified` (still `2026-08-02`) — bumping it was offered and
declined implicitly by scope (user approved the content diffs, not a
metadata-date change); left for a future explicit decision.

## 14. Build and release readiness

`npm run build` run twice this session (once after the wording-fix pass,
once — final — after the a11y and phone-breakpoint fixes), both clean:
`tsc` passes, Vite build succeeds,
`dist/api/{youtube-resolve,twitch-status}.php` presence not re-verified
in this pass (see `docs/RELEASE-CHECKLIST.md` step 6 — still the user's
manual pre-upload check). `dist/` is current with every `src/`,
`index.html`, and `docs/`-adjacent change made this session. No
deploy/upload was performed — that remains the user's manual action per
`CLAUDE.md`.

## 15. Known limitations and recommended next steps

- **Orientation resets to landscape on reload** (§11) — pre-existing,
  not fixed this pass. Worth a dedicated follow-up if portrait/Shorts
  usage grows, since a shared/reloaded link currently loses the
  Shorts-aware layout until the stream is re-added fresh.
- **Memory-leak absence cannot be proven with this tooling** (§8) — only
  DOM/registry-count stability was verified, stated explicitly rather
  than overclaimed.
- **TikTok LIVE remains blocked on TikTok's own API surface** (§6) — no
  action possible from this project; `docs/TIKTOK.md` has a
  re-check-later note pointing at TikTok's own developer docs rather
  than trusting this file's memory of them indefinitely.
- **Design-Delulu's `dateModified`** (§13) is stale relative to today's
  content update — a one-line follow-up if the user wants it bumped.
- Recommend running through `docs/RELEASE-CHECKLIST.md` in full
  (including the DreamHost-specific steps, which require the live
  server and were not exercised in this session) before the next
  production upload.

## 16. Portrait row-span correction (3 → 2) — live verification

Per updated product direction (§5), `PORTRAIT_ROW_SPAN` was changed from
3 to 2 and every consumer — the CSS `grid-row: span var(--portrait-row-span, 2)`
rule, `computeWeightedGridLayout`'s row-weighting math, all 27
`gridLayout.test.ts` cases, and every doc reference (`README.md`,
`USER-GUIDE.md`, `PLAYBACK_STABILITY.md`, `TIKTOK.md`) — was updated in
the same pass. Focus View's `computeFocusViewLayout` was never coupled
to this constant and needed no change.

**Live measurement** (1440×900 viewport, chat panel open, 6 landscape +
1 portrait Shorts stream, real production bundle via the dev server —
not jsdom):

| Property | Value |
|---|---|
| Grid columns | 3 × 350px |
| Landscape row track (`--player-height`) | 197px |
| Landscape card total height (player + header chrome) | 244px |
| Portrait card total height | 500px (= 2 × 244px + 12px gap, matching the 2-row formula) |
| Portrait player area height | 453px |
| Portrait content box (`--portrait-content-width/height`) | 252 × 448px — exact 9:16 |
| Side whitespace inside the 348px-wide player | ~48px each side, video centered |
| `grid-row` (computed) | `span 2` |
| `order` (computed) | `-1` |

The computed values match `computeWeightedGridLayout`'s formula exactly:
`spannedHeight = cellHeight×2 + chromeHeightPerRow×2 + gap×1 = 197×2 +
42×2 + 12 = 490`; `playerAreaHeight = 490 − 42 = 448`;
`contentWidth = min(350, 448×9/16) = 252`; `contentHeight = 252×16/9 =
448`. Column width (350px) matches the landscape column exactly — the
portrait tile never widens. Visually confirmed via screenshot: the
portrait tile occupies the first column across both row 1 and row 2,
with the other six landscape cards packing densely around it (columns 2
and 3, three rows) — no overlap, no orphaned gap.

Reorder/wrap behavior itself was not re-tested move-by-move this pass:
the `order: -1` + `grid-auto-flow: dense` mechanism that produces
correct wrapping is unchanged code (only the span *number* changed, not
the packing algorithm), and it was already covered by
`StreamGrid.test.ts`'s drag-reorder and identity-preservation suites
plus `gridLayout.test.ts`'s order-independence cases, both passing
against the new value (278/278, 27/27 respectively).

Mixed-provider regression (§3) was re-run after this change: all 278
tests pass, including the Twitch-identity-preservation and
real-event-offline-exclusion suites — no reintroduced pause/remount
behavior.
