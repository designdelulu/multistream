# MultiStream.cc

Watch **Twitch**, **Kick**, and **YouTube** streams online on one page — a responsive grid that keeps every player as large as possible at 16:9.

![MultiStream.cc — Watch Twitch and Kick streams online](./public/og-image.png)

**Live site:** [multistream.cc](https://multistream.cc)  
**Repository:** [github.com/designdelulu/multistream](https://github.com/designdelulu/multistream)

Built by [Eric Barker](https://ericbarker.co). A product of [Design Delulu](https://designdelulu.com).

**User guide:** [docs/USER-GUIDE.md](./docs/USER-GUIDE.md) — features and how to use the site.

---

## What it does

MultiStream.cc is a modern multi-stream viewer for Twitch and Kick — watch parties, co-stream monitoring, and tournament weekends. Add channels from the toolbar or share a URL with your lineup already configured.

- **Twitch + Kick + YouTube** on the same page via official embeds (same approach as [MultistreamGrid](https://multistreamgrid.com))
- **YouTube channels resolve to whatever's live right now** — a handle, username, channel ID, or channel URL is checked server-side on each load; a direct video/Shorts/live URL loads exactly that video, no lookup needed
- **Responsive grid** that packs every player on-screen at the largest 16:9 size (MultiTwitch-style)
- **On-card identity** — platform badge + username on every player header (who’s broadcasting stays visible in the viewing plane)
- **Username dropdown** — type a name (or `@name`) and pick Twitch or Kick; Enter uses your last-chosen platform
- **Share link / Clear all** in the toolbar
- **Hide headers** — headers are shown by default (remembered in `localStorage` once toggled); in compact mode each card is video-only at rest, and hovering a card opens a toolbar **below** the embed (name, drag, focus, remove) so Twitch is never obscured
- **Drag to reorder** stream cards (drag the card header, or the drag handle in the hover toolbar when headers are hidden); URL updates without remounting players
- **Session restore** — your lineup is saved in `localStorage` and restored when you return without a share URL (URL path always wins when present)
- **Shareable path URLs** like `/t:username/k:username`
- **× close** and **focus** controls per stream — focus fills the area below the toolbar, opens that stream’s Twitch chat, and remounts unmuted (Kick has no chat panel)
- **Twitch chat sidebar** (desktop and tablet) that resizes the grid instead of covering players
- **Streams always boot muted** — unmute on focus or from the platform's own player chrome
- **Static deploy for everything except one thing** — direct video URLs, and all of Twitch/Kick, need no backend at all. Resolving a YouTube handle/channel to its current live video needs a small server-side PHP endpoint (API keys can't live in client JS) — see [YouTube setup](#youtube-setup) below.

Inspired by the classic [MultiTwitch](https://github.com/bhamrick/multitwitch) project, rebuilt for modern platforms and maintainability.

### Product direction vs MultistreamGrid

[MultistreamGrid](https://multistreamgrid.com) is a useful reference for fast bare-iframe mounts and SortableJS reorder. MultiStream.cc keeps a different watch UX: **identity lives on each card header** (or in the hover toolbar when headers are hidden). Management affordances (dropdown add, share, clear, drag) sit in the top toolbar and per-card controls; the viewing plane still shows who’s on.

---

## Device compatibility

| Device | Layout | Chat | Notes |
|---|---|---|---|
| **Desktop** (>1024px) | Multi-column grid sized to fit all players in the viewport | Show / hide toggle | Chat docks beside streams; grid reflows (does not overlay video) |
| **Tablet / iPad** (641px–1024px) | Same packing grid | Show / hide toggle | Touch-friendly controls; chat panel slightly narrower |
| **Phone** (≤640px) | Single-column scroll | Hidden | Streams stack vertically; toolbar stacks for easy tapping |

Works in modern desktop and mobile browsers (Chrome, Firefox, Safari, Edge). Performance depends on how many live embeds are open — each stream is a full Twitch or Kick player. Fewer streams = smoother playback, especially on laptops and phones.

---

## Quick start (local dev)

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173/`). Add streams from the toolbar or open a path URL like `/t:username/k:username`.

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
│   └── twitch-status.php
├── og-image.png
├── robots.txt
├── sitemap.xml
└── .htaccess
```

Steps:

1. Run `npm run build` locally whenever you change the app.
2. In DreamHost File Manager or FTP, open the folder for **multistream.cc**.
3. Upload the **contents** of `dist/` (not the `dist` folder itself) into that root — this now includes `api/youtube-resolve.php` and `api/twitch-status.php`.
4. Confirm `index.html` sits directly in the domain root.
5. Complete the one-time [YouTube setup](#youtube-setup) and [Twitch setup](#twitch-setup) below (both are config files outside the web root) — channel/handle resolution and live-status checks won't work until that's done, but direct video URLs and the Twitch/Kick/YouTube embeds themselves all work without it.
6. Visit `https://multistream.cc/` — Twitch embeds will automatically use `multistream.cc` as the `parent` domain.

Path URLs like `/t:username/k:username/y:handle:username` require the included `.htaccess` SPA fallback on Apache/DreamHost.

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

**Refresh Twitch statuses**, in the toolbar, re-checks every Twitch card's status in one batched request. It only ever updates the status dot and header meta text — it never reloads, remounts, or otherwise touches any player or iframe. If an offline channel comes back live, its dot updates immediately, but the embed itself isn't restarted; use the card's own reload control if you want to actually (re)connect to the now-live stream.

The same check also runs automatically every 3 minutes while the tab is open, visible, and online, and once more when you return to a backgrounded tab if the last check is stale — never while the tab is hidden, offline, or if a check is already in progress.

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

## Usage

### Share a layout

Add streams to the URL path, separated by slashes. Use `t:` for Twitch and `k:` for Kick (lowercase prefixes):

```
https://multistream.cc/t:username/t:username/t:username/k:username/k:username/k:username
```

Legacy uppercase `T:` / `K:` prefixes and query URLs (`?streams=t:username,k:username`) still work.

Use **Share link** in the toolbar to copy the current URL. **Clear all** removes every stream (with confirmation). Toolbar actions (Share, Clear, Headers, Chat) are icons that expand their labels on hover.

**Hide headers** collapses each card’s top bar for a denser grid. At rest you see **video only**. Hover a card and the player shrinks slightly so a control strip opens **below** the iframe — channel name, **drag to reorder**, magnifying-glass **Focus**, and **×** remove. Controls never stack over the embed (Twitch [requirement 1.3](https://dev.twitch.tv/docs/embed/)).

### Add streams from the toolbar

Type a username to open a Twitch / Kick dropdown (leading `@` is stripped). Enter on a plain username uses your **last-chosen platform** (saved in `localStorage`). Explicit prefixes and URLs skip the dropdown and add immediately:

| You enter | Result |
|---|---|
| Plain `username` / `@username` + dropdown | Twitch, Kick, or YouTube from the row you click |
| Plain `username` + Enter | Last-used platform |
| `t:username` / `k:username` / `y:username` | That platform |
| `twitch.tv/username` / `kick.com/username` | Platform from URL |
| A YouTube video/Shorts/live/`youtu.be` URL | That exact video |
| A YouTube `/@handle`, `/channel/UC…`, or channel URL | That channel's current live stream |

Drag a card’s **header** to reorder streams (or the **drag** handle in the hover toolbar when headers are hidden); the path URL updates and players keep playing (DOM move only).

When you return to the site without a share URL in the path, your last lineup is restored from `localStorage`. Opening a link like `/t:username` always uses that URL instead.

---

## Architecture

Vanilla **TypeScript + Vite** on the frontend — no React. Two small PHP
endpoints on the server: YouTube channel/handle resolution (see
[YouTube setup](#youtube-setup)) and Twitch channel existence/live-status
(see [Twitch setup](#twitch-setup)); everything else is a static deploy.

```
src/
├── platforms/     # Twitch, Kick & YouTube adapters (parse input, build embed URLs)
├── state/         # Stream list, chat visibility, headers mode, URL sync
├── components/    # Grid, toolbar, chat, reorder, player cards
├── lib/           # Viewport helpers
└── styles/        # Layout and UI
public/api/        # youtube-resolve.php + twitch-status.php — the server-side pieces
```

Each platform implements a small adapter:

- `parseInput()` — username, URL, or `t:` / `k:` / `y:` prefix
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
- **Layout packing** follows MultiTwitch’s `optimize_size` idea: pick the column count and 16:9 size that fits *every* stream in the streams pane. Chat docks beside the grid and triggers a reflow — it does not cover players (Twitch pauses embeds that are clipped or scrolled off-screen).
- **Kick volume / control size:** Kick’s embed switches UI by **iframe layout width**. Below **769px** it uses mobile/tablet chrome (tiny overlays, often no volume). At **769px+** it uses desktop chrome with a speaker icon — hover the video, then the speaker, for the volume slider. When the packed cell is narrower than 769px, MultiStream still renders the Kick iframe at ≥769px and **CSS-scales** it into the cell so desktop chrome (including volume) stays available while the grid fits on-screen.
- **Mute on load:** All platforms boot muted. Focus reloads/unmutes the focused stream (user click); exit keeps that stream unmuted. Tab hide / focus-hide pauses or blanks background players depending on platform, and resumes with each card's saved mute preference — **except YouTube**, see below.
- **YouTube** uses the official IFrame Player API (`www.youtube.com/iframe_api`), with a bare-iframe fallback if that script is blocked. Channel/handle inputs resolve to a live `videoId` server-side on every load (see [YouTube setup](#youtube-setup)); direct video/Shorts/live/`youtu.be` URLs resolve locally with no network call. **Autoplay:** YouTube's own policy forbids multiple simultaneously autoplaying embeds, so only the very first YouTube player mounted in a page session ever requests autoplay — every later one (additional adds, focus-exit, tab-resume) stays paused until a real click, either on this app's Focus control or YouTube's own native play button. Embedding-disabled or unavailable videos show a clear in-tile message via the player's `onError` event; an offline channel shows "isn't live right now" rather than loading anything else.
- **Chat** is Twitch-only (Kick and YouTube have no equivalent panel in this app). Hidden on phones.

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
