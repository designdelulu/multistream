# MultiStream.cc — User guide

Watch Twitch and Kick on one page. This guide covers the features and how to use them.

**Live site:** [multistream.cc](https://multistream.cc)

---

## Features at a glance

| Feature | What it does |
|---|---|
| Twitch + Kick grid | Official player embeds side by side, packed at the largest 16:9 size that fits |
| Username dropdown | Type a name (or `@name`) and choose Twitch or Kick |
| Share link | Copy the current lineup URL from the toolbar |
| Clear all | Remove every stream (with confirmation) |
| Hide headers | Compact grid; **Watching** sidebar for remove and reorder |
| Drag reorder | Drag card headers — or a bottom handle / Watching list rows when headers are hidden |
| Focus (headers hidden) | Magnifying glass on video hover (distinct from embed fullscreen) |
| Session restore | Last lineup saved in `localStorage`; share URLs in the path take priority |
| Focus mode | Expand one stream, unmute it, open Twitch chat when available |
| Twitch chat | Docked sidebar on desktop/tablet (Kick has no official chat embed) |
| Muted by default | Every stream boots muted; unmute via focus or the player’s own controls |

---

## Adding streams

1. Click the username field in the toolbar.
2. Type a channel name. A dropdown offers **Twitch** and **Kick**.
3. Click a row to add that platform. **Enter** only works for URLs and `t:` / `k:` prefixes — plain usernames require picking Twitch or Kick from the list.
4. You can also paste a Twitch/Kick URL or use `t:username` / `k:username`.

Leading `@` is stripped automatically.

**Add Stream** stays as a text button. Share, Clear, Headers, and Chat are icons that show their labels on hover.

---

## Watching the grid

- Streams fill a responsive grid that keeps every player as large as possible.
- Each card shows a platform badge and username on the header (by default).
- Drag a card’s **header** to reorder. Playback continues — players are not remounted.
- Use **×** to remove a stream. In focus mode, × minimizes back to the grid first.

### Focus

- Click the expand (focus) control on a card (header button, or magnifying glass in no-header mode).
- That stream fills the area below the toolbar and reloads **unmuted**.
- Twitch chat opens automatically for focused Twitch streams.
- In no-header mode, the focused stream’s **header bar reappears** so you can × minimize — hover overlays are hidden during focus so playback is not interrupted.
- Press **Escape** or × / focus again to exit. Twitch remounts muted.

### Hide headers

- Toolbar **Hide headers** collapses card top bars for a denser view (preference is remembered).
- A **Watching** list appears on the left with color accents (purple = Twitch, green = Kick) and **×** to remove each stream.
- Hover a video for a magnifying-glass **Focus** button (top-right) and a bottom **drag to reorder** handle — same pattern as [MultistreamGrid](https://multistreamgrid.com). You can also reorder from the Watching list.
- Live viewer counts beside names are planned for a future update (Twitch requires a server-side API proxy).

On phones, Watching becomes a wrapping strip above the grid.

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
- Hide headers for tournaments or dense watch parties; use Watching to manage the lineup.
- Clear all when starting a fresh layout.
- Kick’s volume UI needs a wide player; MultiStream scales Kick embeds so desktop chrome stays available when cells are narrow.

---

## More for developers

See [README.md](../README.md) for local setup, deploy notes (including DreamHost), and embed technical details.
