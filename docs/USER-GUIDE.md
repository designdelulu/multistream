# MultiStream.cc — User guide

Watch Twitch and Kick on one page. MultiStream.cc is a modern multi-stream viewer — this guide covers the features and how to use them.

**Live site:** [multistream.cc](https://multistream.cc)

---

## Features at a glance

| Feature | What it does |
|---|---|
| Twitch + Kick grid | Official player embeds side by side, packed at the largest 16:9 size that fits |
| Username dropdown | Type a name (or `@name`) and choose Twitch or Kick |
| Share link | Copy the current lineup URL from the toolbar |
| Clear all | Remove every stream (with confirmation) |
| Hide headers | Compact grid; hover a card to reveal controls below the video (never over it) |
| Drag reorder | Drag card headers — or the drag handle in the hover toolbar when headers are hidden |
| Focus (headers hidden) | Magnifying glass in the hover toolbar |
| Session restore | Last lineup saved in `localStorage`; share URLs in the path take priority |
| Focus mode | Expand one stream, unmute it, open Twitch chat when available |
| Twitch chat | Docked sidebar on desktop/tablet (Kick has no official chat embed) |
| Muted by default | Every stream boots muted; unmute via focus or the player’s own controls |

---

## Adding streams

1. Click the username field in the toolbar.
2. Type a channel name. A dropdown offers **Twitch** and **Kick**.
3. Click a row to add that platform, or use **ArrowDown** / **ArrowUp** to highlight Twitch or Kick and press **Enter**. Plain usernames require that explicit pick — **Enter** alone only works for URLs and `t:` / `k:` prefixes.
4. You can also paste a Twitch/Kick URL or use `t:username` / `k:username`.

Leading `@` is stripped automatically.

**Add Stream** stays as a text button. Share, Clear, Headers, and Chat are icons that show their labels on hover.

---

## Watching the grid

- Streams fill a responsive grid that keeps every player as large as possible.
- Each card shows a platform badge and username on the header (or in the hover toolbar when headers are hidden — the default).
- Drag a card’s **header** to reorder (or the **drag** handle in the hover toolbar when headers are hidden). Playback continues — players are not remounted.
- Use **×** to remove a stream (header button, or **×** in the hover toolbar). In focus mode, × minimizes back to the grid first.

### Focus

- Click the expand (focus) control on a card (header button, or magnifying glass in no-header mode).
- That stream fills the area below the toolbar and reloads **unmuted**.
- Twitch chat opens automatically for focused Twitch streams.
- In no-header mode, the focused stream’s **header bar reappears** so you can × minimize.
- Press **Escape** or × / focus again to exit. The focused stream **stays unmuted**; other streams resume with their previous mute state.

### Hide headers

- Toolbar **Show headers** / **Hide headers** toggles card top bars (preference is remembered; headers hidden by default).
- At rest the card is **video only**. Hover the card and the player shrinks slightly so a control strip appears **below** the iframe (name, drag, focus, remove) — never stacked over the embed (Twitch requirement 1.3). Kick embeds re-scale on hover so volume / pause stay inside the smaller player.
- This avoids Chrome pause-on-overlay and the mute-control refresh loop from remounting embeds.

---

## Sharing a lineup

1. Add the streams you want.
2. Click **Share link** in the toolbar — the current page URL is copied.
3. Anyone opening that link gets the same lineup.

If you close the tab and come back to the home page without a path URL, your last lineup is restored automatically. Share links always win when the URL includes streams.

You can also build URLs by hand:

```
https://multistream.cc/t:username/k:username
```

- `t:` = Twitch, `k:` = Kick (lowercase preferred; uppercase still works)
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
