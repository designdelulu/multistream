<?php
/**
 * Experimental TikTok LIVE resolver for MultiStream.cc — NOT an official
 * TikTok integration. See docs/TIKTOK.md for the full architecture and
 * risk writeup; this file is the production implementation of the same
 * logic prototyped in dev/tiktok-resolver/resolver.mjs.
 *
 * Contract: POST /api/tiktok-resolve.php, JSON body {"url": "..."}
 * (a TikTok LIVE URL, e.g. https://www.tiktok.com/@handle/live — or a real
 * TikTok share short link, e.g. https://vt.tiktok.com/XXXXXXXXX/, see
 * "Share short links" below). Always responds 200 application/json with a
 * TikTokResolveResult shape (see src/platforms/tiktok.ts) — {live, state,
 * username, title, qualities, expiresAt, error?}. Only a 405 (wrong
 * method) or 400 (malformed JSON body) ever use a non-200 status; every
 * TikTok-side outcome (offline, invalid creator, upstream failure) is a
 * normal 200 with `state` set.
 *
 * Calls the same unauthenticated, undocumented endpoint TikTok's own web
 * client and Streamlink's `tiktok` plugin use
 * (https://www.tiktok.com/api-live/user/room) — no cookies, no login, no
 * access-control bypass. This is the same request a logged-out browser
 * makes loading the live page directly.
 *
 * Share short links (vm.tiktok.com / vt.tiktok.com):
 *   TikTok's own mobile-app Share sheet copies a shortened link
 *   (confirmed for real against a live room: `vt.tiktok.com/<code>/` →
 *   HTTP 301 → `www.tiktok.com/@handle/live?...`) rather than the
 *   canonical `/@handle/live` URL the web Share panel copies. Neither
 *   domain exposes the handle in the short URL itself, so it can only be
 *   recognized by following the redirect. resolve_tiktok_short_link()
 *   does that with a tight allow-list: only vm.tiktok.com/vt.tiktok.com
 *   may be fetched, every hop (including the final one) must land back on
 *   a TikTok-owned host or resolution is aborted, redirects are capped at
 *   TIKTOK_SHORT_LINK_MAX_REDIRECTS, the request is a bodyless HEAD with a
 *   short timeout and no cookies, and the resolved URL still has to pass
 *   parse_tiktok_live_url() same as any other input — a short link to a
 *   /video/ or /photo/ post is rejected exactly like the long-form
 *   equivalent already is.
 *
 * Security posture (see docs/TIKTOK.md "Resolver safety"):
 *   - The client-supplied `url` is only ever used to extract and validate
 *     a username (optionally via the constrained short-link redirect hop
 *     above); this script never fetches an arbitrary client-supplied URL
 *     — the room-info call always goes to a fixed host (api-live/user/room)
 *     and the short-link redirect call is host-allow-listed to TikTok's
 *     own domains, so there is no SSRF / open-proxy surface.
 *   - Username is validated against the same charset the frontend adapter
 *     enforces (src/platforms/tiktok.ts parseTikTokLiveUrl) before it
 *     ever reaches a URL.
 *   - Video bytes are never touched — only small JSON metadata is
 *     fetched and relayed. The browser fetches the returned CDN URL
 *     directly.
 *   - Per-IP rate limiting and a short response-size cap on the upstream
 *     call guard against abuse.
 *   - No stack traces or PHP errors ever reach the response body.
 *
 * No credentials, no config file, no one-time setup — unlike
 * youtube-resolve.php / twitch-status.php, this endpoint needs no API
 * key. It shares their cache directory (multistream-secrets/cache),
 * which is already provisioned if either of those is set up.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// --- Configuration -----------------------------------------------------

if (!defined('TIKTOK_CACHE_DIR')) {
    // Shared with youtube-resolve.php / twitch-status.php's cache dir —
    // keys below are namespaced with a "tiktok:" prefix before hashing.
    define('TIKTOK_CACHE_DIR', dirname(__DIR__, 2) . '/multistream-secrets/cache');
}

define('UPSTREAM_TIMEOUT_SECONDS', 5);
define('UPSTREAM_MAX_BYTES', 2 * 1024 * 1024); // TikTok's metadata JSON is small; abort on anything unexpectedly large
define('LIVE_CACHE_TTL', 15); // short — a signed CDN URL going stale mid-session is worse than one extra upstream call
define('OFFLINE_CACHE_TTL', 30);
define('INVALID_CREATOR_CACHE_TTL', 3600);
define('RATE_LIMIT_WINDOW_SECONDS', 60);
define('RATE_LIMIT_MAX_REQUESTS', 20); // per IP per window — generous for real usage, tight against abuse
define('TIKTOK_SHORT_LINK_MAX_REDIRECTS', 3); // real observed chain is 1 hop; headroom without allowing a loop to spin
define('TIKTOK_REDIRECT_TIMEOUT_SECONDS', 5);

const API_LIVE = 'https://www.tiktok.com/api-live/user/room';
// Bounded fallback, only ever called when API_LIVE confirms the room is live
// (status 2) but exposes no usable stream_data — same TikTok-owned host,
// same username/roomId already validated for the primary call, no cookies,
// no extra scope. Reference: the current yt-dlp TikTok LIVE extractor
// (yt_dlp/extractor/tiktok.py, TikTokLiveIE._real_extract) falls back to
// this same endpoint under the same condition ("uploader is a guest on
// another's livestream, primary endpoint will not have m3u8 URLs") — logic
// studied for endpoint/shape only, nothing copied. Real-tested 2026-08-14
// against a genuinely live room: this endpoint currently answers
// {"statusCode":10201,"statusMsg":"live detail API is deprecated"} — TikTok
// appears to have retired it since yt-dlp's implementation was written. Kept
// anyway (cheap, bounded, harmless when it fails) in case that's rolled out
// gradually or reverts; fallback_result in the diagnostics log below records
// whether it ever actually helps in production.
const API_LIVE_DETAIL_FALLBACK = 'https://www.tiktok.com/api/live/detail/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';

// Real TikTok-owned domains only. vm./vt.tiktok.com are the two share
// short-link hosts TikTok's own apps use; tiktok.com/www.tiktok.com are
// the only hosts a resolved short link is allowed to land on. Any other
// host at any hop (including a same-site-looking lookalike) aborts
// resolution rather than being fetched.
const TIKTOK_SHORT_LINK_HOSTS = ['vm.tiktok.com', 'vt.tiktok.com'];
const TIKTOK_REDIRECT_ALLOWED_HOSTS = ['vm.tiktok.com', 'vt.tiktok.com', 'tiktok.com', 'www.tiktok.com'];

// --- Response helpers ----------------------------------------------------

/** @param array<string,mixed> $body */
function respond(array $body): void
{
    echo json_encode($body);
    exit;
}

