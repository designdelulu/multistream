# MultiStream.cc — User guide

Watch Twitch, Kick, YouTube, and experimental TikTok LIVE on one page. MultiStream.cc is a modern multi-stream viewer — this guide covers the features and how to use them.

**Live site:** [multistream.cc](https://multistream.cc)

---

## Features at a glance

| Feature | What it does |
|---|---|
| Multi-platform grid | Twitch, Kick, and YouTube via official embeds; experimental TikTok LIVE via resolver + `<video>` player |
| Username dropdown | Type a name (or `@name`) and choose Twitch, Kick, YouTube, or TikTok LIVE (Experimental) |
| Share menu | Copy Watch URL, preview or download a Story Card image, or share a watch-party link |
| Clear all | Remove every stream (with confirmation) |
| Hide headers | Compact grid; hover a card to reveal controls below the video (never over it) |
| Drag reorder | Drag card headers — or the drag handle in the hover toolbar when headers are hidden |
| Focus (headers hidden) | Magnifying glass in the hover toolbar |
| Session restore | Last lineup saved in `localStorage`; share URLs in the path take priority |
| Focus mode | Expand one stream, unmute it, open Twitch or Kick chat when available |
| Focus View | Toolbar toggle: large primary + a tray of the rest; click a tray stream's header to promote it, no remount |
| Portrait streams (Shorts, TikTok LIVE) | Get their own 2-row-tall grid slot in Grid View, letterboxed to true 9:16 — never stretched |
| Twitch / Kick chat | Docked sidebar on desktop/tablet (YouTube has no equivalent panel) |
| Muted by default | Every stream boots muted; unmute via focus or the player's own controls |
| Twitch + Kick status | Live/offline/not-found/unavailable dot plus category/viewers/duration when live; refreshed automatically and via toolbar **Refresh** |

---

## Adding streams

1. Click the username field in the toolbar.
2. Type a channel name. A dropdown offers **Twitch**, **Kick**, **YouTube**, and **TikTok LIVE (Experimental)**.
3. Click a row to add that platform, or use **ArrowDown** / **ArrowUp** to highlight one and press **Enter**. Plain usernames require that explicit pick — **Enter** alone only works for URLs and `t:` / `k:` / `y:` / `tt:` prefixes.
4. You can also paste a Twitch/Kick/YouTube URL, a TikTok LIVE URL, or use `t:username` / `k:username` / `y:…` / `tt:handle`.

Leading `@` is stripped automatically.

**Add Stream** stays as a text button. Share, Refresh, Clear, Headers, and Chat are icons that show their labels on hover.

### YouTube

YouTube accepts more input shapes than Twitch/Kick, since a channel and a video are different things there:

- A direct video URL (`youtube.com/watch?v=…`, `youtu.be/…`, `/live/…`, `/shorts/…`) loads exactly that video.
- A handle (`@name` or `name`), legacy username, channel ID, or channel URL loads that channel's **current live stream** — resolved fresh on each page load, never a cached recording. If the channel isn't live right now, the card says so clearly instead of loading something else.
- Only the **first** YouTube player on the page autoplays (muted). Every other YouTube player waits for you to press play — this is a YouTube platform rule, not a MultiStream limitation, and it applies even after adding/removing streams or returning to the tab.

### Experimental TikTok LIVE

TikTok is **not** an official embed integration. Pick **TikTok LIVE (Experimental)** from the suggestion dropdown, paste a full TikTok URL — profile URL, `/@handle/live`, or a mobile `vm.tiktok.com` / `vt.tiktok.com` share link — or use a share URL token like `tt:handle`.

Each TikTok card is marked **Experimental**. Playback uses a resolver + `<video>` element rather than an iframe. See [docs/TIKTOK.md](./TIKTOK.md) for architecture and rollback.

---

## Watching the grid

- Streams fill a responsive grid that keeps every player as large as possible.
- Each card shows a platform badge and username on the header (or in the hover toolbar when headers are hidden — the default).
- Drag a card's **header** to reorder (or the **drag** handle in the hover toolbar when headers are hidden). Playback continues — players are not remounted.
- Use **×** to remove a stream (header button, or **×** in the hover toolbar). In focus mode, × minimizes back to the grid first.
- A **portrait stream** (a YouTube Short or TikTok LIVE) always takes up the height of 2 landscape rows in its column — not a partial row — so it never leaves an oddly-sized gap next to the streams beside it. The video itself keeps its real 9:16 shape inside that space; it's never stretched wider or squeezed to fill the box. On a phone-width screen, where the grid is a single column anyway, a portrait stream instead gets its own full-width row sized to its real 9:16 shape.

### Focus View

The toolbar's **Focus view** / **Grid view** button switches the whole
layout between the packing grid and one large primary player with the rest
of your streams in a tray underneath it. Click a tray stream's **header**
(not its buttons — the video itself is a separate embed and can't be
clicked to promote) to swap it into the primary spot — nothing reloads,
so playback never interrupts. This is a different control from
the per-card **Focus** below (the magnifying glass) — Focus View changes
the whole page's layout, while a single card's Focus expands just that
one stream and opens its chat.

### Focus

- Click the expand (focus) control on a card (header button, or magnifying glass in no-header mode).
- That stream fills the area below the toolbar and reloads **unmuted**.
- Twitch or Kick chat opens automatically for the focused stream.
- In no-header mode, the focused stream's **header bar reappears** so you can × minimize.
- Press **Escape** or × / focus again to exit. The focused stream **stays unmuted**; other streams resume with their previous mute state.

### Hide headers

- Toolbar **Show headers** / **Hide headers** toggles card top bars (preference is remembered; headers shown by default).
- At rest the card is **video only**. Hover the card and the player shrinks slightly so a control strip appears **below** the iframe (name, drag, focus, remove) — never stacked over the embed (Twitch requirement 1.3). Kick embeds re-scale on hover so volume / pause stay inside the smaller player.
- This avoids Chrome pause-on-overlay and the mute-control refresh loop from remounting embeds.

### Twitch and Kick status

Twitch and Kick cards show a small status dot next to the channel name — pulsing red for **live**, muted gray for **offline**, red-orange for **not found**, muted gray for **unavailable** (MultiStream couldn't check right now). When live, the header also shows category, viewer count, and duration when the platform provides them.

Automatic status checks run every few minutes while the tab is open and visible; they pause while the tab is in the background. A status failure never affects playback — the video keeps working normally either way.

The toolbar **Refresh** button reloads already-loaded stream players and refreshes Twitch, YouTube, and Kick metadata together. Use it when you want players to reconnect after a long session; automatic timers never reload players on their own.

---

## Sharing a lineup

There are two share modes:

### Static share

A snapshot of the current lineup. The URL does not change later if you add or remove streams.

1. Add the streams you want.
2. Open the toolbar **Share** menu and choose **Copy Watch URL**.
3. Anyone opening that URL gets that exact lineup.

You can also build static URLs by hand:

```
https://multistream.cc/t:username/k:username/y:handle:username/tt:creator
```

- `t:` = Twitch, `k:` = Kick, `y:` = YouTube, `tt:` = TikTok LIVE (lowercase preferred; uppercase still works for `t:`/`k:`)
- Legacy query form: `?streams=t:username,k:username`

### Live watch party

A persistent room. Viewers who open the party link see your current lineup, and it updates automatically when you add, remove, replace, or rearrange streams. Video is not rebroadcast — each viewer still loads Twitch/Kick/YouTube/TikTok directly.

1. Add the streams you want.
2. Open **Share → Start Live Watch Party**. The live link (`https://multistream.cc/w/ROOM_ID`) is copied for you.
3. Use **Copy Live Party Link** or **Share Watch Party** to send that same room URL.
4. **End Watch Party** when you are done. Viewers keep the last lineup as a normal static page.

Only the host can change the shared lineup. Host control is stored in this browser (`localStorage`); refresh keeps you in control of the same room. Viewers cannot add, remove, or drag streams.

Viewer pages check for lineup changes about every 2 seconds. A room stays available for 7 days after the last host update (24 hours after it is ended).

The rest of the Share menu is unchanged:

- **Preview Story Card** — full-screen preview of a shareable lineup image (players keep playing behind the dimmed backdrop)
- **Download Story Card** — saves that image as a PNG
- **Share Watch Party** — native share sheet when available (live party link if a party is active, otherwise the current page URL)

If you close the tab and come back to the home page without a path URL, your last lineup is restored automatically. Static share URLs always win when the path includes streams. A `/w/ROOM_ID` live-party URL wins over both.

---

## Chat

- Available for **Twitch** streams on desktop and tablet.
- Toggle with the chat icon in the toolbar.
- Chat docks beside the grid and resizes players — it does not cover them (covering would pause Twitch embeds).
- Hidden on phones.

---

## Devices

| Device | Layout | Chat |
|---|---|---|
| Desktop | Multi-column packing grid | Show / hide |
| Tablet | Same grid, slightly narrower chat | Show / hide |
| Phone | Single-column scroll | Hidden |

On a phone, streams stack in a single column. About three 16:9 streams fit on screen at once; scroll to move between them. Twitch may need a moment on-screen before video fully plays.

Performance depends on how many live embeds are open. Fewer streams = smoother playback.

---

## Tips

- Start muted — browsers block unmuted autoplay.
- Focus a stream when you want sound quickly.
- Hide headers for tournaments or dense watch parties; hover a card for the toolbar below each video (focus, remove, drag).
- Clear all when starting a fresh layout.
- Kick's volume UI needs a wide player; MultiStream scales Kick embeds so desktop chrome stays available when cells are narrow.
- Story Card preview is overlay-only — opening or closing it should not restart your streams.

### Debugging embed remounts (optional)

Only if streams keep stopping and you want to see why:

1. Add `?debug=embeds` to the URL and reload.
2. Open the browser console (right-click → Inspect → Console).
3. When a stream stops, look for lines starting with `[embed-debug]`.
4. Tell me the **reason** field (e.g. `tab-freeze`, `headers-recover`). That's enough.

Turn it off later with `?debug=off`. You don't need this for normal use — safe stability patches are already in the app.

---

## More for developers

See [README.md](../README.md) for local setup, deploy notes (including DreamHost), and embed technical details.
