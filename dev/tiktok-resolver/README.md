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

Then point the app at it via `.env.local` (gitignored):

```
VITE_TIKTOK_RESOLVER_URL=http://localhost:8787
```

See `src/platforms/tiktok.ts` for the client that calls this, and
`docs/TIKTOK-LIVE-PROTOTYPE-REPORT.md` §12 for the real hosting
recommendation (Cloudflare Worker) if this ever ships.