function empty_result(string $state, string $username, ?string $error = null, ?string $title = null): array
{
    $result = ['live' => false, 'state' => $state, 'username' => $username, 'title' => $title, 'qualities' => [], 'expiresAt' => null];
    if ($error !== null) $result['error'] = $error;
    return $result;
}

/** Pull a https avatar URL out of the room payload when TikTok includes one. */
function tiktok_extract_avatar_url(array $json): ?string
{
    $candidates = [
        $json['data']['user']['avatarMedium'] ?? null,
        $json['data']['user']['avatarThumb'] ?? null,
        $json['data']['user']['avatarLarger'] ?? null,
        $json['data']['liveRoom']['ownerInfo']['avatarMedium'] ?? null,
        $json['data']['liveRoom']['ownerInfo']['avatarThumb'] ?? null,
        $json['data']['liveRoom']['ownerInfo']['avatarLarger'] ?? null,
    ];
    foreach ($candidates as $url) {
        if (is_string($url) && str_starts_with($url, 'https://') && strlen($url) < 2048) {
            return $url;
        }
    }
    return null;
}

/** Attaches avatarUrl and caches the source URL for the same-origin avatar proxy. */
function tiktok_attach_avatar(array $result, array $json, string $username): array
{
    $avatarUrl = tiktok_extract_avatar_url($json);
    if ($avatarUrl === null) return $result;
    $result['avatarUrl'] = $avatarUrl;
    cache_set('tiktok:avatar-src:' . strtolower($username), $avatarUrl, 7 * 24 * 3600);
    return $result;
}

