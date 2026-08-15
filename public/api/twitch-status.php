<?php
/**
 * Twitch channel existence + live-status resolver for MultiStream.cc.
 *
 * Contract: POST /api/twitch-status.php, JSON body
 *   {"platform":"twitch","channels":["a","b",...]}
 * Always responds 200 application/json with {"platform":"twitch","results":[...]}
 * — one result per *input* element, in order, duplicates included. Each
 * result's `status` field ("live" | "offline" | "not_found" | "unavailable" |
 * "invalid_input") is what callers branch on, never the HTTP status (except
 * a 405 for a non-POST method) — see src/platforms/twitchStatus.ts.
 *
 * This is advisory only: a failure here must never prevent the frontend
 * from mounting the real Twitch embed, so every failure mode collapses to
 * a per-channel "unavailable" result rather than a thrown error.
 *
 * ---------------------------------------------------------------------
 * REQUIRED MANUAL SETUP (not part of this repo, not committed):
 *
 * 1. Create a config file OUTSIDE the web root containing a Twitch app's
 *    Client ID and Client Secret (from the Twitch Developer Console):
 *
 *      <?php
 *      return [
 *          'client_id' => 'YOUR_TWITCH_CLIENT_ID_HERE',
 *          'client_secret' => 'YOUR_TWITCH_CLIENT_SECRET_HERE',
 *      ];
 *
 *    On DreamHost, if this site's web root is ~/multistream.cc/, put that
 *    file at ~/multistream-secrets/twitch-config.php — the same directory
 *    youtube-config.php already lives in, one level above the web root.
 *
 * 2. That same ~/multistream-secrets/ directory must be writable by PHP —
 *    it also holds the file-based cache (a `cache/` subdirectory, shared
 *    with the YouTube resolver, created automatically). If it can't be
 *    created/written, this script logs a warning and simply runs without
 *    caching rather than failing requests.
 * ---------------------------------------------------------------------
 */

declare(strict_types=1);

// Never leak PHP errors/warnings (or anything else) into the response body.
error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// --- Configuration ---------------------------------------------------

// This file lives at <web-root>/api/twitch-status.php. Two levels up from
// __DIR__ (api/) is the DreamHost home directory in the common
// "~/<domain>/api/" layout — same assumption youtube-resolve.php makes.
// Guarded with defined() so a test harness can point these at a temp
// fixture directory before requiring this file.
if (!defined('TWITCH_CONFIG_PATH')) {
    define('TWITCH_CONFIG_PATH', dirname(__DIR__, 2) . '/multistream-secrets/twitch-config.php');
}
if (!defined('TWITCH_CACHE_DIR')) {
    // Shared with youtube-resolve.php's cache dir — cache keys below are
    // namespaced with a "twitch:" prefix before hashing, so there's no
    // collision with YouTube's "handle-resolve:"/"live:" keys.
    define('TWITCH_CACHE_DIR', dirname(__DIR__, 2) . '/multistream-secrets/cache');
}

define('MAX_CHANNELS_PER_REQUEST', 100); // Twitch Helix's own per-request login/user_login limit
define('USER_FOUND_CACHE_TTL', 24 * 60 * 60); // confirmed-existing profile rarely changes
define('USER_NOT_FOUND_CACHE_TTL', 60 * 60); // less certain long-term than a confirmed profile
define('LIVE_CACHE_TTL', 60);
define('OFFLINE_CACHE_TTL', 180);
define('TOKEN_REFRESH_MARGIN_SECONDS', 300);
define('LOCK_WAIT_MS', 150);
define('LOCK_WAIT_MAX_MS', 2000);
define('UPSTREAM_TIMEOUT_SECONDS', 5);

// --- Response helpers --------------------------------------------------

function respond(array $body): void
{
    echo json_encode($body);
    exit;
}

function respond_error(string $code, string $message): void
{
    respond(['status' => 'error', 'code' => $code, 'message' => $message]);
}

// --- Config -------------------------------------------------------------

/** @return array{client_id:string,client_secret:string}|null */
function load_twitch_credentials(): ?array
{
    static $cached = false; // false = not loaded yet, null = loaded but invalid, array = valid

    if ($cached !== false) return $cached;

    if (!is_readable(TWITCH_CONFIG_PATH)) {
        error_log('twitch-status: config file not readable at ' . TWITCH_CONFIG_PATH);
        $cached = null;
        return null;
    }

    $config = include TWITCH_CONFIG_PATH;
    if (
        !is_array($config) ||
        empty($config['client_id']) || !is_string($config['client_id']) ||
        empty($config['client_secret']) || !is_string($config['client_secret'])
    ) {
        error_log('twitch-status: config file did not return a valid client_id/client_secret');
        $cached = null;
        return null;
    }

    $cached = ['client_id' => $config['client_id'], 'client_secret' => $config['client_secret']];
    return $cached;
}

