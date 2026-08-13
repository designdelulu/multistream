# MultiStream.cc — User guide

Watch Twitch, Kick, and YouTube on one page. MultiStream.cc is a modern multi-stream viewer — this guide covers the features and how to use them.

**Live site:** [multistream.cc](https://multistream.cc)

---

## Features at a glance

| Feature | What it does |
|---|---|
| Twitch + Kick + YouTube grid | Official player embeds side by side, packed at the largest 16:9 size that fits |
| Username dropdown | Type a name (or `@name`) and choose Twitch, Kick, or YouTube |
| Share link | Copy the current lineup URL from the toolbar |
| Clear all | Remove every stream (with confirmation) |
| Hide headers | Compact grid; hover a card to reveal controls below the video (never over it) |
| Drag reorder | Drag card headers — or the drag handle in the hover toolbar when headers are hidden |
| Focus (headers hidden) | Magnifying glass in the hover toolbar |
| Session restore | Last lineup saved in `localStorage`; share URLs in the path take priority |
| Focus mode | Expand one stream, unmute it, open Twitch chat when available |
| Focus View | Toolbar toggle: large primary + a tray of the rest; click a tray stream's header to promote it, no remount |
| Portrait streams (Shorts) | Get their own 2-row-tall grid slot in Grid View, letterboxed to true 9:16 — never stretched |
| Twitch chat | Docked sidebar on desktop/tablet (Kick has no official chat embed) |
| Muted by default | Every stream boots muted; unmute via focus or the player’s own controls |
| Twitch status | Live/offline/not-found/unavailable dot + category/viewers/duration on every Twitch card, refreshed automatically and on demand |

---

## Adding streams

1. Click the username field in the toolbar.
2. Type a channel name. A dropdown offers **Twitch**, **Kick**, and **YouTube**.
3. Click a row to add that platform, or use **ArrowDown** / **ArrowUp** to highlight one and press **Enter**. Plain usernames require that explicit pick — **Enter** alone only works for URLs and `t:` / `k:` / `y:` prefixes.
4. You can also paste a Twitch/Kick/YouTube URL, or use `t:username` / `k:username`.

Leading `@` is stripped automatically.

**Add Stream** stays as a text button. Share, Clear, Headers, and Chat are icons that show their labels on hover.

### YouTube

YouTube accepts more input shapes than Twitch/Kick, since a channel and a video are different things there:

- A direct video URL (`youtube.com/watch?v=…`, `youtu.be/…`, `/live/…`, `/shorts/…`) loads exactly that video.
- A handle (`@name` or `name`), legacy username, channel ID, or channel URL loads that channel's **current live stream** — resolved fresh on each page load, never a cached recording. If the channel isn't live right now, the card says so clearly instead of loading something else.
- Only the **first** YouTube player on the page autoplays (muted). Every other YouTube player waits for you to press play — this is a YouTube platform rule, not a MultiStream limitation, and it applies even after adding/removing streams or returning to the tab.

---

## Watching the grid

- Streams fill a responsive grid that keeps every player as large as possible.
- Each card shows a platform badge and username on the header (or in the hover toolbar when headers are hidden — the default).
- Drag a card’s **header** to reorder (or the **drag** handle in the hover toolbar when headers are hidden). Playback continues — players are not remounted.
- Use **×** to remove a stream (header button, or **×** in the hover toolbar). In focus mode, × minimizes back to the grid first.
- A **portrait stream** (a YouTube Short) always takes up the height of 2 landscape rows in its column — not a partial row — so it never leaves an oddly-sized gap next to the streams beside it. The video itself keeps its real 9:16 shape inside that space; it's never stretched wider or squeezed to fill the box. On a phone-width screen, where the grid is a single column anyway, a portrait stream instead gets its own full-width row sized to its real 9:16 shape.

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
- Twitch chat opens automatically for focused Twitch streams.
- In no-header mode, the focused stream’s **header bar reappears** so you can × minimize.
- Press **Escape** or × / focus again to exit. The focused stream **stays unmuted**; other streams resume with their previous mute state.

### Hide headers

- Toolbar **Show headers** / **Hide headers** toggles card top bars (preference is remembered; headers shown by default).
- At rest the card is **video only**. Hover the card and the player shrinks slightly so a control strip appears **below** the iframe (name, drag, focus, remove) — never stacked over the embed (Twitch requirement 1.3). Kick embeds re-scale on hover so volume / pause stay inside the smaller player.
- This avoids Chrome pause-on-overlay and the mute-control refresh loop from remounting embeds.

### Twitch status

Every Twitch card shows a small dot next to its name — pulsing red for **live**, muted gray for **offline**, red-orange for **not found** (no such account), muted gray for **unavailable** (MultiStream couldn't check right now). When live, the header also shows the category, viewer count, and how long it's been live right next to the platform badge, e.g. "Twitch · Just Chatting · 12.4K viewers · 2h 14m". Hover the dot for the same info as an accessible tooltip.

Use the toolbar's **Refresh Twitch statuses** button to re-check every Twitch card at once. It only updates the status dot and header text — it never reloads or restarts a player. If a channel you're watching goes live while you're on this page, its dot updates, but you'll still need the card's own **reload** button to actually connect to the stream. Status also refreshes automatically every few minutes while the tab is open and visible; it pauses while the tab is in the background so it never fights for bandwidth with the streams you're actually watching. A Twitch status failure never affects the embed itself — the video keeps working normally either way.

---

## Sharing a lineup

1. Add the streams you want.
2. Click **Share link** in the toolbar — the current page URL is copied.
3. Anyone opening that link gets the same lineup.

If you close the tab and come back to the home page without a path URL, your last lineup is restored automatically. Share links always win when the URL includes streams.

You can also build URLs by hand:

```
https://multistream.cc/t:username/k:username/y:handle:username
```

- `t:` = Twitch, `k:` = Kick, `y:` = YouTube (lowercase preferred; uppercase still works for `t:`/`k:`)
- Legacy query form: `?streams=t:username,k:username`

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

On phones and tablets you can keep several streams loaded, but the browser usually plays only one at a time.

Performance depends on how many live embeds are open. Fewer streams = smoother playback.

---

## Tips

- Start muted — browsers block unmuted autoplay.
- Focus a stream when you want sound quickly.
- Hide headers for tournaments or dense watch parties; hover a card for the toolbar below each video (focus, remove, drag).
- Clear all when starting a fresh layout.
- Kick’s volume UI needs a wide player; MultiStream scales Kick embeds so desktop chrome stays available when cells are narrow.

### Debugging embed remounts (optional)

Only if streams keep stopping and you want to see why:

1. Add `?debug=embeds` to the URL and reload.
2. Open the browser console (right-click → Inspect → Console).
3. When a stream stops, look for lines starting with `[embed-debug]`.
4. Tell me the **reason** field (e.g. `tab-freeze`, `headers-recover`). That’s enough.

Turn it off later with `?debug=off`. You don’t need this for normal use — safe stability patches are already in the app.

---

## More for developers

See [README.md](../README.md) for local setup, deploy notes (including DreamHost), and embed technical details.