// --- File-based cache + rate limiter (best-effort; never fatal) ----------
// Identical shape to twitch-status.php's cache functions.

function cache_dir_ready(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;

    if (!is_dir(TIKTOK_CACHE_DIR)) {
        $ready = @mkdir(TIKTOK_CACHE_DIR, 0700, true);
        if (!$ready) error_log('tiktok-resolve: could not create cache dir — continuing without caching/rate-limiting');
        return $ready;
    }

    $ready = is_writable(TIKTOK_CACHE_DIR);
    if (!$ready) error_log('tiktok-resolve: cache dir not writable — continuing without caching/rate-limiting');
    return $ready;
}

function cache_path(string $key): string
{
    return TIKTOK_CACHE_DIR . '/' . hash('sha256', $key) . '.json';
}

function cache_get(string $key): mixed
{
    if (!cache_dir_ready()) return null;
    $path = cache_path($key);
    if (!is_readable($path)) return null;

    $raw = @file_get_contents($path);
    if ($raw === false) return null;

    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !isset($decoded['expiresAt'], $decoded['value'])) return null;
    if (time() >= $decoded['expiresAt']) return null;

    return $decoded['value'];
}

function cache_set(string $key, mixed $value, int $ttlSeconds): void
{
    if (!cache_dir_ready()) return;
    $payload = json_encode(['expiresAt' => time() + $ttlSeconds, 'value' => $value]);
    if ($payload === false) return;
    @file_put_contents(cache_path($key), $payload, LOCK_EX);
}

/** Fixed-window per-IP counter. Fails open (allows the request) if the cache dir is unavailable. */
function rate_limit_exceeded(string $ip): bool
{
    if (!cache_dir_ready()) return false;

    $key = "tiktok:ratelimit:{$ip}";
    $path = cache_path($key);
    $now = time();

    $raw = @file_get_contents($path);
    $state = $raw !== false ? json_decode($raw, true) : null;

    if (!is_array($state) || !isset($state['windowStart'], $state['count']) || ($now - $state['windowStart']) >= RATE_LIMIT_WINDOW_SECONDS) {
        $state = ['windowStart' => $now, 'count' => 0];
    }

    $state['count']++;
    @file_put_contents($path, json_encode($state), LOCK_EX);

    return $state['count'] > RATE_LIMIT_MAX_REQUESTS;
}

// --- Input validation (mirrors src/platforms/tiktok.ts parseTikTokLiveUrl) ---

/** `https://` prefixed if missing, or null for empty/unparseable input. Never fetches. */
function normalize_tiktok_url(string $value): ?string
{
    $value = trim($value);
    if ($value === '') return null;
    if (!str_starts_with($value, 'http')) $value = 'https://' . $value;
    return $value;
}

/** Lowercased host of a normalized URL, or null. Never fetches. */
function url_host(string $normalizedUrl): ?string
{
    $parts = parse_url($normalizedUrl);
    if ($parts === false || empty($parts['host'])) return null;
    return strtolower($parts['host']);
}

