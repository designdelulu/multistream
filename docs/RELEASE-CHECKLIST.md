# Release checklist

There is no CI/CD for this project — the only path to production is a
local build uploaded by hand to DreamHost (see
[README.md § DreamHost](../README.md#dreamhost-multistreamcc)). This
checklist is what to run through before every upload, so nothing gets
skipped just because there's no pipeline enforcing it.

## Before every release

1. **Tests pass.**
   ```bash
   npx vitest run
   ```
2. **Types check clean.**
   ```bash
   npx tsc --noEmit
   ```
3. **Production build succeeds.**
   ```bash
   npm run build
   ```
   Per this project's [`CLAUDE.md`](../CLAUDE.md), `dist/` should already
   be up to date with any verified `src/`/`index.html`/`public/` change —
   this step is the final confirmation before upload, not the first time
   it's been built.
4. **Manual smoke test** in a real browser against `npm run preview` (or
   the dev server) — automated tests cannot verify actual third-party
   embed playback (see
   [PLAYBACK_STABILITY.md § What automated tests do and do not prove](./PLAYBACK_STABILITY.md#what-automated-tests-do-and-do-not-prove)):
   - Add at least one Twitch, one Kick, and one YouTube (channel-handle,
     not just direct-video) stream; confirm all three actually play.
   - Add a YouTube Shorts URL alongside already-playing streams; confirm
     the *existing* streams keep playing uninterrupted (the mixed-provider
     regression this session fixed — see PLAYBACK_STABILITY.md).
   - Toggle **Focus view** / **Grid view**; click a tray stream's header to
     promote it; confirm nothing remounts or restarts.
   - Toggle **Hide headers**; hover a card; confirm the below-player
     toolbar appears without obscuring the video.
   - Drag-reorder at least one card; confirm the URL updates and no
     player restarts.
   - Resize the window across the responsive breakpoints (see
     [README.md § Device compatibility](../README.md#device-compatibility))
     and confirm the grid, Focus View tray, and chat panel all still look
     correct.
5. **Check for stale copy** — if this release changed behavior, grep the
   docs for anything now inaccurate:
   ```bash
   grep -rn "TODO\|FIXME" src/ docs/ README.md
   ```

## Before uploading to DreamHost specifically

6. Confirm `dist/api/youtube-resolve.php` and `dist/api/twitch-status.php`
   are present in the build output — see
   [README.md § YouTube setup](../README.md#youtube-setup) and
   [§ Twitch setup](../README.md#twitch-setup) for the one-time server
   config those depend on (already configured on the live server; this is
   just confirming the build still includes the files).
7. Upload the **contents** of `dist/`, not the `dist` folder itself, per
   the README's DreamHost steps.
8. After upload, load `https://multistream.cc/` in an incognito/private
   window (no `localStorage` from local dev) and repeat the smoke test in
   step 4 against production.

## After releasing

9. Watch the browser console on the live site for unexpected errors on
   first load (`500`s from `/api/twitch-status.php` and
   `/api/youtube-resolve.php` are expected locally without a PHP server
   running, but should **not** appear on the real production domain,
   where both scripts are live).
10. If this release touched playback/recovery logic, note the outcome in
    [PLAYBACK_STABILITY.md](./PLAYBACK_STABILITY.md) — that file's value
    comes from staying current, not from being written once.