// --- File-based cache (best-effort; never fatal) -------------------------
// Identical shape to youtube-resolve.php's cache/lock functions.

function cache_dir_ready(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;

    if (!is_dir(TWITCH_CACHE_DIR)) {
        $ready = @mkdir(TWITCH_CACHE_DIR, 0700, true);
        if (!$ready) {
            error_log('twitch-status: could not create cache dir ' . TWITCH_CACHE_DIR . ' — continuing without caching');
        }
        return $ready;
    }

    $ready = is_writable(TWITCH_CACHE_DIR);
    if (!$ready) {
        error_log('twitch-status: cache dir not writable — continuing without caching');
    }
    return $ready;
}

function cache_path(string $key): string
{
    return TWITCH_CACHE_DIR . '/' . hash('sha256', $key) . '.json';
}

/** Returns the cached value (already TTL-checked) or null on miss/expired/unreadable. */
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
    $path = cache_path($key);
    $payload = json_encode(['expiresAt' => time() + $ttlSeconds, 'value' => $value]);
    if ($payload === false) return;
    @file_put_contents($path, $payload, LOCK_EX);
}

function cache_delete(string $key): void
{
    if (!cache_dir_ready()) return;
    @unlink(cache_path($key));
}

/** See youtube-resolve.php for the full contract this mirrors. */
function acquire_or_wait_lock(string $key)
{
    if (!cache_dir_ready()) return fopen('php://memory', 'r'); // no-op lock, caching is off anyway

    $lockPath = TWITCH_CACHE_DIR . '/' . hash('sha256', $key) . '.lock';
    $handle = @fopen($lockPath, 'c');
    if ($handle === false) return fopen('php://memory', 'r');

    if (flock($handle, LOCK_EX | LOCK_NB)) {
        return $handle;
    }

    $waited = 0;
    while ($waited < LOCK_WAIT_MAX_MS) {
        usleep(LOCK_WAIT_MS * 1000);
        $waited += LOCK_WAIT_MS;
        if (flock($handle, LOCK_EX | LOCK_NB)) {
            return $handle;
        }
    }

    fclose($handle);
    return null;
}

function release_lock($handle): void
{
    if ($handle === null) return;
    flock($handle, LOCK_UN);
    fclose($handle);
}

// --- HTTP transport (injectable for tests) --------------------------------

/**
 * Tests set $GLOBALS['twitch_http_transport'] to a closure with this shape
 * before requiring this file (with TWITCH_STATUS_TESTING defined), so no
 * real network call is ever made in automated tests.
 *
 * @return array{httpCode:int,body:?array,error:?string}
 */
function perform_http_request(string $method, string $url, array $params, array $headers): array
{
    $transport = $GLOBALS['twitch_http_transport'] ?? null;
    if ($transport !== null) {
        return $transport($method, $url, $params, $headers);
    }
    return curl_json_request($method, $url, $params, $headers);
}

/** @return array{httpCode:int,body:?array,error:?string} */
function curl_json_request(string $method, string $url, array $params, array $headers): array
{
    if (!function_exists('curl_init')) {
        error_log('twitch-status: curl extension not available');
        return ['httpCode' => 0, 'body' => null, 'error' => 'curl_unavailable'];
    }

    $ch = curl_init();
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => UPSTREAM_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => UPSTREAM_TIMEOUT_SECONDS,
        CURLOPT_FAILONERROR => false,
        CURLOPT_HTTPHEADER => $headers,
    ];

    if ($method === 'POST') {
        $opts[CURLOPT_URL] = $url;
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = http_build_query($params);
    } else {
        $opts[CURLOPT_URL] = $params ? ($url . '?' . http_build_query($params)) : $url;
    }

    curl_setopt_array($ch, $opts);
    $raw = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    // No curl_close() — a no-op since PHP 8.0; deprecated as of PHP 8.5.

    if ($raw === false) {
        error_log('twitch-status: curl error calling ' . $url . ': ' . $curlError);
        return ['httpCode' => 0, 'body' => null, 'error' => $curlError ?: 'transport_error'];
    }

    $decoded = json_decode($raw, true);
    return ['httpCode' => $httpCode, 'body' => is_array($decoded) ? $decoded : null, 'error' => null];
}