/** Returns the validated handle, or null. Never fetches the input URL — only parses it. */
function parse_tiktok_live_url(string $value): ?string
{
    $normalized = normalize_tiktok_url($value);
    if ($normalized === null) return null;

    $host = url_host($normalized);
    if ($host !== 'tiktok.com' && $host !== 'www.tiktok.com') return null;

    $parts = parse_url($normalized);
    $segments = array_values(array_filter(explode('/', $parts['path'] ?? ''), fn($s) => $s !== ''));
    $first = $segments[0] ?? '';
    if (!str_starts_with($first, '@')) return null;

    $handle = substr($first, 1);
    if (!preg_match('/^[a-zA-Z0-9_.]{1,64}$/', $handle)) return null;

    if (count($segments) === 1) return strtolower($handle);
    if (count($segments) === 2 && strtolower($segments[1]) === 'live') return strtolower($handle);

    return null;
}

// --- Share short-link resolution (vm.tiktok.com / vt.tiktok.com) -----------

/**
 * Tests set $GLOBALS['tiktok_redirect_transport'] to a closure with this
 * shape before requiring this file, so no real network call is ever made
 * in automated tests.
 *
 * @return array{httpCode:int,location:?string,error:?string}
 */
function perform_redirect_request(string $url): array
{
    $transport = $GLOBALS['tiktok_redirect_transport'] ?? null;
    if ($transport !== null) {
        return $transport($url);
    }
    return curl_redirect_head_request($url);
}

/**
 * Bodyless HEAD request that reports the immediate Location header without
 * following it — the caller re-validates each hop's host itself rather
 * than trusting curl's own follow-redirects behavior. No cookies, no
 * credentials, strict timeout.
 *
 * @return array{httpCode:int,location:?string,error:?string}
 */
function curl_redirect_head_request(string $url): array
{
    if (!function_exists('curl_init')) {
        error_log('tiktok-resolve: curl extension not available');
        return ['httpCode' => 0, 'location' => null, 'error' => 'curl_unavailable'];
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_NOBODY => true, // HEAD — TikTok's redirect host answers identically to GET for this
        CURLOPT_HEADER => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false, // we re-validate and follow manually, hop by hop
        CURLOPT_TIMEOUT => TIKTOK_REDIRECT_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => TIKTOK_REDIRECT_TIMEOUT_SECONDS,
        CURLOPT_HTTPHEADER => ['User-Agent: ' . USER_AGENT],
    ]);

    $raw = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);

    if ($raw === false) {
        error_log('tiktok-resolve: short-link redirect request failed: ' . ($curlError ?: 'transport_error'));
        return ['httpCode' => 0, 'location' => null, 'error' => $curlError ?: 'transport_error'];
    }

    $location = curl_getinfo($ch, CURLINFO_REDIRECT_URL) ?: null;
    return ['httpCode' => $httpCode, 'location' => $location, 'error' => null];
}

/**
 * Resolves a vm.tiktok.com / vt.tiktok.com share link to its final TikTok
 * URL, or null if it can't be resolved safely. Every hop's host — the
 * short link itself and wherever it redirects to — must be in
 * TIKTOK_REDIRECT_ALLOWED_HOSTS; a redirect to any other host (TikTok's
 * short-link service escaping to a third-party domain, or a lookalike)
 * aborts resolution immediately rather than being followed. Capped at
 * TIKTOK_SHORT_LINK_MAX_REDIRECTS hops to guard against a redirect loop.
 */
function resolve_tiktok_short_link(string $normalizedUrl): ?string
{
    $current = $normalizedUrl;

    for ($hop = 0; $hop < TIKTOK_SHORT_LINK_MAX_REDIRECTS; $hop++) {
        $host = url_host($current);
        if ($host === null || !in_array($host, TIKTOK_REDIRECT_ALLOWED_HOSTS, true)) {
            return null; // left TikTok-owned hosts (or unparseable) — refuse to follow
        }

        if ($host === 'tiktok.com' || $host === 'www.tiktok.com') {
            return $current; // landed on a real TikTok page — nothing left to follow
        }

        $result = perform_redirect_request($current);
        if ($result['error'] !== null || $result['location'] === null) return null;

        // A relative Location is ambiguous about which host it belongs to —
        // reject rather than guess a base to resolve it against.
        if (!preg_match('#^https?://#i', $result['location'])) return null;

        $current = $result['location'];
    }

    return null; // exceeded the hop cap — treat as a redirect loop
}

