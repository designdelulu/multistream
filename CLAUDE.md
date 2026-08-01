# CLAUDE.md — multistream

## Production deploy model

`dist/` (gitignored, built locally) is what the user manually uploads to
DreamHost for **multistream.cc production**. There is no CI/CD — the only
path to production is: `npm run build` → user uploads `dist/` contents by
hand.

**Whenever a change to `src/`, `index.html`, or `public/` is complete and
verified (tests pass, manually checked), rebuild `dist/` (`npm run build`)
without being asked**, so it's always ready for the user to upload. This is
a local build only — never upload, deploy, or push automatically; that
stays the user's manual action. See `README.md` for the full DreamHost
upload steps and the one-time YouTube resolver config
(`~/multistream-secrets/youtube-config.php`, outside the web root).
