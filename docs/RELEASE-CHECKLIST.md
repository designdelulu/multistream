# Release checklist

There is no CI/CD for this project — the only path to production is a
local build uploaded by hand to DreamHost (see
[README.md § DreamHost](../README.md#dreamhost-multistreamcc)). This
checklist is what to run through before every upload, so nothing gets
skipped just because there's no pipeline enforcing it.

## Before every release

1. **Tests pass** — frontend (Vitest) and backend (PHP) together:
   ```bash
   npm run test:all
   ```
   (`npm run test:php` runs the framework-free `tests/*.test.php` suites
   on their own; each also runs standalone via `php tests/<file>`.)
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
   - Add at least one Twitch, one Kick, one YouTube (channel-handle,
     not just direct-video), and one experimental TikTok LIVE stream;
     confirm all four actually play or show the expected in-tile message.
   - Add a YouTube Shorts URL alongside already-playing streams; confirm
     the *existing* streams keep playing uninterrupted (the mixed-provider
     regression this session fixed — see PLAYBACK_STABILITY.md).
   - Toggle **Focus view** / **Grid view**; click a tray stream's header to
     promote it; confirm nothing remounts or restarts and the new primary
     is unmuted while the former primary in the tray is muted (Theater mode).
   - Toggle **Hide headers**; hover a card; confirm the below-player
     toolbar appears without obscuring the video.
   - Drag-reorder at least one card with headers visible and at least one
     with headers hidden; confirm the URL updates and no player restarts.
   - Open **Share → Preview Story Card** with several streams playing;
     close the preview; confirm streams keep playing (no remounts).
   - Download a Story Card from the Share menu; confirm avatars and the
     watch URL render legibly for the current lineup size.
   - Hit toolbar **Refresh** with multiple streams loaded; confirm players
     reconnect and Twitch/Kick status dots update without changing the
     lineup.
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

6. Confirm all eight API scripts are present in the build output:
   `dist/api/youtube-resolve.php`, `dist/api/twitch-status.php`,
   `dist/api/kick-status.php`, `dist/api/kick-webhook.php`,
   `dist/api/kick-chat.php`, `dist/api/tiktok-resolve.php`,
   `dist/api/tiktok-avatar.php`, and `dist/api/watch-party.php` — see
   [README.md § YouTube setup](../README.md#youtube-setup),
   [§ Twitch setup](../README.md#twitch-setup),
   [§ Kick setup](../README.md#kick-setup), and
   [§ Live watch parties](../README.md#live-watch-parties) for the
   server-side pieces (already configured on the live server except
   `watch-party.php`, which only needs the existing writable
   `~/multistream-secrets/` directory).
7. Upload the **contents** of `dist/`, not the `dist` folder itself, per
   the README's DreamHost steps.
8. After upload, load `https://multistream.cc/` in an incognito/private
   window (no `localStorage` from local dev) and repeat the smoke test in
   step 4 against production.

## After releasing

9. Watch the browser console on the live site for unexpected errors on
   first load (`500`s from `/api/*` are expected locally without a PHP
   server running, but should **not** appear on the real production domain,
   where those scripts are live).
10. If this release touched playback/recovery logic, note the outcome in
    [PLAYBACK_STABILITY.md](./PLAYBACK_STABILITY.md) — that file's value
    comes from staying current, not from being written once.