/** True for TikTok's own share short-link hosts (vm.tiktok.com / vt.tiktok.com) — never for anything else. */
function is_tiktok_short_link(string $value): bool
{
    $normalized = normalize_tiktok_url($value);
    if ($normalized === null) return false;
    $host = url_host($normalized);
    return $host !== null && in_array($host, TIKTOK_SHORT_LINK_HOSTS, true);
}

// --- Upstream call -------------------------------------------------------

/**
 * Tests set $GLOBALS['tiktok_http_transport'] to a closure with this shape
 * before requiring this file (with TIKTOK_RESOLVE_TESTING defined), so no
 * real network call is ever made in automated tests. Same pattern as
 * twitch-status.php's perform_http_request.
 *
 * @return array{httpCode:int,body:?array,error:?string}
 */
function perform_upstream_request(string $url, array $headers): array
{
    $transport = $GLOBALS['tiktok_http_transport'] ?? null;
    if ($transport !== null) {
        return $transport($url, $headers);
    }
    return curl_json_request($url, $headers);
}

/** @return array{httpCode:int,body:?array,error:?string} */
function curl_json_request(string $url, array $headers): array
{
    if (!function_exists('curl_init')) {
        error_log('tiktok-resolve: curl extension not available');
        return ['httpCode' => 0, 'body' => null, 'error' => 'curl_unavailable'];
    }

    $received = 0;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => UPSTREAM_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => UPSTREAM_TIMEOUT_SECONDS,
        CURLOPT_FAILONERROR => false,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_NOPROGRESS => false,
        CURLOPT_PROGRESSFUNCTION => function ($res, $downloadSize, $downloaded) use (&$received) {
            $received = $downloaded;
            return $downloaded > UPSTREAM_MAX_BYTES ? 1 : 0; // non-zero aborts the transfer
        },
    ]);

    $raw = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErrno = curl_errno($ch);
    $curlError = curl_error($ch);

    if ($raw === false) {
        // Distinguished from a generic transport_error so the client can show
        // "taking too long to respond" instead of a vague connection failure.
        $reason = $received > UPSTREAM_MAX_BYTES
            ? 'response_too_large'
            : ($curlErrno === CURLE_OPERATION_TIMEDOUT ? 'timeout' : ($curlError ?: 'transport_error'));
        error_log("tiktok-resolve: upstream call failed: {$reason}"); // never logs the URL/headers — no username/referer leakage
        return ['httpCode' => 0, 'body' => null, 'error' => $reason];
    }

    $decoded = json_decode($raw, true);
    return ['httpCode' => $httpCode, 'body' => is_array($decoded) ? $decoded : null, 'error' => null];
}

/** @return array{httpCode:int,body:?array,error:?string} */
function call_tiktok_room_api(string $username): array
{
    $url = API_LIVE . '?' . http_build_query([
        'aid' => '1988',
        'sourceType' => '54',
        'uniqueId' => $username,
    ]);
    $headers = [
        'User-Agent: ' . USER_AGENT,
        'Referer: https://www.tiktok.com/@' . $username . '/live',
    ];
    return perform_upstream_request($url, $headers);
}

/** Bounded fallback call — see API_LIVE_DETAIL_FALLBACK's own doc comment for when/why. */
function call_tiktok_live_detail(string $roomId, string $username): array
{
    $url = API_LIVE_DETAIL_FALLBACK . '?' . http_build_query([
        'aid' => '1988',
        'roomID' => $roomId,
    ]);
    $headers = [
        'User-Agent: ' . USER_AGENT,
        'Referer: https://www.tiktok.com/@' . $username . '/live',
    ];
    return perform_upstream_request($url, $headers);
}

