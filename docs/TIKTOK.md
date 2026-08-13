# TikTok LIVE — experimental support (not an official integration)

Tracks the actual state of TikTok LIVE in MultiStream.cc. **This is not an
official TikTok integration** — TikTok has not shipped one (see "Why
there's still no official embed" below).

## Status: experimental, shipped behind a kill switch

A working prototype (branch `research/tiktok-live-prototype`, commit
`d6cd4f1`, verdict **PROTOTYPE SUCCESS**) proved a public TikTok LIVE URL
can be resolved and played back reliably enough to integrate. That was
wired into the real app on `feature/tiktok-live-experimental` (integration
commit `5b83c13`) and, after a production-hardening pass (this document's
current revision), merged to `master` and deployed.

TikTok LIVE is presented user-facing as **"Experimental TikTok LIVE"** —
never alongside Twitch/Kick/YouTube as if it were an equal, officially
supported platform. Every TikTok card carries a small "Experimental" tag
next to its platform badge (see `createNameBadge` in
`src/components/StreamGrid.ts`). It is never mentioned in marketing copy,
the welcome modal, or README's headline feature list as "supported"
without that qualifier.

**Kill switch:** `TIKTOK_LIVE_ENABLED` in `src/platforms/tiktok.ts`. Flip
to `false` and rebuild to disable TikTok LIVE everywhere — new adds
(toolbar/URL), restoring a saved lineup from `localStorage` or a share
URL, and actual playback — without touching any Twitch/Kick/YouTube code.
See "Rollback" below.

## How it actually works

Every other platform in `src/platforms/` embeds an iframe the platform
itself documents for exactly this purpose. TikTok has no such thing (see
below), so this integration instead:

1. The browser sends a public LIVE URL (`tiktok.com/@handle/live`) to
   `public/api/tiktok-resolve.php` — a same-origin PHP endpoint, deployed
   alongside `youtube-resolve.php` and `twitch-status.php` as a normal
   static file in `dist/api/` (DreamHost runs PHP natively; no extra
   hosting, no database, no framework — same story as those two).
2. That PHP endpoint calls `https://www.tiktok.com/api-live/user/room` —
   the same **unauthenticated, undocumented** endpoint TikTok's own web
   client and Streamlink's BSD-2-Clause `tiktok` plugin use. No cookies,
   no login, no bypass of any access control: this is the same request a
   logged-out browser makes loading the live page directly. It has no
   CORS header, which is why it has to be called server-side.
3. It returns a temporary, signed FLV CDN URL (typically valid ~14 days
   per the `expire` query param) as small JSON metadata, cached for 15
   seconds server-side (see "Resolver safety" below) — never persisted
   longer than that.
4. The browser fetches that CDN URL **directly** — the PHP endpoint never
   touches video bytes, only the small JSON metadata response. `mpegts.js`
   demuxes the live FLV into a `<video>` element via MSE.

Unlike `youtube-resolve.php` (needs a YouTube Data API key) and
`twitch-status.php` (needs a Twitch app Client ID/Secret),
**`tiktok-resolve.php` needs no credentials and no one-time config file**
— the endpoint it calls is unauthenticated. It shares the same
`multistream-secrets/cache/` directory those two already use.

### Local development

`dev/tiktok-resolver/resolver.mjs` is a zero-dependency Node prototype of
the same resolve logic, for running against `vite dev` without PHP. Point
`VITE_TIKTOK_RESOLVER_URL` at it via `.env.local` (gitignored) — see
`dev/tiktok-resolver/README.md`. This only ever has an effect in dev:
`import.meta.env.PROD` gates `TIKTOK_RESOLVER_URL` in
`src/platforms/tiktok.ts` so a production build can never read
`.env.local`, regardless of Vite's file-precedence rules — it always
calls `/api/tiktok-resolve.php`.

## Resolver safety (production endpoint)

`public/api/tiktok-resolve.php`:

- **No SSRF / open-proxy surface.** The client-supplied `url` is only
  ever parsed to extract a username (`parse_tiktok_live_url`, host must
  be `tiktok.com`/`www.tiktok.com`, handle must match
  `^[a-zA-Z0-9_.]{1,64}$`); the script never fetches a client-supplied
  URL — it always builds the upstream request itself against a fixed
  host.
- **Video bytes are never touched or proxied** — only small JSON
  metadata is fetched and relayed; the browser fetches the CDN URL
  directly.
- **Per-IP rate limiting**: a fixed-window counter, 20 requests/minute/IP
  (`RATE_LIMIT_MAX_REQUESTS`/`RATE_LIMIT_WINDOW_SECONDS`), fails open
  (allows the request) if the cache directory is unavailable rather than
  hard-failing every request.
- **Upstream response size cap**: a curl progress callback aborts the
  transfer past `UPSTREAM_MAX_BYTES` (2MB) — TikTok's real metadata JSON
  is a few KB, so this only guards against an unexpected/compromised
  upstream response.
- **Short-lived caching**: 15s for live results, 30s offline, 1h invalid
  creator — never longer, and transient network/upstream failures are
  never cached at all.
- **No stack traces, no PHP warnings/notices** ever reach the response
  body (`display_errors` off, `log_errors` on); errors log a redacted
  reason code only, never the full CDN URL or full upstream response.
- **No CORS header** — same-origin only, called from `multistream.cc`
  itself, unlike the local dev Node prototype which needs a wildcard CORS
  header because it runs on a different port than `vite dev`.

Unit tests: `tests/tiktok-resolve-unit.test.php` (`php
tests/tiktok-resolve-unit.test.php`) — framework-free, same shape as
`tests/twitch-status-unit.test.php`, upstream calls go through an
injectable transport so no real network call happens in the test run.

## What normal users see

- Every TikTok card has a small "Experimental" tag next to the platform
  badge — a low-key signal, never a blocking warning.
- If resolution or playback fails for any reason, the card shows a plain
  message (e.g. "This creator is not live right now.", "TikTok LIVE is
  temporarily unavailable.") plus an **"Open on TikTok"** link to
  `tiktok.com/@handle/live` — never the underlying resolver state code,
  the undocumented endpoint, "FLV", or any other implementation detail
  (see `describeTikTokState` in `src/platforms/tiktok.ts` — a test
  enforces none of its strings mention those terms).
- A TikTok failure never affects Twitch/Kick/YouTube — each platform's
  playback and lifecycle are fully independent (see
  `docs/PLAYBACK_STABILITY.md` for the general per-platform isolation
  design this relies on).

## Real risk, stated plainly

- **`api-live/user/room` is not a documented, versioned TikTok API.**
  Unlike Twitch/Kick/YouTube's embed contracts, TikTok has not committed
  to this endpoint's shape, availability, or continued existence. It can
  change or disappear without notice.
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
  a bug except re-deriving the new shape from TikTok's own web client.

Given all of the above, this ships with the kill switch above precisely
so it can be turned off in minutes if the risk stops being worth it,
without touching anything else on the site.

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
same shape every other adapter already uses.

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

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| Every TikTok card immediately shows an error, even for a known-live creator | `api-live/user/room`'s response shape changed, or TikTok is blocking the resolver's User-Agent/IP | `error_log` on the server (search for `tiktok-resolve:`); re-derive the current shape from TikTok's own web client's network tab |
| One specific creator always errors, others work | That's real — check `state` (offline/invalid_creator are expected, not bugs) | Card's own error text; `describeTikTokState` in `tiktok.ts` |
| Cards work briefly then all start erroring together | Rate limiting from a shared IP (e.g. many users behind one corporate NAT), or the upstream started 429-ing | `RATE_LIMIT_MAX_REQUESTS` in `tiktok-resolve.php`; consider raising it |
| Playback starts then freezes/errors after a while | The signed CDN URL expired mid-session (rare — expiry is ~14 days) or TikTok's edge dropped the connection | `tiktok-player-error` events in embed debug logging; user's own "Reload stream" recovers it |
| A build silently has TikTok pointed at `localhost` | Should be structurally impossible — `import.meta.env.PROD` gates this — but if seen, check the build didn't hardcode a URL past that gate | `TIKTOK_RESOLVER_URL` definition in `tiktok.ts` |

## Rollback

Fastest, cleanest option — **disable without reverting anything else**:

1. Set `TIKTOK_LIVE_ENABLED = false` in `src/platforms/tiktok.ts`.
2. `npm run build`, upload `dist/` per the normal DreamHost process.
3. TikTok can no longer be added, restored from a saved lineup, or
   played — every existing TikTok card shows a clean "unavailable"
   message with an "Open on TikTok" link. Twitch/Kick/YouTube are
   completely unaffected.

Full revert (only if the kill switch isn't enough — e.g. removing the
resolver endpoint entirely for a ToS concern):

1. `git revert <merge-commit-hash>` on `master` (see the commit this
   feature was merged in), or hard-reset to the pre-merge commit if a
   revert conflicts.
2. Delete `public/api/tiktok-resolve.php` from the next `dist/` upload
   (or delete it directly on DreamHost) if the resolver endpoint itself
   needs to stop responding immediately, ahead of a full redeploy.
3. `npm run build`, re-upload `dist/`.

The research branch (`research/tiktok-live-prototype`, commit `d6cd4f1`)
stays untouched either way — it's the reproducible proof-of-concept and
is never merged.

## Re-checking this later

TikTok's developer documentation is the source of truth, not this file's
memory of it — re-check `https://developers.tiktok.com/` and
`https://www.tiktok.com/oembed` directly before assuming any of the
above is still accurate.
