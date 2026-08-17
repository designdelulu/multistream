# MultiStream.cc — User guide

Watch Twitch, Kick, YouTube, and experimental TikTok LIVE on one page — or start a **Live Watch Party** and share one link so viewers automatically follow your lineup as you change streams. MultiStream.cc is a modern multi-stream viewer — this guide covers the features and how to use them.

**Live site:** [multistream.cc](https://multistream.cc)

---

## Features at a glance

| Feature | What it does |
|---|---|
| Multi-platform grid | Twitch, Kick, and YouTube via official embeds; experimental TikTok LIVE via resolver + `<video>` player |
| Username dropdown | Type a name (or `@name`) and choose Twitch, Kick, YouTube, or TikTok LIVE (Experimental) |
| Share menu | **Start Live Watch Party** / **Share Watch Party** (live `/w/ROOM_ID`; starts a party if needed and copies the link), Story Card preview/download |
| Clear all | Remove every stream (with confirmation) |
| Hide headers | Compact grid with a fixed control footer below every video (never over it) |
| Drag reorder | Drag card headers — or the drag handle in the compact footer |
| Theater | Per-card button opens that stream as the primary |
| Session restore | Last lineup, view mode, and selected primary saved in `localStorage` |
| Focus mode | Expand one stream, unmute it, open Twitch or Kick chat when available |
| Focus View | Toolbar toggle: large primary + a tray of the rest; click a tray stream's header to promote it — unmutes the new primary and mutes the former one (Theater mode only) |
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

Leading `@` is stripped automatically. Dotted handles such as `yonna.jay` are accepted and the dropdown shows only providers whose username rules support the value.

**Add Stream** stays as a text button. Share, Refresh, Clear, Headers, and Chat are icons that show their labels on hover.

### YouTube

YouTube accepts more input shapes than Twitch/Kick, since a channel and a video are different things there:

- A direct video URL (`youtube.com/watch?v=…`, `youtu.be/…`, `/live/…`, `/shorts/…`) loads exactly that video.
- A handle (`@name` or `name`), legacy username, channel ID, or channel URL loads that channel's **current live stream** — resolved fresh on each page load, never a cached recording. If the channel isn't live right now, the card says so clearly instead of loading something else.
- Only the **first** YouTube player on the page autoplays (muted). Every other YouTube player waits for you to press play — this is a YouTube platform rule, not a MultiStream limitation, and it applies even after adding/removing streams or returning to the tab.

### Experimental TikTok LIVE

TikTok is **not** an official embed integration. Pick **TikTok LIVE (Experimental)** from the suggestion dropdown, paste a full TikTok URL — profile URL, `/@handle/live`, or a mobile `vm.tiktok.com` / `vt.tiktok.com` share link — or use a share URL token like `tt:handle`.

Each TikTok card is marked **Experimental**. Playback uses a resolver + `<video>` element rather than an iframe. The resolver prefers standard streams, falls back to HEVC when needed, and retries a transient live-without-URLs response once. See [docs/TIKTOK.md](./TIKTOK.md) for architecture and rollback.

---

## Watching the grid

- Streams fill a responsive grid that keeps every player as large as possible.
- Each card shows a platform badge and username on the header (or in the fixed compact footer when headers are hidden).
- Drag a card's **header** to reorder (or the **drag** handle in the compact footer). Playback continues — players are not remounted.
- Use the red **×** to remove a stream. On a Theater/Focus primary, × returns to the grid instead.
- A **portrait stream** (a YouTube Short or TikTok LIVE) always takes up the height of 2 landscape rows in its column — not a partial row — so it never leaves an oddly-sized gap next to the streams beside it. The video itself keeps its real 9:16 shape inside that space; it's never stretched wider or squeezed to fill the box. On a phone-width screen, where the grid is a single column anyway, a portrait stream instead gets its own full-width row sized to its real 9:16 shape.

### Focus View

Click a card's **Theater** button for a large primary with a tray of the
remaining streams underneath. Click a card's **Focus** button for solo
primary (that stream alone). Click a tray stream's **header**
(not its buttons — the video itself is a separate embed and can't be
clicked to promote) to swap it into the primary spot — nothing reloads,
so playback never interrupts. The promoted stream **unmutes at the
default volume (25%)** and the stream that moves into the tray is
**muted**. This audio swap applies in **Theater mode only** (primary
plus tray), not in solo Focus. From solo Focus, the primary's **Theater**
control reveals the tray; from Theater-with-tray, the primary's **Focus**
control hides it again.

### Focus

- Click the **Focus** control on a card (header button, or magnifying glass in no-header mode) for solo primary.
- That stream fills the area below the toolbar and reloads **unmuted**.
- Click **Theater** on the same card for primary plus tray instead.

### Keyboard shortcuts

Desktop only — Theater/Focus don't exist on phones. Shortcuts never fire while you're typing in a field, or while a menu or dialog is open.

| Key | In the grid | In Theater / Focus View |
| --- | --- | --- |
| **1–9** | Enter Theater on that stream (same as its Theater button — it unmutes on entry) | Make that stream the primary (same as clicking a tray header in Theater mode — unmutes it and mutes the former primary; playback never reloads) |
| **F** | — | Toggle the tray on/off |
| **M** | — | Mute / unmute the primary stream. Kick primaries can't be toggled this way — Kick embeds have no remote mute API — use the Kick player's own button |
| **Esc** | — | Return to the grid |

### Hide headers

- Toolbar **Show headers** / **Hide headers** toggles card top bars (preference is remembered; headers shown by default).
- A fixed compact footer remains below the iframe (name, drag, Theater, Focus, remove). It never changes the player's dimensions on hover and never overlays the embed.
- iPad hides both the header and compact footer, leaving only a circular close X in the video’s top-right corner.

### Twitch and Kick status

Twitch and Kick cards show a small status dot next to the channel name — pulsing red for **live**, muted gray for **offline**, red-orange for **not found**, muted gray for **unavailable** (MultiStream couldn't check right now). When live, the header also shows category, viewer count, and duration when the platform provides them.

Automatic status checks run every few minutes while the tab is open and visible; they pause while the tab is in the background. A status failure never affects playback — the video keeps working normally either way.

When a Twitch or Kick channel you have on the page **comes back live**, a toast pops up ("NAME is back live") with a **Reload** button that reconnects just that stream — the tab title also flashes until you see it, so a backgrounded tab isn't missed. (YouTube is the exception: a YouTube channel card finds its live video once when it's added, so there's no offline → live moment to announce there.)

The toolbar **Refresh** button reloads already-loaded stream players and refreshes Twitch, YouTube, and Kick metadata together. Use it when you want players to reconnect after a long session; automatic timers never reload players on their own.

---

## Sharing a lineup

Sharing starts a **Live Watch Party** — a persistent room. Viewers who open the party link see your current lineup, and it updates automatically when you add, remove, replace, or rearrange streams. Video is not rebroadcast — each viewer still loads Twitch/Kick/YouTube/TikTok directly.

1. Add the streams you want.
2. Open **Share → Start Live Watch Party** or **Share Watch Party**. If no party is running yet, MultiStream starts one and uses that live link (`https://multistream.cc/w/ROOM_ID`). **Share Watch Party** copies the link.
3. **End Watch Party** when you are done. Viewers keep the last lineup as a normal static page.

Only the host can change the shared lineup. Host control is stored in this browser (`localStorage`); refresh keeps you in control of the same room. Viewers cannot add, remove, or drag streams.

While you host:

- **Your view is shared.** Theater/Focus primary and chat-sidebar visibility update for viewers. A returning host's restored state is pushed immediately after reload. On iPad, Theater sync shows a solo full-size primary (no tray); desktop viewers still see the tray. Phones stay in the simple grid.
- **You can see the room size.** Your status chip shows "Live watch party · N watching". Viewers never see this number.
- **Stay reachable.** Your browser pings the room every 30 seconds while the tab is visible. Viewers see "Host is live" or "Host away" accordingly — and if the pings stop for 30 minutes (tab closed, laptop asleep), the room ends itself and viewers get the same graceful "party has ended" page as if you'd ended it by hand.

Viewer pages check for lineup changes about every 2 seconds. An ended room stays available for 24 hours.

Existing static path URLs still work if someone already has one (or you type one by hand). They are a snapshot and do not follow later lineup changes:

```
https://multistream.cc/t:username/k:username/y:handle:username/tt:creator
```

- `t:` = Twitch, `k:` = Kick, `y:` = YouTube, `tt:` = TikTok LIVE (lowercase preferred; uppercase still works for `t:`/`k:`)
- Legacy query form: `?streams=t:username,k:username`

The rest of the Share menu:

- **Preview Story Card** — full-screen preview of a shareable lineup image (players keep playing behind the dimmed backdrop). **Share Watch Party** copies the live party link (and starts a party if needed).
- **Download Story Card** — saves that image as a PNG

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
| iPad / tablet | Same multi-column grid; Theater shows solo primary (no tray); screen wake lock while watching | iPad hides both bars and shows a circular close X |
| Phone | Single-column scroll | Hidden |

On a phone, streams stack in a single column. About three 16:9 streams fit on screen at once; scroll to move between them. Twitch may need a moment on-screen before video fully plays.

Performance depends on how many live embeds are open. Fewer streams = smoother playback.

---

## Tips

- Start muted — browsers block unmuted autoplay.
- Focus a stream when you want sound quickly.
- Hide headers on desktop for tournaments or dense watch parties; the compact footer stays available below each video without resizing it.
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