/**
 * Defensive extraction, not a single assumed path — checks the documented
 * shape (LiveRoomInfo.liveUrl, per the yt-dlp reference) first, then a bare
 * top-level liveUrl in case TikTok's response shape drifts. Same trust level
 * as the primary path's flv/hls URLs (see resolve_tiktok_live): this value
 * came from TikTok's own backend responding to a request this script built
 * itself from an already-validated username/roomId, never from anything
 * client-supplied, so no further host allow-listing is layered on top —
 * consistent with how the primary path already treats its CDN URLs.
 */
function extract_fallback_live_url(array $body): ?string
{
    $candidate = $body['LiveRoomInfo']['liveUrl'] ?? $body['liveUrl'] ?? null;
    if (!is_string($candidate) || $candidate === '') return null;
    if (!filter_var($candidate, FILTER_VALIDATE_URL)) return null;
    return $candidate;
}

/**
 * Internal-only diagnostic breadcrumb for the exact classification the
 * regression-correction directive asked for — never sent to the client
 * (respond() is never called with this), only error_log, so it can carry
 * detail (http statuses, candidate counts) freely without an exposure risk.
 */
function log_tiktok_diagnostics(array $diagnostics, string $finalState): void
{
    $diagnostics['final_state'] = $finalState;
    error_log('tiktok-resolve diagnostics: ' . json_encode($diagnostics));
}

/**
 * Extracts every flv/hls candidate from a parsed stream_data['data'] map.
 * flv entries are pushed first, in original quality-name order, so the
 * existing `qualities.find(q => q.id === 'hd')` client selection is exactly
 * as before; hls entries are appended after with a `-hls` suffixed id so
 * they never collide with an flv id, per "prefer HLS when the browser can
 * play it natively, otherwise fall back to the existing FLV/mpegts.js path"
 * (src/components/StreamGrid.ts's mountTikTokMedia does that selection).
 */
function extract_qualities_from_stream_data(array $streamData): array
{
    $qualities = [];
    $expiresAt = null;

    foreach ($streamData as $name => $info) {
        $flvUrl = $info['main']['flv'] ?? null;
        if (!is_string($flvUrl) || $flvUrl === '') continue;

        $expireParam = null;
        $query = parse_url($flvUrl, PHP_URL_QUERY);
        if (is_string($query)) {
            parse_str($query, $queryParams);
            $expireParam = $queryParams['expire'] ?? null;
        }
        if (is_string($expireParam) && ctype_digit($expireParam)) {
            $expiresAt = gmdate('Y-m-d\TH:i:s\Z', (int) $expireParam);
        }

        $qualities[] = ['id' => (string) $name, 'protocol' => 'flv', 'url' => $flvUrl];
    }

    foreach ($streamData as $name => $info) {
        $hlsUrl = $info['main']['hls'] ?? null;
        if (!is_string($hlsUrl) || $hlsUrl === '') continue;
        $qualities[] = ['id' => $name . '-hls', 'protocol' => 'hls', 'url' => $hlsUrl];
    }

    return ['qualities' => $qualities, 'expiresAt' => $expiresAt];
}

