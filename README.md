# MultiStream.cc

Watch **Twitch** and **Kick** streams online on one page — a responsive grid that keeps every player as large as possible at 16:9.

![MultiStream.cc — Watch Twitch and Kick streams online](./public/og-image.png)

**Live site:** [multistream.cc](https://multistream.cc)  
**Repository:** [github.com/designdelulu/multistream](https://github.com/designdelulu/multistream)

Built by [Eric Barker](https://ericbarker.co). A product of [Design Delulu](https://designdelulu.com).

---

## What it does

MultiStream.cc is a lightweight browser viewer for multi-stream watch parties, co-stream monitoring, and tournament weekends. Add channels from the toolbar or share a URL with your lineup already configured.

- **Twitch + Kick** on the same page
- **Responsive grid** that packs every player on-screen at the largest 16:9 size (MultiTwitch-style)
- **Shareable path URLs** like `/t:username/k:username`
- **× close** and **focus** controls per stream — focus fills the browser window below the toolbar and opens that stream’s Twitch chat (Kick has no chat panel)
- **Twitch chat sidebar** (desktop and tablet) that resizes the grid instead of covering players
- **Streams always boot muted** — unmute from the Twitch/Kick player chrome
- **No backend required** — static deploy, iframe embeds only

Inspired by the classic [MultiTwitch](https://github.com/bhamrick/multitwitch) project, rebuilt for modern platforms and maintainability.

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

Use the **Twitch / Kick** toggle, then enter a username (or paste a full URL / `t:` / `k:` prefix):

| You enter | Result |
|---|---|
| Plain `username` + Twitch selected | Twitch channel |
| Plain `username` + Kick selected | Kick channel |
| `t:username` / `k:username` | That platform (overrides toggle) |
| `twitch.tv/username` / `kick.com/username` | Platform from URL |

The gray hint under the toolbar shows an example multi-stream path:
`multistream.cc/t:username/t:username/t:username/k:username/k:username/k:username`.

---

## Architecture

Vanilla **TypeScript + Vite** — no React, no server.

```
src/
├── platforms/     # Twitch & Kick adapters (parse input, build embed URLs)
├── state/         # Stream list, chat visibility, URL sync
├── components/    # Grid, toolbar, chat panel, player cards
├── lib/           # Viewport helpers
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
- **Layout packing** follows MultiTwitch’s `optimize_size` idea: pick the column count and 16:9 size that fits *every* stream in the streams pane. Chat docks beside the grid and triggers a reflow — it does not cover players (Twitch pauses embeds that are clipped or scrolled off-screen).
- **Kick volume / control size:** Kick’s embed switches UI by **iframe layout width**. Below **769px** it uses mobile/tablet chrome (tiny overlays, often no volume). At **769px+** it uses desktop chrome with a speaker icon — hover the video, then the speaker, for the volume slider. When the packed cell is narrower than 769px, MultiStream still renders the Kick iframe at ≥769px and **CSS-scales** it into the cell so desktop chrome (including volume) stays available while the grid fits on-screen.
- **Mute on load:** every embed boots with `muted=true`. Twitch honors this reliably. Kick sometimes ignores `muted` after the page has autoplay permission (e.g. after dismissing the welcome modal), so Kick iframes omit `allow=autoplay` and use `credentialless` where supported so the browser can block unmuted autoplay / blank Kick volume storage. Use each platform’s own player controls for volume after load.
- Cross-origin players do not expose volume APIs to the parent page.
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
