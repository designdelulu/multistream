# Improvement audit — findings by audience

A follow-up audit to [AUDIT-REPORT.md](./AUDIT-REPORT.md) (which covered the
Focus View / portrait-grid upgrade pass). This one looked at the whole app
through four audiences — **viewers**, **party hosts**, **mods/co-hosts**, and
**the site admin** — and asked: what's already close to free given the
existing architecture, and what's genuinely missing?

Each finding is marked:

- **Shipped** — implemented in the improvement pass this document
  accompanies (see the linked code/tests).
- **Unscheduled** — deliberately not built; rationale noted. These are a
  menu, not a roadmap.

Two invariants constrained everything below, and were preserved:

1. **Status application stays advisory** ([PLAYBACK_STABILITY.md](./PLAYBACK_STABILITY.md)):
   metadata writes touch `data-*` attributes and text only — they never
   remount or reload a player.
2. **Party sync never rebroadcasts video** (`public/api/watch-party.php`
   header): payloads stay small JSON; every viewer loads streams directly
   from the platforms.

---

## 1. Viewers

### Shipped

- ~~**Stream titles on cards.**~~ **Reverted** after user feedback — the
  title crowded the header and obscured the viewer count and duration.
  (The API payloads still carry titles; the UI just doesn't render them
  in the header line any more.) See the revert in
  [src/components/StreamGrid.ts](src/components/StreamGrid.ts).
- **Twitch thumbnails put to use.** `thumbnailUrl` was returned but unused.
  It's now the Story Card image fallback (avatar preferred, thumbnail next,
  initials last) and the card's loading backdrop while the Twitch player
  mounts — the opaque iframe covers it once loaded.