/** Same shape/logic as dev/tiktok-resolver/resolver.mjs's resolveTikTokLive, extended with the fallback path + diagnostics above. */
function resolve_tiktok_live(string $username): array
{
    $diagnostics = [
        'creator_resolved' => false,
        'room_id_found' => false,
        'live_status' => 'unknown',
        'primary_http_status' => null,
        'response_shape_recognized' => false,
        'flv_candidates' => 0,
        'hls_candidates' => 0,
        'hevc_available' => false,
        'fallback_attempted' => false,
        'fallback_result' => null,
        'final_playable_selected' => false,
    ];

    $result = call_tiktok_room_api($username);
    $diagnostics['primary_http_status'] = $result['httpCode'];

    if ($result['error'] !== null) {
        $state = $result['error'] === 'timeout' ? 'timeout' : 'network_error';
        log_tiktok_diagnostics($diagnostics, $state);
        return empty_result($state, $username, $result['error']);
    }

    if ($result['body'] === null) {
        log_tiktok_diagnostics($diagnostics, 'upstream_http_error');
        return empty_result('upstream_http_error', $username, "HTTP {$result['httpCode']}");
    }

    $json = $result['body'];

    if (($json['statusCode'] ?? null) !== 0) {
        log_tiktok_diagnostics($diagnostics, 'invalid_creator');
        return empty_result('invalid_creator', $username, (string) ($json['message'] ?? 'unknown'));
    }
    $diagnostics['creator_resolved'] = true;

    $room = $json['data']['liveRoom'] ?? null;
    if (!is_array($room)) {
        log_tiktok_diagnostics($diagnostics, 'provider_error');
        return empty_result('provider_error', $username, 'missing_liveRoom');
    }
    $diagnostics['response_shape_recognized'] = true;

    $roomId = $room['streamId'] ?? null;
    $diagnostics['room_id_found'] = is_string($roomId) || is_int($roomId);

    $roomStatus = $room['status'] ?? null;
    $diagnostics['live_status'] = $roomStatus === 2 ? 'live' : ($roomStatus === 4 ? 'offline' : 'unknown');

    if ($roomStatus === 4) {
        log_tiktok_diagnostics($diagnostics, 'offline');
        return tiktok_attach_avatar(empty_result('offline', $username, null, $room['title'] ?? null), $json, $username);
    }

    $hevcRaw = $room['hevcStreamData']['pull_data']['stream_data'] ?? null;
    $diagnostics['hevc_available'] = is_string($hevcRaw) && $hevcRaw !== '';

    $streamDataRaw = $room['streamData']['pull_data']['stream_data'] ?? null;
    $qualities = [];
    $expiresAt = null;
    $primaryState = 'no_stream_data'; // provisional — only used if we end up with zero qualities

    if (is_string($streamDataRaw) && $streamDataRaw !== '') {
        $parsed = json_decode($streamDataRaw, true);
        if (is_array($parsed) && isset($parsed['data']) && is_array($parsed['data'])) {
            $extracted = extract_qualities_from_stream_data($parsed['data']);
            $qualities = $extracted['qualities'];
            $expiresAt = $extracted['expiresAt'];
            $diagnostics['flv_candidates'] = count(array_filter($qualities, fn($q) => $q['protocol'] === 'flv'));
            $diagnostics['hls_candidates'] = count(array_filter($qualities, fn($q) => $q['protocol'] === 'hls'));
            $primaryState = 'no_playable_streams';
        } else {
            $primaryState = 'provider_error';
        }
    }

    // TikTok sometimes publishes only HEVC pull URLs for a confirmed-live
    // room. Standard H.264 candidates remain the first choice; HEVC is
    // exposed only when the standard payload produced nothing playable.
    if (empty($qualities) && is_string($hevcRaw) && $hevcRaw !== '') {
        $parsedHevc = json_decode($hevcRaw, true);
        if (is_array($parsedHevc) && isset($parsedHevc['data']) && is_array($parsedHevc['data'])) {
            $extractedHevc = extract_qualities_from_stream_data($parsedHevc['data']);
            if (!empty($extractedHevc['qualities'])) {
                $qualities = $extractedHevc['qualities'];
                $expiresAt = $extractedHevc['expiresAt'];
                $diagnostics['flv_candidates'] = count(array_filter($qualities, fn($q) => $q['protocol'] === 'flv'));
                $diagnostics['hls_candidates'] = count(array_filter($qualities, fn($q) => $q['protocol'] === 'hls'));
            }
        }
    }

    // Room is confirmed live but the primary call exposed nothing playable —
    // try the bounded fallback (see API_LIVE_DETAIL_FALLBACK doc comment)
    // before giving up. Never attempted when the primary call already
    // succeeded, and never attempted without a room id to ask about.
    if (empty($qualities) && $diagnostics['room_id_found']) {
        $diagnostics['fallback_attempted'] = true;
        $fallback = call_tiktok_live_detail((string) $roomId, $username);

        if ($fallback['error'] !== null) {
            $diagnostics['fallback_result'] = $fallback['error'] === 'timeout' ? 'timeout' : 'transport_error';
        } elseif ($fallback['body'] === null) {
            $diagnostics['fallback_result'] = "http_{$fallback['httpCode']}";
        } else {
            $fallbackUrl = extract_fallback_live_url($fallback['body']);
            if ($fallbackUrl !== null) {
                $qualities[] = ['id' => 'fallback-hls', 'protocol' => 'hls', 'url' => $fallbackUrl];
                $diagnostics['hls_candidates']++;
                $diagnostics['fallback_result'] = 'succeeded';
            } else {
                // Real-observed as of 2026-08-14: statusCode 10201 "live
                // detail API is deprecated" — recorded verbatim (bounded,
                // small) for future debugging without ever reaching the user.
                $diagnostics['fallback_result'] = 'no_usable_url:' . (string) ($fallback['body']['statusMsg'] ?? $fallback['body']['message'] ?? 'unknown');
            }
        }
    } elseif (empty($qualities)) {
        $diagnostics['fallback_result'] = 'no_room_id';
    }

    if (empty($qualities)) {
        log_tiktok_diagnostics($diagnostics, $primaryState);
        return empty_result($primaryState, $username, null, $room['title'] ?? null);
    }

    $diagnostics['final_playable_selected'] = true;
    log_tiktok_diagnostics($diagnostics, 'live');

    return tiktok_attach_avatar([
        'live' => true,
        'state' => 'live',
        'username' => $username,
        'title' => $room['title'] ?? null,
        'qualities' => $qualities,
        'expiresAt' => $expiresAt,
    ], $json, $username);
}

