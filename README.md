# MultiStream.cc

Watch **Twitch**, **Kick**, **YouTube**, and **TikTok LIVE** streams online on one page — a responsive grid that keeps landscape players as large as possible at **16:9** and portrait streams (YouTube Shorts, TikTok LIVE) at their true **9:16** shape. **Start a Live Watch Party**, share one link, and everyone who joins follows your lineup as you add, remove, replace, or reorder streams.

![MultiStream.cc — Watch Twitch, Kick, YouTube, and TikTok LIVE streams online](./public/og-image.png)

**Live site:** [multistream.cc](https://multistream.cc)  
**Repository:** [github.com/designdelulu/multistream](https://github.com/designdelulu/multistream)

Built by [Eric Barker](https://ericbarker.co). A product of [Design Delulu](https://designdelulu.com).

**User guide:** [docs/USER-GUIDE.md](./docs/USER-GUIDE.md) — features and how to use the site.
**Playback stability history:** [docs/PLAYBACK_STABILITY.md](./docs/PLAYBACK_STABILITY.md) — known-good baselines, recovery design, and past regressions.
**Release checklist:** [docs/RELEASE-CHECKLIST.md](./docs/RELEASE-CHECKLIST.md) — what to run through before every DreamHost upload.
**TikTok LIVE support:** [docs/TIKTOK.md](./docs/TIKTOK.md) — experimental, unofficial, and how it actually works.
**Audit report:** [docs/AUDIT-REPORT.md](./docs/AUDIT-REPORT.md) — full record of the Focus View / portrait-grid upgrade pass: bugs found and fixed, tests added, and what's still open.
**Improvement audit:** [docs/IMPROVEMENT-AUDIT.md](./docs/IMPROVEMENT-AUDIT.md) — the follow-up audit by audience (viewers / host / admin): what shipped in response and what's deliberately unscheduled.

---

## At a glance

- **Watch together** — Twitch, Kick, YouTube, and TikTok LIVE in one responsive grid (official embeds plus experimental TikTok LIVE resolver).
- **Live Watch Parties** — Share one short link at `/w/ROOM_ID`. Viewers see your current lineup and automatically follow along when you change streams. MultiStream synchronizes the watching configuration, not the video — each viewer still loads streams directly from the platforms.
- **Static sharing** — Existing `/t:username/k:username/…` path URLs still open a fixed lineup. New shares start a **Live Watch Party** instead.
- **Your streams stay direct** — MultiStream coordinates the interface; playback always comes from Twitch, Kick, YouTube, or TikTok.

---

## What it does

MultiStream.cc is a modern multi-stream viewer for Twitch, Kick, YouTube, and experimental TikTok LIVE — co-stream monitoring, tournament weekends, and live watch parties. Add channels from the toolbar, then share a Live Watch Party so viewers follow what you're watching.

- **Twitch + Kick + YouTube + experimental TikTok LIVE** on the same page — official embeds for the first three; TikTok uses a resolver + `<video>` player (see [TikTok LIVE setup](#tiktok-live-setup-experimental))
- **YouTube channels resolve to whatever's live right now** — a handle, username, channel ID, or channel URL is checked server-side on each load; a direct video/Shorts/live URL loads exactly that video, no lookup needed
- **Responsive grid** that packs landscape streams at the largest 16:9 size and portrait streams at true 9:16 (MultiTwitch-style packing for 16:9; a dedicated 2-row portrait rule for 9:16)
- **Portrait streams (YouTube Shorts, Experimental TikTok LIVE) get their own grid rule** — a portrait tile always spans exactly 2 landscape rows in Grid View, letterboxed to its true 9:16 shape rather than stretched; Focus View sizes a portrait primary by its own aspect ratio instead
- **Theater / Focus View** — use any card's Theater button for a large primary, then show the Focus tray and click a tray header to promote it without remounting any player
- **On-card identity** — platform badge + username on every player header (who’s broadcasting stays visible in the viewing plane)
- **Username dropdown** — type a name (or `@name`) and pick a compatible provider; dotted handles such as `yonna.jay` are offered for YouTube and TikTok. Paste any supported URL to skip the dropdown.
- **Share menu** — Start / Copy / End a live watch party (Share and Copy start a party if none is running), preview or download a Story Card image of your lineup; **Clear all** removes every stream
- **Hide headers** — desktop compact mode uses a fixed footer below each embed; iPad instead hides both bars and keeps only a circular close X over the top-right corner
- **Drag to reorder** stream cards (drag the card header, or the drag handle in the hover toolbar when headers are hidden); URL updates without remounting players
- **Session restore** — your lineup, view mode, and selected Theater/Focus primary are restored from `localStorage` (URL path still wins for a shared lineup)
- **Shareable path URLs** like `/t:username/k:username/y:handle:username/tt:creator`
- **Live watch parties** at `/w/ROOM_ID` — viewers follow the host’s lineup, Theater/Focus primary, and chat-sidebar visibility; the host sees a live viewer count and idle rooms auto-end after 30 minutes
- **Keyboard shortcuts** (desktop) — **1–9** make a stream primary / enter Theater, **F** toggles the tray, **M** mutes the primary, **Esc** returns to the grid; shortcuts never fire while typing or with a dialog open (see [docs/USER-GUIDE.md](./docs/USER-GUIDE.md#keyboard-shortcuts))
- **"Back live" toast** — when a Twitch/Kick channel in your lineup flips offline → live on a status poll, a toast offers one-click reload of that card, and the tab title flashes until you look at it
- **× close** and **focus** controls per stream — focus fills the area below the toolbar, opens that stream’s Twitch or Kick chat, and remounts unmuted
- **Twitch / Kick chat sidebar** (desktop and tablet) that resizes the grid instead of covering players
- **Streams always boot muted** — unmute on focus or from the platform's own player chrome
- **Mostly static deploy** — Twitch and Kick embeds, direct YouTube video URLs, and the app shell itself need no backend. YouTube channel/handle → live lookup, optional Twitch/Kick status metadata, experimental TikTok LIVE playback, and **live watch-party session sync** each use a small same-origin PHP script in `dist/api/` (see [YouTube setup](#youtube-setup), [Twitch setup](#twitch-setup), [Kick setup](#kick-setup), [TikTok LIVE setup](#tiktok-live-setup-experimental), and [Live watch parties](#live-watch-parties) below). No database, no framework, no user accounts.

Inspired by the classic [MultiTwitch](https://github.com/bhamrick/multitwitch) project, rebuilt for modern platforms and maintainability.

### Product direction vs MultistreamGrid

[MultistreamGrid](https://multistreamgrid.com) is a useful reference for fast bare-iframe mounts and SortableJS reorder. MultiStream.cc keeps a different watch UX: **identity lives on each card header** (or in the hover toolbar when headers are hidden). Management affordances (dropdown add, share, clear, drag) sit in the top toolbar and per-card controls; the viewing plane still shows who’s on.

---

## Device compatibility

| Device | Layout | Chat | Notes |
|---|---|---|---|
| **Desktop** (>1024px) | Multi-column grid sized to fit all players in the viewport | Show / hide toggle | Chat docks beside streams; grid reflows (does not overlay video) |
| **Tablet / iPad** (641px–1024px) | Same packing grid; iPad maps Theater to Focus-with-tray | iPad hides both bars and shows a circular close X | Touch-friendly controls; iPad requests screen wake lock while streams are present |
| **Phone** (≤640px) | Single-column scroll | Hidden | Streams stack vertically; toolbar stacks for easy tapping |

Works in modern desktop and mobile browsers (Chrome, Firefox, Safari, Edge). Performance depends on how many live embeds are open — each stream is a full platform player (Twitch/Kick/YouTube iframe, or a TikTok `<video>` feed). Fewer streams = smoother playback, especially on laptops and phones.

---

## Quick start (local dev)

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173/`). Add streams from the toolbar or open a path URL like `/t:username/k:username/y:handle:username/tt:creator`.

### Production build

```bash
npm run build
npm run preview
```

Deploy the `dist/` folder to any static host (Cloudflare Pages, Netlify, Vercel, S3, etc.).

### DreamHost (multistream.cc)

Do **not** upload the whole project folder. DreamHost needs the **built output**:

```bash
npm install
npm run build
```

Upload everything inside **`dist/`** to your domain’s web root (e.g. `multistream.cc/` → `~/multistream.cc/` on DreamHost):

```
dist/
├── index.html
├── assets/
├── api/
│   ├── youtube-resolve.php
│   ├── twitch-status.php
│   ├── kick-status.php
│   ├── kick-webhook.php
│   ├── kick-chat.php
│   ├── tiktok-resolve.php
│   ├── tiktok-avatar.php
│   └── watch-party.php
├── og-image.png
├── robots.txt
├── sitemap.xml
└── .htaccess
```

Steps:

1. Run `npm run build` locally whenever you change the app.
2. In DreamHost File Manager or FTP, open the folder for **multistream.cc**.
3. Upload the **contents** of `dist/` (not the `dist` folder itself) into that root — this now includes all eight files under `api/` (`youtube-resolve.php`, `twitch-status.php`, `kick-status.php`, `kick-webhook.php`, `kick-chat.php`, `tiktok-resolve.php`, `tiktok-avatar.php`, and `watch-party.php`).
4. Confirm `index.html` sits directly in the domain root.
5. Complete the one-time [YouTube setup](#youtube-setup), [Twitch setup](#twitch-setup), and [Kick setup](#kick-setup) below (config files outside the web root) — channel/handle resolution and live-status checks won't work until that's done, but direct video URLs, Twitch/Kick/YouTube embeds, and TikTok LIVE (via `tiktok-resolve.php`, no credentials) all work as soon as `dist/` is uploaded.
6. Visit `https://multistream.cc/` — Twitch embeds will automatically use `multistream.cc` as the `parent` domain.

Path URLs like `/t:username/k:username/y:handle:username/tt:creator` require the included `.htaccess` SPA fallback on Apache/DreamHost.

---

## YouTube setup

Resolving a YouTube handle/username/channel-ID/channel-URL to its current live video needs the YouTube Data API v3, which needs an API key — and an API key must never live in client-side JavaScript. So this one lookup runs server-side, via `public/api/youtube-resolve.php` (deployed as a normal static file alongside the rest of `dist/`, since DreamHost runs PHP natively — no extra hosting, no database, no framework).

**Direct video/Shorts/live/`youtu.be` URLs never need any of this** — they're parsed entirely in the browser.

One-time setup on your DreamHost account, **after** you've uploaded `dist/`:

1. Get a YouTube Data API v3 key from the [Google Cloud Console](https://console.cloud.google.com/) (enable the "YouTube Data API v3" on a project, create an API key).
2. Create a file **outside** the `multistream.cc/` web root — e.g. at `~/multistream-secrets/youtube-config.php` in your DreamHost home directory (sibling to, not inside, `~/multistream.cc/`):
   ```php
   <?php
   return [
       'api_key' => 'YOUR_YOUTUBE_DATA_API_KEY_HERE',
   ];
   ```
3. Open `dist/api/youtube-resolve.php` (before uploading, or edit it directly on the server) and check the `YOUTUBE_CONFIG_PATH`/`YOUTUBE_CACHE_DIR` constants near the top match where you put that file — the default assumes the common `~/<domain>/api/` DreamHost layout (two directories up from the PHP file, i.e. your home directory), but confirm it against your actual account.
4. That's it — no restart needed. The cache directory (`~/multistream-secrets/cache/`) is created automatically on first use; if it can't be created/written, lookups still work, just without caching.

If the key is missing or misconfigured, YouTube channel/handle streams show a clear "isn't configured yet" message in-tile — nothing else on the site is affected.

---

## Twitch setup

Checking whether a Twitch channel exists and whether it's currently live uses the Twitch Helix API, which needs an app access token — and that token flow needs a Client Secret, which must never live in client-side JavaScript. So this check runs server-side too, via `public/api/twitch-status.php` (same deployment story as the YouTube resolver: a normal static file inside `dist/`, no extra hosting).

**This is advisory only.** A missing/misconfigured key, a Twitch API outage, or a network hiccup never blocks anything — the real Twitch embed still mounts and plays normally; you just get a status dot of `unavailable` instead of `live`/`offline`.

### Status states

Each Twitch card shows a small dot next to its name (in the header, and in the hover toolbar when headers are hidden). The header instance also shows, for a live channel, category, viewer count, and "Live for…" duration inline after the platform badge:

| State | Dot | Meaning |
|---|---|---|
| `live` | pulsing red | The account exists and is currently broadcasting. Category, viewer count, and "Live for…" duration are shown when Twitch provides them. |
| `offline` | muted gray | The account exists but isn't currently broadcasting. |
| `not_found` | steady red-orange | Twitch confirms no account exists for that login. |
| `unavailable` | muted gray | Status couldn't be determined (endpoint, credentials, network, Twitch API, or rate limit) — never removes the card or affects the embed. |

The dot's tooltip and accessible label always carry the full text (e.g. "Live · Just Chatting · 12.4K viewers · 2h 14m").

### Refreshing status

Automatic Twitch status checks run every 3 minutes while the tab is open, visible, and online, and once more when you return to a backgrounded tab if the last check is stale — never while the tab is hidden, offline, or if a check is already in progress. Those automatic passes only update the status dot and header meta text; they never reload, remount, or otherwise touch any player or iframe.

The toolbar **Refresh** button is separate and more forceful: it reloads already-loaded stream players and refreshes Twitch, YouTube, and Kick metadata together. Use it when you want players to reconnect after a long session. If an offline channel comes back live, its dot updates on the next status pass, but the embed itself isn't restarted until you hit **Refresh** or the card's own reload control.

### Cache

`public/api/twitch-status.php` caches live lookups for 60 seconds and offline lookups for 3 minutes (channel-existence lookups are cached far longer: 24h if found, 1h if not). The 3-minute automatic interval above is chosen to match that: it's never faster than the offline cache window, and always slower than the live one, so automatic refreshes reliably see fresh data without hammering Twitch's API.

One-time setup on your DreamHost account, **after** you've uploaded `dist/`:

1. Create a Twitch application at the [Twitch Developer Console](https://dev.twitch.tv/console/apps) to get a **Client ID** and **Client Secret**. No OAuth redirect URI or user login is needed — this only ever uses the app-only client-credentials flow, so nobody visiting multistream.cc is asked to log into Twitch.
2. Create a file **outside** the `multistream.cc/` web root — e.g. at `~/multistream-secrets/twitch-config.php`, the same directory `youtube-config.php` already lives in:
   ```php
   <?php
   return [
       'client_id' => 'YOUR_TWITCH_CLIENT_ID_HERE',
       'client_secret' => 'YOUR_TWITCH_CLIENT_SECRET_HERE',
   ];
   ```
3. Open `dist/api/twitch-status.php` (before uploading, or edit it directly on the server) and check the `TWITCH_CONFIG_PATH`/`TWITCH_CACHE_DIR` constants near the top match your account's layout — same `~/<domain>/api/` assumption as the YouTube resolver, and the two scripts share the same cache directory.
4. That's it — no restart needed. If the cache directory can't be created/written, checks still work, just without caching.

If the config is missing or Twitch rejects the credentials, every Twitch card just shows no status badge (an "unavailable" result) rather than any error — the embed itself is completely unaffected.

---

## Kick setup

Checking whether a Kick channel exists, whether it's live, and pulling category/viewer/duration metadata uses Kick's official API via OAuth 2.1 client credentials — same architecture as [Twitch setup](#twitch-setup) above, through `public/api/kick-status.php`.

**This is advisory only.** A missing/misconfigured key, a Kick API outage, or a network hiccup never blocks playback — the real Kick embed still mounts and plays normally; cards just show no status dot or header metadata until a check succeeds.

### Status states

Each Kick card shows the same style of status dot Twitch uses (in the header, and in the hover toolbar when headers are hidden). When live, category, viewer count, and duration appear inline after the platform badge when Kick provides them:

| State | Dot | Meaning |
|---|---|---|
| `live` | pulsing red | The account exists and is currently broadcasting. |
| `offline` | muted gray | The account exists but isn't currently broadcasting. |
| `not_found` | steady red-orange | Kick confirms no account exists for that slug. |
| `unavailable` | muted gray | Status couldn't be determined (endpoint, credentials, network, Kick API, or rate limit) — never removes the card or affects the embed. |

Until credentials are installed, cards render with no status metadata at all — same as before Kick status existed — and the player works normally.

### Refreshing status

The toolbar **Refresh** button re-checks Twitch, YouTube, and Kick metadata in one action, and also reloads any already-loaded stream players. It never reloads the page or changes your lineup. Automatic checks run on the same ~3-minute cadence as Twitch while the tab is open and visible.

One-time setup on your DreamHost account, **after** you've uploaded `dist/`:

1. Create an app at [kick.com/settings/developer](https://kick.com/settings/developer) and copy its **Client ID** and **Client Secret**.
2. Create a file **outside** the `multistream.cc/` web root — e.g. at `~/multistream-secrets/kick-config.php`, the same directory `youtube-config.php` and `twitch-config.php` already live in:
   ```php
   <?php
   return [
       'client_id' => 'YOUR_KICK_CLIENT_ID_HERE',
       'client_secret' => 'YOUR_KICK_CLIENT_SECRET_HERE',
   ];
   ```
3. Open `dist/api/kick-status.php` (before uploading, or edit it directly on the server) and check the `KICK_CONFIG_PATH`/`KICK_CACHE_DIR` constants near the top match your account's layout — same `~/<domain>/api/` assumption as the other resolvers, and the same shared cache directory.
4. That's it for metadata — no restart needed. If the cache directory can't be created/written, checks still work, just without caching.

5. **Kick chat (optional, after the app credentials already work).** In Kick Settings → Developer → the MultiStream.cc app → **Enable Webhooks**, enter:

   `https://multistream.cc/api/kick-webhook.php`

   Chat is real-time via Kick's official `chat.message.sent` event. There is no historical backfill — the panel starts from messages received after the webhook is live. Sending chat from MultiStream is not wired yet (that needs a user/bot OAuth token, not the existing App Access Token).

If the config is missing, every Kick card renders exactly as it did before status metadata existed — no dot, no viewer count, fully working player.

---

## TikTok LIVE setup (experimental)

**Experimental TikTok LIVE** — not an official TikTok integration. Full
architecture, risk, and rollback: [docs/TIKTOK.md](./docs/TIKTOK.md).

Unlike YouTube and Twitch above, **`public/api/tiktok-resolve.php` needs
no credentials and no config file** — it calls an unauthenticated TikTok
endpoint, the same request a logged-out browser makes. Uploading it as
part of `dist/` (see the DreamHost steps above) is the entire setup. It
shares the same `~/multistream-secrets/cache/` directory the YouTube and
Twitch endpoints use — no separate directory to create.

To disable TikTok LIVE without touching anything else, see
[docs/TIKTOK.md § Rollback](./docs/TIKTOK.md#rollback).

### Live watch parties

A **static** share URL (`/t:username/k:username/…`) is a snapshot. A **live watch party** is a room at `/w/ROOM_ID` whose lineup can change while viewers stay on the same link.

**Share → Start Live Watch Party** (or **Share Watch Party**, which starts a party if none is running and copies the `/w/ROOM_ID` link) creates the room (host token stays in this browser’s `localStorage`). Viewers poll `public/api/watch-party.php` every 2 seconds for lineup changes only — MultiStream never rebroadcasts video. **End Watch Party** marks the room ended; it is then kept 24 hours.

While the party runs:

- **Spotlight sync** — the host's view, primary stream, and chat-sidebar visibility are room state. Desktop viewers follow those changes; iPad represents Theater as Focus-with-tray, while phones stay in the single-column grid.
- **Host presence** — the host client heartbeats every 30s while its tab is visible; viewers see a "Host is live" / "Host away" status line. If the host goes silent for 30 minutes the room auto-ends, and viewers land on the same graceful "party has ended — keep watching this lineup" flow as a manual end.
- **Viewer count (host only)** — viewers ping presence at most every 30s; the host's status chip shows "Live watch party · N watching". The count is never exposed on viewer-facing responses.
- **Abuse limits** — per-IP rate limits on create/update/GET plus a hard cap on total active rooms keep the unauthenticated endpoint safe to leave open.

Sessions are JSON files under `~/multistream-secrets/watch-party/` (created automatically, same parent as the resolver cache). No extra config file, no database. PHP must be able to write that directory, same as `~/multistream-secrets/cache/`.

---

## Usage

### Share a layout

Add streams to the URL path, separated by slashes. Use `t:` for Twitch, `k:` for Kick, `y:` for YouTube, and `tt:` for TikTok LIVE (lowercase prefixes):

```
https://multistream.cc/t:username/k:username/y:handle:username/tt:creator
```

Legacy uppercase `T:` / `K:` prefixes and query URLs (`?streams=t:username,k:username`) still work.

Open the toolbar **Share** menu to **Start Live Watch Party** (or **Share Watch Party**, which starts a live `/w/ROOM_ID` party if none is running and copies the link), **Preview Story Card**, or **Download Story Card**. **Clear all** removes every stream (with confirmation). Toolbar actions (Share, Refresh, Clear, Headers, Chat) are icons that expand their labels on hover.

**Hide headers** hides each desktop card’s top bar. At rest the tile is video only; hover (or keyboard focus) shrinks the player slightly so a control strip appears **below** the iframe — channel name, **drag to reorder**, **Theater**, **Focus**, and **×** remove. Controls never stack over the player (Twitch [requirement 1.3](https://dev.twitch.tv/docs/embed/)). Kick embeds re-scale on hover so volume / pause stay inside the smaller box. On iPad, both bars stay hidden and a circular **×** in the video’s top-right corner remains available.

### Add streams from the toolbar

Type a username to open a **Twitch / Kick / YouTube / TikTok LIVE (Experimental)** suggestion dropdown (leading `@` is stripped). Enter on a plain username uses your **last-chosen platform** (saved in `localStorage`). Explicit prefixes and URLs skip the dropdown and add immediately:

| You enter | Result |
|---|---|
| Plain `username` / `@username` + dropdown | Twitch, Kick, YouTube, or TikTok LIVE from the row you click |
| Plain `username` + Enter | Last-used platform |
| `t:username` / `k:username` / `y:username` / `tt:handle` | That platform |
| `twitch.tv/username` / `kick.com/username` | Platform from URL |
| A YouTube video/Shorts/live/`youtu.be` URL | That exact video |
| A YouTube `/@handle`, `/channel/UC…`, or channel URL | That channel's current live stream |
| A TikTok LIVE URL (`tiktok.com/@handle/live`, profile URL, or `vm`/`vt` share link) | Experimental TikTok LIVE for that creator |

Drag a card’s **header** to reorder streams (or the **drag** handle in the hover toolbar when headers are hidden); the path URL updates and players keep playing (DOM move only).

When you return to the site without a share URL in the path, your last lineup is restored from `localStorage`. Opening a link like `/t:username` always uses that URL instead.

### Focus View

**Focus view**, in the toolbar, switches from the packing grid to one large
primary player with the rest of your streams in a horizontal tray below
it. Click a tray stream's **header** (not its buttons) to promote it
to primary — this is a resize only, not a remount, so every player keeps
playing across the swap. **Grid view** switches back. A portrait primary
keeps its own 9:16 shape instead of the fixed 2-row rule Grid View uses
(see below) — it's sized purely by aspect ratio, the same way a landscape
primary is sized by 16:9.

Each card also has its own **Theater** (large primary plus tray) and **Focus**
(solo primary) buttons. **Theater** shows the other streams below; **Focus**
fills the pane with just that one stream. From solo Focus, use **Theater** on
the primary to reveal the tray; from Theater-with-tray, use **Focus** on the
primary to hide it again.

---

## Architecture

Vanilla **TypeScript + Vite** on the frontend — no React. Seven small PHP
endpoints on the server: YouTube channel/handle resolution (see
[YouTube setup](#youtube-setup)), Twitch channel existence/live-status
(see [Twitch setup](#twitch-setup)), Kick live-status/metadata plus official
Kick chat webhook/poll (see [Kick setup](#kick-setup)), the Experimental TikTok LIVE resolver plus
avatar proxy (see [TikTok LIVE setup](#tiktok-live-setup-experimental) and
[docs/TIKTOK.md](docs/TIKTOK.md)); everything else is a static deploy.

```
src/
├── platforms/     # Twitch, Kick, YouTube & (experimental) TikTok adapters
├── state/         # Stream list, chat visibility, headers mode, URL sync
├── components/    # Grid, toolbar, chat, reorder, player cards
├── lib/           # Grid/Focus View layout math, add/remove playback recovery, embed debug logging
└── styles/        # Layout and UI
public/api/        # youtube-resolve.php, twitch-status.php, kick-status.php,
                   # kick-webhook.php, kick-chat.php, tiktok-resolve.php,
                   # tiktok-avatar.php, watch-party.php — the server-side pieces
```

Each platform implements a small adapter:

- `parseInput()` — username, URL, or `t:` / `k:` / `y:` / `tt:` prefix (TikTok accepts full URLs only — see [docs/TIKTOK.md](docs/TIKTOK.md))
- `buildEmbedUrl()` — iframe src with correct embed parameters

YouTube's adapter additionally encodes its structured identity (video vs.
channel, handle/username/channel-ID) into a compact token stored in the same
`channel` field Twitch/Kick already use — no extra state, and channel-type
tokens are resolved to a live video asynchronously at mount time rather than
through `buildEmbedUrl` (which only handles the direct-video case).

---

## Embed notes

- Players must be served over **HTTP(S)** — `file://` will not work.
- **Twitch** uses the official video iframe (`player.twitch.tv/?channel=…`). Embeds must stay **visible and unobscured** (≥400×300, nothing stacked over the iframe) for muted autoplay in Chrome. Hide-headers mode keeps controls in a strip below the player, not on top of it.
- **Twitch** embeds require a matching `parent` domain (injected automatically from `window.location.hostname`).
- **Kick** uses the official iframe embed: `https://player.kick.com/{username}` ([Kick Help Center](https://help.kick.com/en/articles/8010826-how-to-embed-your-kick-livestream)). Documented query params are only `autoplay`, `muted`, and `allowfullscreen` — there is **no separate embed mode** that toggles volume UI on/off.
- **Layout packing** follows MultiTwitch’s `optimize_size` idea: pick the column count and 16:9 size that fits every *landscape* stream in the streams pane. Portrait tiles (9:16) use a separate 2-row rule instead of being squeezed into a partial landscape row — see the portrait bullet below. Chat docks beside the grid and triggers a reflow — it does not cover players (Twitch pauses embeds that are clipped or scrolled off-screen).
- **Portrait tiles (YouTube Shorts, Experimental TikTok LIVE)** always span exactly 2 landscape grid rows in Grid View — not an aspect-ratio-derived fraction — so their bottom edge lines up with the second landscape row regardless of column position. The allocated 2-row box accounts for both the grid gap and each row's header chrome; the video itself is never stretched to fill it — it's letterboxed inside at its true 9:16 shape, centered with side whitespace when the box is wider than the video's own aspect. This is a general `orientation === 'portrait'` rule, not a YouTube-specific one — see [docs/TIKTOK.md](docs/TIKTOK.md) for TikTok LIVE's architecture and risk.
- **Kick volume / control size:** Kick’s embed switches UI by **iframe layout width**. Below **769px** it uses mobile/tablet chrome (tiny overlays, often no volume). At **769px+** it uses desktop chrome with a speaker icon — hover the video, then the speaker, for the volume slider. When the packed cell is narrower than 769px, MultiStream still renders the Kick iframe at ≥769px and **CSS-scales** it into the cell so desktop chrome (including volume) stays available while the grid fits on-screen.
- **Mute on load:** All platforms boot muted. Focus reloads/unmutes the focused stream (user click); exit keeps that stream unmuted. Tab hide / focus-hide pauses or blanks background players depending on platform, and resumes with each card's saved mute preference — **except YouTube**, see below.
- **YouTube** uses the official IFrame Player API (`www.youtube.com/iframe_api`), with a bare-iframe fallback if that script is blocked. Channel/handle inputs resolve to a live `videoId` server-side on every load (see [YouTube setup](#youtube-setup)); direct video/Shorts/live/`youtu.be` URLs resolve locally with no network call. **Autoplay:** YouTube's own policy forbids multiple simultaneously autoplaying embeds, so only the very first YouTube player mounted in a page session ever requests autoplay — every later one (additional adds, focus-exit, tab-resume) stays paused until a real click, either on this app's Focus control or YouTube's own native play button. Embedding-disabled or unavailable videos show a clear in-tile message via the player's `onError` event; an offline channel shows "isn't live right now" rather than loading anything else.
- **TikTok LIVE (experimental)** has no official embed — playback is a plain `<video>` element fed by mpegts.js after `tiktok-resolve.php` returns a temporary CDN URL (see [TikTok LIVE setup](#tiktok-live-setup-experimental)). Every card is marked Experimental. Portrait-only; uses the same 2-row grid rule as YouTube Shorts.
- **Chat** is Twitch-only (Kick, YouTube, and TikTok have no equivalent panel in this app). Hidden on phones.

---

## Social / SEO image

The Open Graph image lives at `public/og-image.png` (used by the site and this README). Meta tags reference `https://multistream.cc/og-image.png`.

---

## Contributing

Issues and PRs welcome. Keep changes focused — this project intentionally stays small.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Credits

- Original inspiration: [bhamrick/multitwitch](https://github.com/bhamrick/multitwitch) by Brian Hamrick
- Developer: [Eric Barker](https://ericbarker.co)
- Studio: [Design Delulu](https://designdelulu.com)