- **Keyboard shortcuts** (desktop). `1`–`9` make the nth stream primary /
  enter Theater, `f` toggles the tray, `m` mutes the primary (Kick primary
  is a documented no-op — Kick has no postMessage volume API), `Esc`
  returns to the grid. Guards: no firing while typing, with modifier keys,
  while a modal/menu is open, or on phones. See
  [USER-GUIDE.md § Keyboard shortcuts](./USER-GUIDE.md#keyboard-shortcuts).
- **"Back live" toast.** Status polling ran every ~3 minutes but a viewer
  never learned an offline channel returned. A definitive `offline → live`
  flip (never from `unavailable` or first apply — no false positives after
  an API outage) now raises a toast with a per-card **Reload** action and
  flashes the tab title until seen. YouTube is excluded: channel cards
  resolve once at mount, so there's no offline → live moment to announce.
- **Shorts orientation persists.** The documented open bug (AUDIT-REPORT
  §15) is fixed: orientation round-trips through `localStorage` and the
  watch-party payload, so a reloaded lineup or a party view keeps Shorts
  portrait. Static path URLs deliberately stay platform+channel only.

### Unscheduled

- **Phone chat overlay.** Chat is hidden on phones today; overlaying it on
  the player would violate the same embed rules that shaped the hidden-
  headers design (Twitch requirement 1.3) and fights the single-column
  layout. No good path at current screen sizes.
- **Offline-card thumbnails.** Using the Twitch thumbnail as the offline
  card's imagery was rejected: the Twitch iframe fills the card and rule
  1.3 forbids overlaying or obscuring it.
- **YouTube "back live".** Needs periodic per-channel re-resolution, which
  is quota-expensive (the 100-unit `search` call) for a notification most
  lineups rarely need. `mode=stats` already keeps *known-video* stats
  fresh at 1 unit per batched poll.

## 2. Party hosts

### Shipped

- **Spotlight sync.** The room payload gained
  `view: {mode: grid|theater|focus, primary}` — desktop viewers follow the
  host's Theater/Focus state and primary stream as they change. A viewer's
  local override sticks until the host changes the view again (separate
  view fingerprint; the viewer is never fought). Phone viewers always stay
  in the single-column grid, matching the existing phone enforcement. A
  stale primary (not in the lineup) falls back to grid.
- **Host presence + idle auto-end.** Rooms previously lived 7 days whether
  or not the host was around. The host client now heartbeats every 30s
  while its tab is visible; viewers see "Host is live" / "Host away"; an
  active room whose host goes silent for 30 minutes is rewritten as
  `ended`, landing viewers on the existing graceful "party has ended —
  keep watching this lineup" flow.
- **Host-only viewer count.** Viewers ping presence (`vid` + `hb=1`) at
  most every 30s — never on every 2s poll, so polling costs no file
  writes. The host's status chip shows "Live watch party · N watching".
  The count appears **only** on host-token-authorized responses, never in
  the public GET.

### Unscheduled

- **Mod / co-host tokens.** A second capability level (can push the lineup
  but not end the room) needs token plumbing the single-host model doesn't
  have, plus UI for issuing/revoking. Real demand should come first.
- **Second-device hosting.** Host control lives in one browser's
  `localStorage`; moving it means accounts or a transfer flow. The
  heartbeat + idle auto-end work bounds the blast radius of a forgotten
  host tab, which was the practical pain.

## 3. Chat

### Shipped

- **Kick chat abuse gating** (`public/api/kick-chat.php` +
  `kick-status.php`). Unauthenticated GETs for any slug used to trigger
  webhook-subscription attempts, burning Kick Events quota. Now: per-IP
  GET throttle, a global daily cap on subscription attempts, and failure
  backoff so one bad slug can't retry-storm. Over-cap behavior serves the
  chat buffer with `subscription: false` — never an error, consistent with
  the advisory philosophy.

### Unscheduled

- **Kick chat send.** Requires user-level OAuth (the current integration
  is app-level); a much bigger surface for a read-mostly feature.
- **Unified multi-platform chat.** Different embed rules, auth models, and
  message formats; the sidebar-per-platform design is the pragmatic
  ceiling for now.

## 4. Admin (abuse + cost hardening)

### Shipped

- **Watch-party rate limits + room cap** (`public/api/watch-party.php`).
  `create` was unauthenticated and unlimited — the largest abuse surface.
  Now: 10 creates/IP/hour, 120 writes (update/heartbeat/end)/IP/minute,
  120 GETs/IP/minute (a 2s poll = 30/min, ~4 tabs of headroom), and a hard
  cap of 200 active rooms (`503 busy` when full, after pruning). The
  client maps `rate_limited`/`busy` to friendly status text; viewers keep
  their last lineup and retry next poll.
- **Per-IP status throttling** (`twitch-status.php`, `kick-status.php`,
  `youtube-resolve.php`): 30 req/IP/minute, a batched request counting as
  one hit regardless of channel count. Over-limit status endpoints answer
  per-channel `unavailable`, which the frontend already renders
  gracefully; `youtube-resolve` answers a soft `rate_limited` error the
  client maps to "keep last-known state".
- **YouTube `mode=stats` response cache.** A fresh `videos.list` call per
  poll became a 60s whole-response cache keyed by the sorted id set, with
  the same per-key lock de-dupe as the other resolvers. Failures are never
  cached — a transient upstream error doesn't poison the next poll.
- **PHP tests wired into npm.** `npm run test:php` runs every
  `tests/*.test.php` suite; `npm run test:all` is the single gate (Vitest
  + PHP) and step 1 of [RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md).

### Unscheduled

- **Volume parity across platforms.** Kick embeds expose no postMessage
  volume API (documented in PLAYBACK_STABILITY.md); a unified volume
  slider would lie about what it controls.
- **Moving rate limits off the filesystem.** File counters under
  `~/multistream-secrets/` are the right size for DreamHost shared
  hosting; Redis/etc. only becomes interesting with real traffic.

---

## Test coverage added in this pass

- `src/lib/shortcuts.test.ts` — key handling, guard conditions, view-mode
  effects.
- `src/lib/liveToast.test.ts` — toast show/action/hide, tab-title flash.
- `src/components/WatchParty.test.ts` (new) — spotlight push/follow/
  override semantics, phone skip, heartbeat scheduling and visibility
  pausing, host-away copy, viewer-ping throttling, rate-limit copy.
- `src/components/StreamGrid.test.ts` — title render/cleanup, thumbnail
  retention, went-live detection.
- `tests/watch-party-unit.test.php` — orientation/view round-trips,
  heartbeat, idle auto-end, viewer prune + host-only count, rate limits,
  room cap.
- `tests/kick-chat-unit.test.php` — subscription daily cap, failure
  backoff, GET throttle.
- `tests/twitch-status-unit.test.php` / `tests/kick-status-unit.test.php` —
  per-IP throttle + over-limit payload shape.
- `tests/youtube-resolve-unit.test.php` (new) — validation, per-IP
  throttle, stats response cache (hit, key ordering, TTL expiry,
  failure-not-cached).
