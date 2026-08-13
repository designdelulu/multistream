// Research prototype only. Not part of the production app.
// Resolves a public TikTok LIVE URL to a temporary, signed FLV CDN URL by
// calling the same unofficial endpoint TikTok's own web client and
// Streamlink's tiktok plugin use: https://www.tiktok.com/api-live/user/room
//
// No cookies, no login, no bypass of any access control — this is the same
// unauthenticated request a logged-out browser makes when it loads
// tiktok.com/@user/live. See ../TIKTOK-LIVE-PROTOTYPE-REPORT.md for the
// full writeup, license note (Streamlink is BSD-2-Clause, referenced for
// endpoint shape only, not copied), and risk discussion.

import http from 'node:http';

const PORT = process.env.PORT || 8787;
const API_LIVE = 'https://www.tiktok.com/api-live/user/room';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';

function parseTikTokLiveInput(input) {
  const trimmed = (input || '').trim();

  const liveUrl = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([^/?]+)\/live(?:\?.*)?$/i);
  if (liveUrl) return liveUrl[1];

  const bareProfile = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([^/?]+)\/?(?:\?.*)?$/i);
  if (bareProfile) return bareProfile[1];

  // Reject anything that looks like a non-live TikTok URL (e.g. /video/123)
  // rather than falling through to the bare-username case.
  if (/tiktok\.com/i.test(trimmed)) return null;

  const handle = trimmed.match(/^@?([a-zA-Z0-9_.]{1,64})$/);
  return handle ? handle[1] : null;
}

async function resolveTikTokLive(username) {
  const refererUrl = `https://www.tiktok.com/@${username}/live`;
  const url = new URL(API_LIVE);
  url.searchParams.set('aid', '1988');
  url.searchParams.set('sourceType', '54');
  url.searchParams.set('uniqueId', username);

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: refererUrl },
    });
  } catch (err) {
    return { live: false, username, state: 'network_error', error: String(err), qualities: [], expiresAt: null };
  }

  if (!res.ok) {
    return { live: false, username, state: 'upstream_http_error', error: `HTTP ${res.status}`, qualities: [], expiresAt: null };
  }

  const json = await res.json();

  if (json.statusCode !== 0) {
    // e.g. { message: "user_not_found" } — invalid/nonexistent creator.
    return { live: false, username, state: 'invalid_creator', error: json.message || 'unknown', qualities: [], expiresAt: null };
  }

  const room = json.data?.liveRoom;
  if (!room) {
    return { live: false, username, state: 'provider_error', error: 'missing_liveRoom', qualities: [], expiresAt: null };
  }

  if (room.status === 4) {
    return { live: false, username, state: 'offline', title: room.title ?? null, qualities: [], expiresAt: null };
  }

  const streamDataRaw = room.streamData?.pull_data?.stream_data;
  if (!streamDataRaw) {
    return { live: false, username, state: 'no_stream_data', title: room.title ?? null, qualities: [], expiresAt: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(streamDataRaw).data;
  } catch (err) {
    return { live: false, username, state: 'provider_error', error: 'unparseable_stream_data', qualities: [], expiresAt: null };
  }

  const qualities = [];
  let expiresAt = null;
  for (const [name, info] of Object.entries(parsed || {})) {
    const flvUrl = info?.main?.flv;
    if (!flvUrl) continue;
    try {
      const expire = new URL(flvUrl).searchParams.get('expire');
      if (expire) expiresAt = new Date(Number(expire) * 1000).toISOString();
    } catch {}
    qualities.push({ id: name, protocol: 'flv', url: flvUrl });
  }

  if (qualities.length === 0) {
    return { live: false, username, state: 'no_playable_streams', title: room.title ?? null, qualities: [], expiresAt: null };
  }

  return {
    live: true,
    state: 'live',
    username,
    title: room.title ?? null,
    qualities,
    expiresAt,
  };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/resolve') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    let parsedBody;
    try {
      parsedBody = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json_body' }));
      return;
    }

    const username = parseTikTokLiveInput(parsedBody.url);
    if (!username) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_or_non_live_tiktok_url' }));
      return;
    }

    try {
      const result = await resolveTikTokLive(username);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'resolver_error', message: String(err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[tiktok resolver prototype] listening on http://localhost:${PORT}`);
});
