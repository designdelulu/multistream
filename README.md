# MultiStream.cc

Watch multiple **Twitch** and **Kick** live streams on one page — in a responsive grid that keeps every player as large as possible at 16:9.

![MultiStream.cc — Watch Twitch and Kick streams together](./public/og-image.png)

**Live site:** [multistream.cc](https://multistream.cc)  
**Repository:** [github.com/designdelulu/multistream](https://github.com/designdelulu/multistream)

Built by [Eric Barker](https://ericbarker.co). A product of [Design Delulu](https://designdelulu.com).

---

## What it does

MultiStream.cc is a lightweight browser viewer for multi-stream watch parties, co-stream monitoring, and tournament weekends. Add channels from the toolbar or share a URL with your lineup already configured.

- **Twitch + Kick** on the same page
- **Responsive grid** that scales players while preserving aspect ratio
- **Shareable path URLs** like `/t:username/k:username`
- **Mute / remove** controls per stream
- **Twitch chat sidebar** (desktop and tablet)
- **No backend required** — static deploy, iframe embeds only

Inspired by the classic [MultiTwitch](https://github.com/bhamrick/multitwitch) project, rebuilt for modern platforms and maintainability.

---

## Device compatibility

| Device | Layout | Chat | Notes |
|---|---|---|---|
| **Desktop** (>1024px) | Multi-column grid (1–4 columns by stream count) | Show / hide toggle | Best experience for 2+ streams |
| **Tablet / iPad** (641px–1024px) | Multi-column grid | Show / hide toggle | Touch-friendly controls; chat panel slightly narrower |
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
├── og-image.png
├── robots.txt
├── sitemap.xml
└── .htaccess
```

Steps:

1. Run `npm run build` locally whenever you change the app.
2. In DreamHost File Manager or FTP, open the folder for **multistream.cc**.
3. Upload the **contents** of `dist/` (not the `dist` folder itself) into that root.
4. Confirm `index.html` sits directly in the domain root.
5. Visit `https://multistream.cc/` — Twitch embeds will automatically use `multistream.cc` as the `parent` domain.

Path URLs like `/t:username/k:username` require the included `.htaccess` SPA fallback on Apache/DreamHost.

---

## Usage

### Share a layout

Add streams to the URL path, separated by slashes. Use `t:` for Twitch and `k:` for Kick (lowercase prefixes):

```
https://multistream.cc/t:username/t:username/t:username/k:username/k:username/k:username
```

Legacy uppercase `T:` / `K:` prefixes and query URLs (`?streams=t:username,k:username`) still work.

### Add streams from the toolbar

Enter one stream at a time — a username, platform prefix, or full channel URL:

| You enter | Result |
|---|---|
| `t:username` | Twitch channel |
| `k:username` | Kick channel |
| `twitch.tv/username` | Twitch from URL |
| `kick.com/username` | Kick from URL |
| `username` | Twitch (plain username) |

The gray hint below the input shows an example multi-stream path: `multistream.cc/t:username/t:username/t:username/k:username/k:username/k:username`.

---

## Architecture

Vanilla **TypeScript + Vite** — no React, no server.

```
src/
├── platforms/     # Twitch & Kick adapters (parse input, build embed URLs)
├── state/         # Stream list, chat visibility, URL sync
├── components/    # Grid, toolbar, chat panel, player cards
├── lib/           # Lazy iframe loading, viewport helpers
└── styles/        # Layout and UI
```

Each platform implements a small adapter:

- `parseInput()` — username, URL, or `t:` / `k:` prefix
- `buildEmbedUrl()` — iframe src with correct embed parameters

Adding a third platform later means adding one adapter file and registering it — no changes to the grid or state layer.

---

## Embed notes

- Players must be served over **HTTP(S)** — `file://` will not work.
- **Twitch** embeds require a matching `parent` domain (injected automatically from `window.location.hostname`).
- **Kick** has one official embed: `https://player.kick.com/{username}` ([Kick Help Center](https://help.kick.com/en/articles/8010826-how-to-embed-your-kick-livestream)). Documented query params are only `autoplay`, `muted`, and `allowfullscreen` — there is **no separate embed mode** that toggles volume UI on/off.
- MultiStream uses the same Kick URL as the first public commit: `?autoplay=true&muted=true`, with `src` set immediately on the iframe (Kick is not lazy-loaded).
- **Kick volume slider** lives inside Kick’s player chrome (hover the video). MultiStream’s header **Mute / Unmute** only flips the `muted=` query param. If the player iframe is too short (layout bug), Kick switches to a compact UI and the slider disappears — that was a sizing regression in our CSS, not a different Kick embed type.
- **Mute/unmute** reloads only the affected iframe. Cross-origin players do not expose volume APIs to the parent page.
- **Chat** is Twitch-only (Kick has no official chat embed). Hidden on phones.

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