/** Builds a Twitch-style repeated-key query string, e.g. login=a&login=b. */
function build_repeated_query(string $key, array $values): string
{
    return implode('&', array_map(
        static fn(string $v): string => $key . '=' . rawurlencode($v),
        $values,
    ));
}

// --- Twitch app access token ------------------------------------------

/** @return string|null the token, or null (with $errorCode set) on failure */
function get_app_token(?string &$errorCode): ?string
{
    $cacheKey = 'twitch:app-token';
    $cached = cache_get($cacheKey);
    if (is_string($cached)) return $cached;

    $lock = acquire_or_wait_lock($cacheKey);
    if ($lock === null) {
        $cached = cache_get($cacheKey);
        if (is_string($cached)) return $cached;
    }

    try {
        $cached = cache_get($cacheKey);
        if (is_string($cached)) return $cached;

        $creds = load_twitch_credentials();
        if ($creds === null) {
            $errorCode = 'config_missing';
            return null;
        }

        $result = perform_http_request('POST', 'https://id.twitch.tv/oauth2/token', [
            'client_id' => $creds['client_id'],
            'client_secret' => $creds['client_secret'],
            'grant_type' => 'client_credentials',
        ], []);

        if ($result['httpCode'] !== 200 || !is_array($result['body']) || empty($result['body']['access_token'])) {
            error_log('twitch-status: token request failed, http ' . $result['httpCode']);
            $errorCode = 'auth_failed';
            return null;
        }

        $token = (string) $result['body']['access_token'];
        $expiresIn = (int) ($result['body']['expires_in'] ?? 3600);
        $ttl = max(60, $expiresIn - TOKEN_REFRESH_MARGIN_SECONDS);
        cache_set($cacheKey, $token, $ttl);
        return $token;
    } finally {
        release_lock($lock);
    }
}

/**
 * GETs a Helix endpoint with the app token, retrying once with a fresh
 * token after a 401. Returns the decoded body, or null with $errorCode set.
 */
function call_helix(string $path, string $queryString, ?string &$errorCode): ?array
{
    $token = get_app_token($errorCode);
    if ($token === null) return null;

    $creds = load_twitch_credentials();
    if ($creds === null) {
        $errorCode = 'config_missing';
        return null;
    }

    $url = 'https://api.twitch.tv/helix/' . $path . '?' . $queryString;
    $headers = ['Client-Id: ' . $creds['client_id'], 'Authorization: Bearer ' . $token];
    $result = perform_http_request('GET', $url, [], $headers);

    if ($result['httpCode'] === 401) {
        cache_delete('twitch:app-token');
        $token = get_app_token($errorCode);
        if ($token === null) return null;
        $headers = ['Client-Id: ' . $creds['client_id'], 'Authorization: Bearer ' . $token];
        $result = perform_http_request('GET', $url, [], $headers);
    }

    if ($result['httpCode'] === 429) {
        error_log('twitch-status: helix ' . $path . ' rate-limited');
        $errorCode = 'rate_limited';
        return null;
    }

    if ($result['httpCode'] !== 200 || !is_array($result['body'])) {
        error_log('twitch-status: helix ' . $path . ' returned http ' . $result['httpCode']);
        $errorCode = 'api_error';
        return null;
    }

    $errorCode = null;
    return $result['body'];
}

// --- Batch resolution ---------------------------------------------------

function normalize_login(string $raw): string
{
    return strtolower(trim(ltrim(trim($raw), '@')));
}

function is_valid_login(string $login): bool
{
    return (bool) preg_match('/^[a-z0-9_]{1,25}$/', $login);
}

/**
 * Resolves existence + display name for a set of already-normalized,
 * deduplicated logins. Checks cache first; only cache-miss logins go into
 * ONE batched /helix/users call (not one call per login).
 *
 * @param string[] $logins
 * @return array<string,array{exists:bool,displayName?:string}>|null null on upstream failure
 */
// A cached "exists" entry with no avatarUrl came from a Helix response that
// had an empty profile_image_url — real Twitch accounts always have one, so
// this almost always means a transient Helix hiccup got cached, not a true
// no-avatar user. Treat it as a miss so it self-heals on the next request
// instead of silently serving the gap for the full 24h TTL.
function user_cache_entry_stale(array $cached): bool
{
    return ($cached['exists'] ?? false) === true && empty($cached['avatarUrl']);
}

