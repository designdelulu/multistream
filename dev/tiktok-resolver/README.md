# TikTok LIVE dev resolver

Local-dev-only copy of the resolver prototyped and validated on
`research/tiktok-live-prototype` (commit `d6cd4f1`, PROTOTYPE SUCCESS —
see `docs/TIKTOK-LIVE-PROTOTYPE-REPORT.md`). Not deployed anywhere, not
part of the production build, not referenced by any `npm run build`
output.

Run it:

```bash
node dev/tiktok-resolver/resolver.mjs
```

Then point the app at it via `.env.local` (gitignored) — note this is the
**full resolve endpoint URL**, not a base origin:

```
VITE_TIKTOK_RESOLVER_URL=http://localhost:8787/resolve
```

This only ever has an effect in `vite dev`. A production build
(`import.meta.env.PROD`) always calls the same-origin
`public/api/tiktok-resolve.php` instead and ignores this variable
entirely — see the module doc comment above `TIKTOK_RESOLVER_URL` in
`src/platforms/tiktok.ts`. That PHP endpoint is the real production
implementation of the same resolve logic this Node script prototypes;
see `docs/TIKTOK.md` for its architecture and risk notes.
