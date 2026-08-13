# TikTok LIVE — experimental support (not official, not shipped)

Tracks the actual state of TikTok LIVE in MultiStream.cc: what exists on
the `feature/tiktok-live-experimental` branch, what it's built on, and
the risk that comes with it. **This is not an official TikTok
integration** — TikTok has not shipped one (see "Why there's still no
official embed" below) — and it has not been merged to `master` or
deployed to production as of this writing.

## Status: experimental, on a feature branch, gated on further review

A working prototype (branch `research/tiktok-live-prototype`, commit
`d6cd4f1`, verdict **PROTOTYPE SUCCESS** — see
`docs/TIKTOK-LIVE-PROTOTYPE-REPORT.md` on that branch; not present here
since the research branch is kept unmerged and unchanged as the
reproducible proof-of-concept) proved that a public TikTok LIVE URL can
be resolved and played back reliably enough to be worth integrating.
That prototype was then wired into the real app on
`feature/tiktok-live-experimental`:
`src/platforms/tiktok.ts`, TikTok-specific mount/cleanup logic in
`src/components/StreamGrid.ts`, and the shared `.stream-card__iframe`
sizing pattern (same one YouTube uses) for the portrait 2-row Grid tile.

This is deliberately **not** presented as "TikTok support" alongside
Twitch/Kick/YouTube anywhere user-facing (marketing copy, the welcome
modal, README's feature list) until a deliberate decision is made to
ship it. Internally and in code comments it is always "Experimental
TikTok LIVE support," never "official TikTok integration."

## How it actually works (and why it's structurally different)

Every other platform in `src/platforms/` embeds an iframe the platform
itself documents for exactly this purpose. TikTok has no such thing (see
below), so this integration instead:

1. The browser sends a public LIVE URL (`tiktok.com/@handle/live`) to a
   small resolver service.
2. The resolver calls `https://www.tiktok.com/api-live/user/room` — the
   same **unauthenticated, undocumented** endpoint TikTok's own web
   client and Streamlink's BSD-2-Clause `tiktok` plugin use. No cookies,
   no login, no bypass of any access control: this is the same request a
   logged-out browser makes loading the live page directly. It has no
   CORS header, which is why it has to be called server-side rather than
   fetched straight from the browser.
3. The resolver returns a temporary, signed FLV CDN URL (typically valid
   ~14 days per the `expire` query param, but treated as
   session-length-only — never cached beyond one resolve).
4. The browser fetches that CDN URL **directly** — the resolver never
   touches video bytes, only the small JSON metadata response. mpegts.js
   demuxes the live FLV into a `<video>` element via MSE.

No resolver is deployed anywhere yet. `VITE_TIKTOK_RESOLVER_URL` is
empty by default (`not_configured` state, fails clearly) — see
`dev/tiktok-resolver/` for the local-dev-only instance used to validate
this branch.

## Real risk, stated plainly

- **`api-live/user/room` is not a documented, versioned TikTok API.**
  Unlike Twitch/Kick/YouTube's embed contracts, TikTok has not committed
  to this endpoint's shape, availability, or continued existence. It can
  change or disappear without notice, exactly like the risk the old
  version of this doc warned about for "just scrape it" approaches —
  this integration accepts that same risk deliberately, scoped to an
  experimental branch, rather than presenting it as a stable feature.
- **Terms of Service**: calling an internal, unauthenticated endpoint
  outside its intended (TikTok's own web client) context sits in a gray
  area under TikTok's ToS around automated access. This has not been
  reviewed by counsel. Do not represent this as sanctioned by TikTok in
  any user-facing copy.
- **Maintenance burden**: any TikTok web client change to this endpoint
  (field renames, new required params, response shape changes) breaks
  this integration silently until someone notices and patches it — there
  is no deprecation notice to watch for, unlike a real API.
- **No SLA, no support channel.** If it breaks, there is nowhere to file
  a bug except re-deriving the new shape from TikTok's own web client,
  the way the original research did from Streamlink's plugin.

Given all of the above, this stays behind a feature flag / unmerged
branch until there's a deliberate, informed decision to accept this risk
in production — not as a default outcome of the branch existing.

## Why there's still no *official* embed to build against instead

TikTok does not currently offer an official way to embed a **LIVE**
broadcast on a third-party page:

- **TikTok oEmbed API** (`https://www.tiktok.com/oembed`) only resolves
  a **published video URL** (`tiktok.com/@user/video/123...`) to an
  iframe embed — no live-room equivalent exists to feed it.
- **TikTok Live API** (TikTok for Developers) exists for live-stream
  metadata and, for approved partners, server-side stream data — it is
  not an embed product and does not return an iframe-able player.

If TikTok ever ships either of those, the honest fix is to replace this
whole resolver/mpegts.js path with a real `buildEmbedUrl` iframe, the
same shape every other adapter already uses — not to keep the
undocumented-endpoint path running alongside an official one.

## What's already in place structurally

- `StreamOrientation` (`src/types.ts`) models `'portrait'` as a
  first-class orientation — the 2-row Grid View span
  (`PORTRAIT_ROW_SPAN`, `src/lib/gridLayout.ts`) and Focus View's
  aspect-preserving primary sizing (`computeFocusViewLayout`) key off
  `orientation`, not `platform`. TikTok LIVE is always portrait, so this
  is derived from platform alone (`src/state/streams.ts`).
- `PlatformAdapter` (`src/platforms/tiktok.ts`) is structurally different
  from the other three: `buildEmbedUrl` is inert (`'about:blank'`,
  intentionally unused) because TikTok has no iframe at all — playback is
  a `<video>` element fed by `resolveTikTokLive` + mpegts.js instead. See
  the module doc comment in `tiktok.ts` for the full reasoning, including
  why bare `@handle` input is deliberately unsupported (ambiguous with
  Twitch's existing bare-username claim in `src/platforms/index.ts`).

## Known integration-specific issue and fix

mpegts.js's `enableWorker: true` mode throws `TypeError: ... is not a
constructor` inside its worker blob when bundled through Vite's dev
server — a mpegts.js/Vite bundling incompatibility, not a MultiStream
bug. Fixed by running main-thread demuxing (`enableWorker: false`, see
`StreamGrid.ts`), which is fine for a single concurrent TikTok stream.
Re-check this if mpegts.js or the Vite version changes.

## Re-checking this later

TikTok's developer documentation is the source of truth, not this file's
memory of it — re-check `https://developers.tiktok.com/` and
`https://www.tiktok.com/oembed` directly before assuming any of the
above is still accurate.