function resolve_users(array $logins, ?string &$errorCode): ?array
{
    $result = [];
    $misses = [];

    foreach ($logins as $login) {
        $cached = cache_get("twitch:user:{$login}");
        if (is_array($cached) && !user_cache_entry_stale($cached)) {
            $result[$login] = $cached;
        } else {
            $misses[] = $login;
        }
    }

    if (empty($misses)) return $result;

    // Best-effort de-dupe of concurrent identical requests. A login whose
    // lock can't be acquired quickly just rides along in the batch call
    // below anyway — never a correctness issue, only occasional duplicate work.
    $locks = [];
    foreach ($misses as $login) {
        $lock = acquire_or_wait_lock("twitch:user:{$login}");
        if ($lock !== null) $locks[$login] = $lock;
        $cached = cache_get("twitch:user:{$login}");
        if (is_array($cached) && !user_cache_entry_stale($cached)) $result[$login] = $cached;
    }

    $stillMissing = array_values(array_diff($misses, array_keys($result)));

    if (!empty($stillMissing)) {
        $body = call_helix('users', build_repeated_query('login', $stillMissing), $errorCode);

        if ($body === null) {
            foreach ($locks as $lock) release_lock($lock);
            return null;
        }

        $foundByLogin = [];
        foreach (($body['data'] ?? []) as $item) {
            if (empty($item['login'])) continue;
            $foundByLogin[strtolower((string) $item['login'])] = $item;
        }

        foreach ($stillMissing as $login) {
            if (isset($foundByLogin[$login])) {
                $item = $foundByLogin[$login];
                $entry = [
                    'exists' => true,
                    'displayName' => (string) ($item['display_name'] ?? $login),
                ];
                if (!empty($item['profile_image_url'])) {
                    $entry['avatarUrl'] = (string) $item['profile_image_url'];
                }
                cache_set("twitch:user:{$login}", $entry, USER_FOUND_CACHE_TTL);
            } else {
                $entry = ['exists' => false];
                cache_set("twitch:user:{$login}", $entry, USER_NOT_FOUND_CACHE_TTL);
            }
            $result[$login] = $entry;
        }
    }

    foreach ($locks as $lock) release_lock($lock);
    return $result;
}

/**
 * Resolves live/offline status for logins already confirmed to exist.
 * Same cache-first, single-batched-call shape as resolve_users.
 *
 * @param string[] $existingLogins
 * @return array<string,array>|null null on upstream failure
 */
function resolve_streams(array $existingLogins, ?string &$errorCode): ?array
{
    $result = [];
    $misses = [];

    foreach ($existingLogins as $login) {
        $cached = cache_get("twitch:live:{$login}");
        if (is_array($cached)) {
            $result[$login] = $cached;
        } else {
            $misses[] = $login;
        }
    }

    if (empty($misses)) return $result;

    $locks = [];
    foreach ($misses as $login) {
        $lock = acquire_or_wait_lock("twitch:live:{$login}");
        if ($lock !== null) $locks[$login] = $lock;
        $cached = cache_get("twitch:live:{$login}");
        if (is_array($cached)) $result[$login] = $cached;
    }

    $stillMissing = array_values(array_diff($misses, array_keys($result)));

    if (!empty($stillMissing)) {
        $body = call_helix('streams', build_repeated_query('user_login', $stillMissing), $errorCode);

        if ($body === null) {
            foreach ($locks as $lock) release_lock($lock);
            return null;
        }

        $liveByLogin = [];
        foreach (($body['data'] ?? []) as $item) {
            if (empty($item['user_login'])) continue;
            $liveByLogin[strtolower((string) $item['user_login'])] = $item;
        }

        foreach ($stillMissing as $login) {
            if (isset($liveByLogin[$login])) {
                $item = $liveByLogin[$login];
                $thumb = str_replace(['{width}', '{height}'], ['320', '180'], (string) ($item['thumbnail_url'] ?? ''));
                $entry = [
                    'status' => 'live',
                    'displayName' => (string) ($item['user_name'] ?? $login),
                    'title' => $item['title'] ?? null,
                    'category' => $item['game_name'] ?? null,
                    'viewerCount' => isset($item['viewer_count']) ? (int) $item['viewer_count'] : null,
                    'startedAt' => $item['started_at'] ?? null,
                    'thumbnailUrl' => $thumb !== '' ? $thumb : null,
                ];
                cache_set("twitch:live:{$login}", $entry, LIVE_CACHE_TTL);
            } else {
                $entry = ['status' => 'offline'];
                cache_set("twitch:live:{$login}", $entry, OFFLINE_CACHE_TTL);
            }
            $result[$login] = $entry;
        }
    }

    foreach ($locks as $lock) release_lock($lock);
    return $result;
}

