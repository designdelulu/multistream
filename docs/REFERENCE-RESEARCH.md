# Reference repo research

Research only, per the Theater/Focus correction directive — nothing here is
implemented or scheduled. Read the READMEs of five repos for reusable
architectural/product patterns; noted below is what's actually useful and
what isn't.

## Unified chat

**[ancarvalho/MultiChat](https://github.com/ancarvalho/MultiChat)** — pure
client-side, aggregates Twitch/Kick/YouTube chat into one panel. Requires a
self-hosted CORS proxy (`cors-anywhere` or similar) to reach the platform
chat APIs from the browser at all — the README's own setup section is mostly
proxy configuration. Confirms the directive's instinct: a CORS proxy is a
real, standing cost (another service to host, another failure mode), not a
detail. We already avoid one (server-side PHP resolvers instead). Not worth
it for unified chat alone.

**[navarr/multi-stream-chat](https://github.com/navarr/multi-stream-chat)** —
Node.js server + OAuth + an ngrok tunnel, not a static client. Its own
README calls TikTok chat support "not perfect... some messages from certain
users will just never show up," unsolved. That's independent confirmation
that TikTok chat is fragile upstream, not just our own resolver being new —
reinforces the directive's call to leave Theater chat Twitch-only and not
expand to TikTok this pass.

Neither pattern changes the current call: unified chat stays a future,
separately-scoped feature, and would need its own proxy/backend story before
it's worth revisiting.

## Kick data

**[danielhe4rt/kick-php-sdk](https://github.com/danielhe4rt/kick-php-sdk)** —
wraps Kick's public REST API; its channel endpoint exposes `user.profile_pic`
among other fields. Already covered in the avatar-source audit: pulling that
means a new request either way, SDK or not, so it doesn't clear the "already
available, no new request" bar the avatar work was scoped to. Worth
revisiting only if Kick metadata becomes a larger, separately-justified
feature (e.g. real viewer counts), not for one avatar.

## Grid / shareable URLs

**[pjmagee/multi-stream-viewer](https://github.com/pjmagee/multi-stream-viewer)**
— different stack entirely (Blazor WebAssembly/.NET), so no code is portable.
Its URL scheme is one clean idea: `/{platform}/{identifier}/{platform}/{identifier}/...`,
a path-segment list rather than a query string. Not clearly superior to our
existing shareable-URL format — just a different convention — so per the
directive this isn't a reason to rewrite anything.

**[Worsttrumpet/MultiStream-Grid](https://github.com/Worsttrumpet/MultiStream-Grid)**
— single-file HTML/JS, no build step, closest in spirit to this project. Two
small product ideas worth flagging for a future pass (not this one):
- Keyboard shortcuts (`F` focus/unfocus, `M` mute all Twitch, `1`-`9` focus
  nth stream) — plausible low-risk accessibility/power-user win once
  Theater/Focus itself is stable.
- A user-configurable "max active streams" cap — relevant to this project's
  own past performance/resource-audit work (Phase 13), as a way to let
  viewers self-limit concurrent players rather than us guessing a hard limit.

Neither is implemented here — noted for a later, separately-scoped pass.

## Bottom line

Nothing here justifies touching the current Theater/Focus/TikTok/avatar work
in progress. The one idea worth carrying forward (keyboard shortcuts,
max-active-streams cap) is explicitly future scope, not this pass's.
