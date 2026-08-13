# TikTok LIVE — support research (blocked)

Tracks why TikTok LIVE isn't a supported platform in MultiStream.cc yet,
and what would need to change for that to become possible.

## Status: blocked on TikTok's own API surface

TikTok does not currently offer an official way to embed a **LIVE**
broadcast on a third-party page. The two API surfaces that exist today
both fall short:

- **TikTok oEmbed API** (`https://www.tiktok.com/oembed`) — the only
  officially documented embed mechanism. It resolves a **published video
  URL** (`tiktok.com/@user/video/123...`) to an `<iframe>` embed. It has
  no concept of a live broadcast: there is no live-equivalent URL to feed
  it, and no parameter that switches it into a "whatever this creator is
  streaming right now" mode. A creator's live room isn't a `video/{id}`
  URL at all, so there's nothing to hand this endpoint even in principle.
- **TikTok Live API** (part of the TikTok for Developers platform) —
  exists for reading live-stream metadata and, for approved partners,
  server-side stream data. It is not an embed product: it does not return
  an iframe-able player, and access requires an approved developer
  application and (per TikTok's current published terms) is scoped
  toward specific partner use cases, not general embedding on arbitrary
  third-party sites like this one.

Net result: there is no URL, token, or embed code that would let
MultiStream.cc mount a live TikTok stream the way it mounts Twitch, Kick,
or YouTube — every existing platform integration in `src/platforms/` works
by embedding an iframe the platform itself documents for exactly this
purpose, and TikTok has no LIVE equivalent to point at.

## What would unblock this

Any one of the following would change the situation, none of which is
inside this project's control:

1. TikTok ships an official LIVE embed (an oEmbed-style endpoint or a
   documented iframe URL scheme) for creator live rooms.
2. TikTok's existing oEmbed endpoint is extended to accept a live-room
   identifier instead of only a published `video/{id}` URL.
3. The TikTok Live API's partner program opens general public embedding
   as a supported use case, with its own iframe/player artifact rather
   than raw stream metadata.

## Why this isn't a "just scrape it" situation

Unofficial embedding approaches (scraping the live room's internal player
URL, reverse-engineering TikTok's own web player, using an unofficial
third-party relay) were deliberately not pursued: they break without
notice whenever TikTok changes its internal page structure, several
violate TikTok's Terms of Service for automated access, and a
multi-stream viewer whose TikTok tile silently breaks on every TikTok
frontend change is a worse experience than not offering TikTok at all.
The existing Twitch/Kick/YouTube integrations all use each platform's
own **documented, stable** embed contract for exactly this reason — see
[README.md § Embed notes](../README.md#embed-notes).

## What's already in place for when this unblocks

The layout and type system were built so TikTok (or any future
portrait-native platform) is a capability question, not a rewrite:

- `StreamOrientation` (`src/types.ts`) already models `'portrait'` as a
  first-class orientation, not a YouTube-specific special case — the
  fixed 2-row Grid View span (`PORTRAIT_ROW_SPAN`, `src/lib/gridLayout.ts`)
  and Focus View's aspect-preserving primary sizing
  (`computeFocusViewLayout`) both key off `orientation`, never off
  `platform === 'youtube'`.
- Adding a platform is already a contained change: implement the
  `PlatformAdapter` interface (`parseInput`, `buildEmbedUrl` — see
  [README.md § Architecture](../README.md#architecture)) in
  `src/platforms/`, and register it in `src/platforms/index.ts`. No
  grid/layout code needs to know a new platform exists.

If TikTok does ship an official LIVE embed, the work becomes "write a
`tiktok.ts` adapter around that documented embed," not "redesign how the
grid handles orientation."

## Re-checking this later

TikTok's developer documentation is the source of truth, not this file's
memory of it — re-check `https://developers.tiktok.com/` and
`https://www.tiktok.com/oembed` directly before assuming this is still
accurate; TikTok's platform surface has changed before without much
notice.