// --- Request handling ------------------------------------------------------
// Guarded so a test harness can `define('TIKTOK_RESOLVE_TESTING', true)` and
// `require` this file to get all the functions above without triggering a
// live HTTP request/response cycle.

if (!defined('TIKTOK_RESOLVE_TESTING')) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        http_response_code(405);
        respond(['error' => 'invalid_input', 'message' => 'Only POST is supported.']);
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    if (rate_limit_exceeded($ip)) {
        respond(empty_result('rate_limited', '', 'Too many requests — try again shortly.'));
    }

    $raw = file_get_contents('php://input');
    $payload = $raw !== false ? json_decode($raw, true) : null;

    if (!is_array($payload) || !isset($payload['url']) || !is_string($payload['url'])) {
        http_response_code(400);
        respond(['error' => 'invalid_input', 'message' => 'Request body must be {"url": "..."}.']);
    }

    $username = parse_tiktok_live_url($payload['url']);
    if ($username === null && is_tiktok_short_link($payload['url'])) {
        $normalized = normalize_tiktok_url($payload['url']);
        $resolvedUrl = $normalized !== null ? resolve_tiktok_short_link($normalized) : null;
        if ($resolvedUrl !== null) {
            $username = parse_tiktok_live_url($resolvedUrl);
        }
    }
    if ($username === null) {
        respond(empty_result('invalid_input', '', 'Not a recognizable TikTok LIVE URL.'));
    }

    $liveCacheKey = "tiktok:live:{$username}";
    $cached = cache_get($liveCacheKey);
    if (is_array($cached)) {
        respond($cached);
    }

    $result = resolve_tiktok_live($username);

    $ttl = match ($result['state']) {
        'live' => LIVE_CACHE_TTL,
        'offline' => OFFLINE_CACHE_TTL,
        'invalid_creator' => INVALID_CREATOR_CACHE_TTL,
        default => null, // transient upstream/network failures are never cached
    };
    if ($ttl !== null) cache_set($liveCacheKey, $result, $ttl);

    respond($result);
}