/**
 * Orchestrates the whole batch: validate/normalize, resolve existence,
 * resolve live status for existing ones only, assemble one result per
 * input element (order and duplicates preserved). Never throws — every
 * upstream failure mode becomes a per-channel "unavailable" result.
 *
 * @param string[] $channels raw input strings, not yet normalized
 * @return array[] the response's "results" array
 */
function build_twitch_status_results(array $channels): array
{
    $normalizedByInput = [];
    $validLogins = [];

    foreach ($channels as $input) {
        $normalized = normalize_login((string) $input);
        $normalizedByInput[] = $normalized;
        if ($normalized !== '' && is_valid_login($normalized)) {
            $validLogins[$normalized] = true;
        }
    }

    $uniqueValidLogins = array_keys($validLogins);

    $usersErrorCode = null;
    $users = !empty($uniqueValidLogins) ? resolve_users($uniqueValidLogins, $usersErrorCode) : [];
    $usersFailed = ($users === null);

    $existingLogins = [];
    if (!$usersFailed) {
        foreach ($users as $login => $entry) {
            if (!empty($entry['exists'])) $existingLogins[] = $login;
        }
    }

    $streamsErrorCode = null;
    $streams = (!$usersFailed && !empty($existingLogins))
        ? resolve_streams($existingLogins, $streamsErrorCode)
        : [];
    $streamsFailed = ($streams === null);

    $results = [];
    foreach ($channels as $i => $input) {
        $normalized = $normalizedByInput[$i];

        if ($normalized === '' || !is_valid_login($normalized)) {
            $results[] = ['input' => $input, 'normalized' => $normalized, 'status' => 'invalid_input'];
            continue;
        }

        if ($usersFailed) {
            $results[] = ['input' => $input, 'normalized' => $normalized, 'status' => 'unavailable'];
            continue;
        }

        $userEntry = $users[$normalized] ?? null;
        if ($userEntry === null || empty($userEntry['exists'])) {
            $results[] = ['input' => $input, 'normalized' => $normalized, 'status' => 'not_found'];
            continue;
        }

        if ($streamsFailed) {
            $results[] = ['input' => $input, 'normalized' => $normalized, 'status' => 'unavailable'];
            continue;
        }

        $streamEntry = $streams[$normalized] ?? ['status' => 'offline'];
        if (($streamEntry['status'] ?? 'offline') === 'live') {
            $entry = array_merge(
                ['input' => $input, 'normalized' => $normalized, 'status' => 'live'],
                array_diff_key($streamEntry, ['status' => true]),
            );
            if (!empty($userEntry['avatarUrl'])) {
                $entry['avatarUrl'] = $userEntry['avatarUrl'];
            }
            $results[] = $entry;
        } else {
            $offlineEntry = [
                'input' => $input,
                'normalized' => $normalized,
                'status' => 'offline',
                'displayName' => $userEntry['displayName'] ?? $normalized,
            ];
            if (!empty($userEntry['avatarUrl'])) {
                $offlineEntry['avatarUrl'] = $userEntry['avatarUrl'];
            }
            $results[] = $offlineEntry;
        }
    }

    return $results;
}

// --- Request handling -----------------------------------------------------
// Guarded so a test harness can `define('TWITCH_STATUS_TESTING', true)` and
// `require` this file to get all the functions above without triggering a
// live HTTP request/response cycle.

if (!defined('TWITCH_STATUS_TESTING')) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        http_response_code(405);
        respond_error('invalid_input', 'Only POST is supported.');
    }

    $raw = file_get_contents('php://input');
    $payload = $raw !== false ? json_decode($raw, true) : null;

    if (!is_array($payload) || ($payload['platform'] ?? null) !== 'twitch') {
        respond_error('invalid_input', 'Request body must be {"platform":"twitch","channels":[...]}.');
    }

    $channels = $payload['channels'] ?? null;
    if (!is_array($channels) || count($channels) < 1 || count($channels) > MAX_CHANNELS_PER_REQUEST) {
        respond_error('invalid_input', 'channels must be an array of 1-' . MAX_CHANNELS_PER_REQUEST . ' items.');
    }

    foreach ($channels as $channel) {
        if (!is_string($channel)) {
            respond_error('invalid_input', 'Each channel must be a string.');
        }
    }

    respond(['platform' => 'twitch', 'results' => build_twitch_status_results($channels)]);
}
