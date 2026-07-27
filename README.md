# MultiStream.cc

Watch **Twitch** and **Kick** streams online on one page — a responsive grid that keeps every player as large as possible at 16:9.

![MultiStream.cc — Watch Twitch and Kick streams online](./public/og-image.png)

**Live site:** [multistream.cc](https://multistream.cc)  
**Repository:** [github.com/designdelulu/multistream](https://github.com/designdelulu/multistream)

Built by [Eric Barker](https://ericbarker.co). A product of [Design Delulu](https://designdelulu.com).

**User guide:** [docs/USER-GUIDE.md](./docs/USER-GUIDE.md) — features and how to use the site.

---

## What it does

MultiStream.cc is a lightweight browser viewer for multi-stream watch parties, co-stream monitoring, and tournament weekends. Add channels from the toolbar or share a URL with your lineup already configured.

- **Twitch + Kick** on the same page via plain embed iframes (same approach as [MultistreamGrid](https://multistreamgrid.com))
- **Responsive grid** that packs every player on-screen at the largest 16:9 size (MultiTwitch-style)
- **On-card identity** — platform badge + username on every player header (who’s broadcasting stays visible in the viewing plane)
- **Username dropdown** — type a name (or `@name`) and pick Twitch or Kick; Enter uses your last-chosen platform
- **Share link / Clear all** in the toolbar
- **Hide headers** — optional compact mode (remembered in `localStorage`); at rest each card is video-only; hover a card and a toolbar opens **below** the embed (name, drag, focus, remove) so Twitch is never obscured
- **Drag to reorder** stream cards (drag the card header, or the drag handle in the hover toolbar when headers are hidden); URL updates without remounting players
- **Session restore** — your lineup is saved in `localStorage` and restored when you return without a share URL (URL path always wins when present)
- **Shareable path URLs** like `/t:username/k:username`
- **× close** and **focus** controls per stream — focus fills the area below the toolbar, opens that stream’s Twitch chat, and remounts unmuted (Kick has no chat panel)
- **Twitch chat sidebar** (desktop and tablet) that resizes the grid instead of covering players
- **Streams always boot muted** — unmute on focus or from the Twitch/Kick player chrome
- **No backend required** — static deploy, official embeds only

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

Use **Share link** in the toolbar to copy the current URL. **Clear all** removes every stream (with confirmation). Toolbar actions (Share, Clear, Headers, Chat) are icons that expand their labels on hover.

**Hide headers** collapses each card’s top bar for a denser grid. At rest you see **video only**. Hover a card and the player shrinks slightly so a control strip opens **below** the iframe — channel name, **drag to reorder**, magnifying-glass **Focus**, and **×** remove. Controls never stack over the embed (Twitch [requirement 1.3](https://dev.twitch.tv/docs/embed/)). Live viewer counts beside names are planned for a follow-up.

### Add streams from the toolbar

Type a username to open a Twitch / Kick dropdown (leading `@` is stripped). Enter on a plain username uses your **last-chosen platform** (saved in `localStorage`). Explicit prefixes and URLs skip the dropdown and add immediately:

| You enter | Result |
|---|---|
| Plain `username` / `@username` + dropdown | Twitch or Kick from the row you click |
| Plain `username` + Enter | Last-used platform |
| `t:username` / `k:username` | That platform |
| `twitch.tv/username` / `kick.com/username` | Platform from URL |

Drag a card’s **header** to reorder streams (or the **drag** handle in the hover toolbar when headers are hidden); the path URL updates and players keep playing (DOM move only).

When you return to the site without a share URL in the path, your last lineup is restored from `localStorage`. Opening a link like `/t:username` always uses that URL instead.

---

## Architecture

Vanilla **TypeScript + Vite** — no React, no server.

```
src/
├── platforms/     # Twitch & Kick adapters (parse input, build embed URLs)
├── state/         # Stream list, chat visibility, headers mode, URL sync
├── components/    # Grid, toolbar, chat, reorder, player cards
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
- **Twitch** uses the official video iframe (`player.twitch.tv/?channel=…`). Embeds must stay **visible and unobscured** (≥400×300, nothing stacked over the iframe) for muted autoplay in Chrome. Hide-headers mode keeps controls in a strip below the player, not on top of it.
- **Twitch** embeds require a matching `parent` domain (injected automatically from `window.location.hostname`).
- **Kick** uses the official iframe embed: `https://player.kick.com/{username}` ([Kick Help Center](https://help.kick.com/en/articles/8010826-how-to-embed-your-kick-livestream)). Documented query params are only `autoplay`, `muted`, and `allowfullscreen` — there is **no separate embed mode** that toggles volume UI on/off.
- **Layout packing** follows MultiTwitch’s `optimize_size` idea: pick the column count and 16:9 size that fits *every* stream in the streams pane. Chat docks beside the grid and triggers a reflow — it does not cover players (Twitch pauses embeds that are clipped or scrolled off-screen).
- **Kick volume / control size:** Kick’s embed switches UI by **iframe layout width**. Below **769px** it uses mobile/tablet chrome (tiny overlays, often no volume). At **769px+** it uses desktop chrome with a speaker icon — hover the video, then the speaker, for the volume slider. When the packed cell is narrower than 769px, MultiStream still renders the Kick iframe at ≥769px and **CSS-scales** it into the cell so desktop chrome (including volume) stays available while the grid fits on-screen.
- **Mute on load:** Both platforms boot muted. Focus reloads the focused stream unmuted (user click); exit remounts Twitch muted. Tab hide / focus-hide blanks background iframes and remounts muted on resume.
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
