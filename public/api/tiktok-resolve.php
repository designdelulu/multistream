<?php
/**
 * Experimental TikTok LIVE resolver for MultiStream.cc — NOT an official
 * TikTok integration. See docs/TIKTOK.md for the full architecture and
 * risk writeup; this file is the production implementation of the same
 * logic prototyped in dev/tiktok-resolver/resolver.mjs.
 *
 * Contract: POST /api/tiktok-resolve.php, JSON body {"url": "..."}
 * (a TikTok LIVE URL, e.g. https://www.tiktok.com/@handle/live). Always
 * responds 200 application/json with a TikTokResolveResult shape (see
 * src/platforms/tiktok.ts) — {live, state, username, title, qualities,
 * expiresAt, error?}. Only a 405 (wrong method) or 400 (malformed JSON
 * body) ever use a non-200 status; every TikTok-side outcome (offline,
 * invalid creator, upstream failure) is a normal 200 with `state` set.
 *
 * Calls the same unauthenticated, undocumented endpoint TikTok's own web
 * client and Streamlink's `tiktok` plugin use
 * (https://www.tiktok.com/api-live/user/room) — no cookies, no login, no
 * access-control bypass. This is the same request a logged-out browser
 * makes loading the live page directly.
 *
 * Security posture (see docs/TIKTOK.md "Resolver safety"):
 *   - The client-supplied `url` is only ever used to extract and validate
 *     a username; this script never fetches a client-supplied URL. It
 *     always constructs the upstream request itself against a fixed host
 *     (api-live/user/room), so there is no SSRF / open-proxy surface.
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

const API_LIVE = 'https://www.tiktok.com/api-live/user/room';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';

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

/** Returns the validated handle, or null. Never fetches the input URL — only parses it. */
function parse_tiktok_live_url(string $value): ?string
{
    $value = trim($value);
    if ($value === '') return null;
    if (!str_starts_with($value, 'http')) $value = 'https://' . $value;

    $parts = parse_url($value);
    if ($parts === false || empty($parts['host'])) return null;

    $host = strtolower($parts['host']);
    if ($host !== 'tiktok.com' && $host !== 'www.tiktok.com') return null;

    $segments = array_values(array_filter(explode('/', $parts['path'] ?? ''), fn($s) => $s !== ''));
    $first = $segments[0] ?? '';
    if (!str_starts_with($first, '@')) return null;

    $handle = substr($first, 1);
    if (!preg_match('/^[a-zA-Z0-9_.]{1,64}$/', $handle)) return null;

    if (count($segments) === 1) return strtolower($handle);
    if (count($segments) === 2 && strtolower($segments[1]) === 'live') return strtolower($handle);

    return null;
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
    $curlError = curl_error($ch);

    if ($raw === false) {
        $reason = $received > UPSTREAM_MAX_BYTES ? 'response_too_large' : ($curlError ?: 'transport_error');
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

/** Same shape/logic as dev/tiktok-resolver/resolver.mjs's resolveTikTokLive. */
function resolve_tiktok_live(string $username): array
{
    $result = call_tiktok_room_api($username);

    if ($result['error'] !== null) {
        return empty_result('network_error', $username, $result['error']);
    }

    if ($result['body'] === null) {
        return empty_result('upstream_http_error', $username, "HTTP {$result['httpCode']}");
    }

    $json = $result['body'];

    if (($json['statusCode'] ?? null) !== 0) {
        return empty_result('invalid_creator', $username, (string) ($json['message'] ?? 'unknown'));
    }

    $room = $json['data']['liveRoom'] ?? null;
    if (!is_array($room)) {
        return empty_result('provider_error', $username, 'missing_liveRoom');
    }

    if (($room['status'] ?? null) === 4) {
        return empty_result('offline', $username, null, $room['title'] ?? null);
    }

    $streamDataRaw = $room['streamData']['pull_data']['stream_data'] ?? null;
    if (!is_string($streamDataRaw) || $streamDataRaw === '') {
        return empty_result('no_stream_data', $username, null, $room['title'] ?? null);
    }

    $parsed = json_decode($streamDataRaw, true);
    if (!is_array($parsed) || !isset($parsed['data']) || !is_array($parsed['data'])) {
        return empty_result('provider_error', $username, 'unparseable_stream_data');
    }

    $qualities = [];
    $expiresAt = null;
    foreach ($parsed['data'] as $name => $info) {
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

    if (empty($qualities)) {
        return empty_result('no_playable_streams', $username, null, $room['title'] ?? null);
    }

    return [
        'live' => true,
        'state' => 'live',
        'username' => $username,
        'title' => $room['title'] ?? null,
        'qualities' => $qualities,
        'expiresAt' => $expiresAt,
    ];
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
