<?php
/**
 * Kick channel live-status + metadata resolver for MultiStream.cc.
 *
 * Contract: POST /api/kick-status.php, JSON body
 *   {"platform":"kick","channels":["a","b",...]}
 * Always responds 200 application/json with {"platform":"kick","results":[...]}
 * — one result per *input* element, in order, duplicates included. Each
 * result's `status` field ("live" | "offline" | "not_found" | "unavailable" |
 * "not_configured" | "invalid_input") is what callers branch on, never the
 * HTTP status (except a 405 for a non-POST method) — see
 * src/platforms/kickStatus.ts.
 *
 * Deliberately the same shape as twitch-status.php (config outside the web
 * root, file cache + lock, injectable transport, app token with a refresh
 * margin, one batched upstream call per uncached set) so both providers stay
 * one architecture rather than two.
 *
 * This is advisory only. Kick playback does not depend on it in any way: the
 * embed is a plain iframe the browser mounts regardless, so every failure
 * mode here — including "no credentials installed at all" — collapses to a
 * per-channel status the frontend simply renders as "no metadata yet".
 *
 * WHY THE OFFICIAL API AND NOT THE OLD PUBLIC ONE: kick.com/api/v1|v2/* is
 * behind Cloudflare's bot WAF and answers 403 {"error":"Request blocked by
 * security policy."} to any server-side request. api.kick.com/public/v1/* is
 * the sanctioned replacement and is not behind that WAF (it answers a clean
 * 401 without a token), so this uses the documented OAuth 2.1
 * client-credentials flow instead of trying to look like a browser.
 *
 * ---------------------------------------------------------------------
 * REQUIRED MANUAL SETUP (not part of this repo, not committed):
 *
 * 1. Create an app at https://kick.com/settings/developer and copy its
 *    Client ID and Client Secret.
 *
 * 2. Create a config file OUTSIDE the web root:
 *
 *      <?php
 *      return [
 *          'client_id' => 'YOUR_KICK_CLIENT_ID_HERE',
 *          'client_secret' => 'YOUR_KICK_CLIENT_SECRET_HERE',
 *      ];
 *
 *    On DreamHost, if this site's web root is ~/multistream.cc/, put that
 *    file at ~/multistream-secrets/kick-config.php — the same directory
 *    twitch-config.php and youtube-config.php already live in, one level
 *    above the web root.
 *
 * 3. That same ~/multistream-secrets/ directory must be writable by PHP —
 *    it also holds the file-based cache (a `cache/` subdirectory, shared
 *    with the other resolvers, created automatically). If it can't be
 *    created/written, this script logs a warning and simply runs without
 *    caching rather than failing requests.
 *
 * Until step 2 is done every result comes back "not_configured" and the
 * cards render exactly as they do today — no viewer count, no duration, no
 * avatar, and a fully working player.
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

// This file lives at <web-root>/api/kick-status.php. Two levels up from
// __DIR__ (api/) is the DreamHost home directory in the common
// "~/<domain>/api/" layout — same assumption the other resolvers make.
// Guarded with defined() so a test harness can point these at a temp
// fixture directory before requiring this file.
if (!defined('KICK_CONFIG_PATH')) {
    define('KICK_CONFIG_PATH', dirname(__DIR__, 2) . '/multistream-secrets/kick-config.php');
}
if (!defined('KICK_CACHE_DIR')) {
    // Shared with the other resolvers' cache dir — cache keys below are
    // namespaced with a "kick:" prefix before hashing, so there's no
    // collision with the Twitch/YouTube keys.
    define('KICK_CACHE_DIR', dirname(__DIR__, 2) . '/multistream-secrets/cache');
}

define('KICK_TOKEN_URL', 'https://id.kick.com/oauth/token');
define('KICK_API_BASE', 'https://api.kick.com/public/v1/');

/**
 * Kick documents the batch parameters as ordinary repeated query keys
 * (?slug=a&slug=b), the OpenAPI "explode" form. Some client libraries send
 * the PHP-style bracketed form (?slug[]=a&slug[]=b) instead and Kick has
 * accepted both historically. If a future API revision only accepts one of
 * them, changing these two constants is the entire fix — nothing else in
 * this file hard-codes the parameter spelling.
 */
define('KICK_CHANNEL_QUERY_KEY', 'slug');
define('KICK_USER_QUERY_KEY', 'id');

define('KICK_MAX_CHANNELS_PER_REQUEST', 50); // Kick's own documented per-request batch limit
define('KICK_CHANNEL_CACHE_TTL', 60); // live viewer count must stay fresh
define('KICK_OFFLINE_CACHE_TTL', 180);
define('KICK_NOT_FOUND_CACHE_TTL', 60 * 60);
define('KICK_AVATAR_CACHE_TTL', 24 * 60 * 60); // a profile picture changes far less often than a viewer count
define('KICK_AVATAR_MISS_CACHE_TTL', 6 * 60 * 60); // don't re-ask /users all day when it has nothing for us
define('KICK_IDENTITY_CACHE_TTL', 7 * 24 * 60 * 60); // slug → broadcaster id + avatar; survives live↔offline
define('KICK_TOKEN_REFRESH_MARGIN_SECONDS', 300);
define('KICK_LOCK_WAIT_MS', 150);
define('KICK_LOCK_WAIT_MAX_MS', 2000);
define('KICK_UPSTREAM_TIMEOUT_SECONDS', 5);

// --- Response helpers --------------------------------------------------

function kick_respond(array $body): void
{
    echo json_encode($body);
    exit;
}

function kick_respond_error(string $code, string $message): void
{
    kick_respond(['status' => 'error', 'code' => $code, 'message' => $message]);
}

// --- Config -------------------------------------------------------------

/** @return array{client_id:string,client_secret:string}|null */
function load_kick_credentials(): ?array
{
    static $cached = false; // false = not loaded yet, null = loaded but invalid, array = valid

    if ($cached !== false) return $cached;

    if (!is_readable(KICK_CONFIG_PATH)) {
        // Not an error condition worth shouting about — this is the expected
        // state until the operator installs credentials, and the endpoint is
        // designed to degrade to "not_configured" cleanly.
        $cached = null;
        return null;
    }

    $config = include KICK_CONFIG_PATH;
    if (
        !is_array($config) ||
        empty($config['client_id']) || !is_string($config['client_id']) ||
        empty($config['client_secret']) || !is_string($config['client_secret'])
    ) {
        error_log('kick-status: config file did not return a valid client_id/client_secret');
        $cached = null;
        return null;
    }

    $cached = ['client_id' => $config['client_id'], 'client_secret' => $config['client_secret']];
    return $cached;
}

/** True only when a usable credential pair is installed. */
function kick_is_configured(): bool
{
    return load_kick_credentials() !== null;
}

// --- File-based cache (best-effort; never fatal) -------------------------
// Identical shape to twitch-status.php's cache/lock functions.

function kick_cache_dir_ready(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;

    if (!is_dir(KICK_CACHE_DIR)) {
        $ready = @mkdir(KICK_CACHE_DIR, 0700, true);
        if (!$ready) {
            error_log('kick-status: could not create cache dir ' . KICK_CACHE_DIR . ' — continuing without caching');
        }
        return $ready;
    }

    $ready = is_writable(KICK_CACHE_DIR);
    if (!$ready) {
        error_log('kick-status: cache dir not writable — continuing without caching');
    }
    return $ready;
}

function kick_cache_path(string $key): string
{
    return KICK_CACHE_DIR . '/' . hash('sha256', $key) . '.json';
}

/** Returns the cached value (already TTL-checked) or null on miss/expired/unreadable. */
function kick_cache_get(string $key): mixed
{
    if (!kick_cache_dir_ready()) return null;
    $path = kick_cache_path($key);
    if (!is_readable($path)) return null;

    $raw = @file_get_contents($path);
    if ($raw === false) return null;

    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !isset($decoded['expiresAt'], $decoded['value'])) return null;
    if (time() >= $decoded['expiresAt']) return null;

    return $decoded['value'];
}

function kick_cache_set(string $key, mixed $value, int $ttlSeconds): void
{
    if (!kick_cache_dir_ready()) return;
    $path = kick_cache_path($key);
    $payload = json_encode(['expiresAt' => time() + $ttlSeconds, 'value' => $value]);
    if ($payload === false) return;
    @file_put_contents($path, $payload, LOCK_EX);
}

function kick_cache_delete(string $key): void
{
    if (!kick_cache_dir_ready()) return;
    @unlink(kick_cache_path($key));
}

/** See twitch-status.php for the full contract this mirrors. */
function kick_acquire_or_wait_lock(string $key)
{
    if (!kick_cache_dir_ready()) return fopen('php://memory', 'r'); // no-op lock, caching is off anyway

    $lockPath = KICK_CACHE_DIR . '/' . hash('sha256', $key) . '.lock';
    $handle = @fopen($lockPath, 'c');
    if ($handle === false) return fopen('php://memory', 'r');

    if (flock($handle, LOCK_EX | LOCK_NB)) {
        return $handle;
    }

    $waited = 0;
    while ($waited < KICK_LOCK_WAIT_MAX_MS) {
        usleep(KICK_LOCK_WAIT_MS * 1000);
        $waited += KICK_LOCK_WAIT_MS;
        if (flock($handle, LOCK_EX | LOCK_NB)) {
            return $handle;
        }
    }

    fclose($handle);
    return null;
}

function kick_release_lock($handle): void
{
    if ($handle === null) return;
    flock($handle, LOCK_UN);
    fclose($handle);
}

// --- HTTP transport (injectable for tests) --------------------------------

/**
 * Tests set $GLOBALS['kick_http_transport'] to a closure with this shape
 * before requiring this file (with KICK_STATUS_TESTING defined), so no real
 * network call is ever made in automated tests.
 *
 * @return array{httpCode:int,body:?array,error:?string}
 */
function kick_perform_http_request(string $method, string $url, array $params, array $headers): array
{
    $transport = $GLOBALS['kick_http_transport'] ?? null;
    if ($transport !== null) {
        return $transport($method, $url, $params, $headers);
    }
    return kick_curl_json_request($method, $url, $params, $headers);
}

/** @return array{httpCode:int,body:?array,error:?string} */
function kick_curl_json_request(string $method, string $url, array $params, array $headers): array
{
    if (!function_exists('curl_init')) {
        error_log('kick-status: curl extension not available');
        return ['httpCode' => 0, 'body' => null, 'error' => 'curl_unavailable'];
    }

    $ch = curl_init();
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => KICK_UPSTREAM_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => KICK_UPSTREAM_TIMEOUT_SECONDS,
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
        error_log('kick-status: curl error calling ' . $url . ': ' . $curlError);
        return ['httpCode' => 0, 'body' => null, 'error' => $curlError ?: 'transport_error'];
    }

    $decoded = json_decode($raw, true);
    return ['httpCode' => $httpCode, 'body' => is_array($decoded) ? $decoded : null, 'error' => null];
}

/** Builds a repeated-key query string, e.g. slug=a&slug=b. */
function kick_build_repeated_query(string $key, array $values): string
{
    return implode('&', array_map(
        static fn($v): string => $key . '=' . rawurlencode((string) $v),
        $values,
    ));
}

// --- Kick app access token ------------------------------------------

/**
 * OAuth 2.1 client-credentials ("app access token") flow. The token is
 * cached for its full lifetime minus a refresh margin, so a normal polling
 * cycle costs zero token requests — only the first call after an expiry, or
 * a 401 retry, ever hits id.kick.com.
 *
 * @return string|null the token, or null (with $errorCode set) on failure
 */
function kick_get_app_token(?string &$errorCode): ?string
{
    $cacheKey = 'kick:app-token';
    $cached = kick_cache_get($cacheKey);
    if (is_string($cached)) return $cached;

    $lock = kick_acquire_or_wait_lock($cacheKey);
    if ($lock === null) {
        $cached = kick_cache_get($cacheKey);
        if (is_string($cached)) return $cached;
    }

    try {
        $cached = kick_cache_get($cacheKey);
        if (is_string($cached)) return $cached;

        $creds = load_kick_credentials();
        if ($creds === null) {
            $errorCode = 'not_configured';
            return null;
        }

        $result = kick_perform_http_request('POST', KICK_TOKEN_URL, [
            'client_id' => $creds['client_id'],
            'client_secret' => $creds['client_secret'],
            'grant_type' => 'client_credentials',
        ], []);

        if ($result['httpCode'] !== 200 || !is_array($result['body']) || empty($result['body']['access_token'])) {
            error_log('kick-status: token request failed, http ' . $result['httpCode']);
            $errorCode = 'auth_failed';
            return null;
        }

        $token = (string) $result['body']['access_token'];
        $expiresIn = (int) ($result['body']['expires_in'] ?? 3600);
        $ttl = max(60, $expiresIn - KICK_TOKEN_REFRESH_MARGIN_SECONDS);
        kick_cache_set($cacheKey, $token, $ttl);
        return $token;
    } finally {
        kick_release_lock($lock);
    }
}

/**
 * GETs a public-API endpoint with the app token, retrying once with a fresh
 * token after a 401. Returns the decoded body, or null with $errorCode set.
 */
function kick_call_api(string $path, string $queryString, ?string &$errorCode): ?array
{
    $token = kick_get_app_token($errorCode);
    if ($token === null) return null;

    $url = KICK_API_BASE . $path . ($queryString !== '' ? '?' . $queryString : '');
    $headers = ['Accept: application/json', 'Authorization: Bearer ' . $token];
    $result = kick_perform_http_request('GET', $url, [], $headers);

    if ($result['httpCode'] === 401) {
        kick_cache_delete('kick:app-token');
        $token = kick_get_app_token($errorCode);
        if ($token === null) return null;
        $headers = ['Accept: application/json', 'Authorization: Bearer ' . $token];
        $result = kick_perform_http_request('GET', $url, [], $headers);
    }

    if ($result['httpCode'] === 429) {
        error_log('kick-status: ' . $path . ' rate-limited');
        $errorCode = 'rate_limited';
        return null;
    }

    if ($result['httpCode'] !== 200 || !is_array($result['body'])) {
        error_log('kick-status: ' . $path . ' returned http ' . $result['httpCode']);
        $errorCode = 'api_error';
        return null;
    }

    $errorCode = null;
    return $result['body'];
}

// --- Normalization ------------------------------------------------------

function kick_normalize_slug(string $raw): string
{
    return strtolower(trim(ltrim(trim($raw), '@')));
}

/** Mirrors src/platforms/kick.ts's own handle pattern, lowercased. */
function kick_is_valid_slug(string $slug): bool
{
    return (bool) preg_match('/^[a-z0-9_-]{1,25}$/', $slug);
}

/**
 * Pulls a usable avatar URL straight out of a /channels item when one is
 * present. Kick has shipped this under more than one key across API
 * revisions and nests it under the broadcaster object in some responses, so
 * this checks every spelling that has been observed rather than betting on
 * one. `banner_picture` is deliberately NOT accepted: it's a wide channel
 * banner, not a profile picture, and would render as a mangled crop in the
 * Story Card's circular avatar slot — an initials fallback is the better
 * answer there.
 */
function kick_extract_avatar_url(array $item): ?string
{
    $candidates = [
        $item['profile_picture'] ?? null,
        $item['profile_image'] ?? null,
        $item['user']['profile_picture'] ?? null,
        $item['user']['profile_pic'] ?? null,
        $item['broadcaster']['profile_picture'] ?? null,
    ];

    foreach ($candidates as $candidate) {
        if (is_string($candidate) && $candidate !== '' && preg_match('#^https?://#i', $candidate)) {
            return $candidate;
        }
    }

    return null;
}

// --- Batch resolution ---------------------------------------------------

/**
 * Resolves channel + live state for a set of already-normalized,
 * deduplicated slugs. Cache-first; only cache-miss slugs go into ONE batched
 * /channels call, never one call per card.
 *
 * @param string[] $slugs
 * @return array<string,array>|null null on upstream failure
 */
function kick_resolve_channels(array $slugs, ?string &$errorCode): ?array
{
    $result = [];
    $misses = [];

    foreach ($slugs as $slug) {
        $cached = kick_cache_get("kick:channel:{$slug}");
        if (is_array($cached)) {
            $result[$slug] = $cached;
        } else {
            $misses[] = $slug;
        }
    }

    if (empty($misses)) return $result;

    // Best-effort de-dupe of concurrent identical requests. A slug whose lock
    // can't be acquired quickly just rides along in the batch call below
    // anyway — never a correctness issue, only occasional duplicate work.
    $locks = [];
    foreach ($misses as $slug) {
        $lock = kick_acquire_or_wait_lock("kick:channel:{$slug}");
        if ($lock !== null) $locks[$slug] = $lock;
        $cached = kick_cache_get("kick:channel:{$slug}");
        if (is_array($cached)) $result[$slug] = $cached;
    }

    $stillMissing = array_values(array_diff($misses, array_keys($result)));

    if (!empty($stillMissing)) {
        $body = kick_call_api(
            'channels',
            kick_build_repeated_query(KICK_CHANNEL_QUERY_KEY, $stillMissing),
            $errorCode,
        );

        if ($body === null) {
            foreach ($locks as $lock) kick_release_lock($lock);
            return null;
        }

        $bySlug = [];
        foreach (($body['data'] ?? []) as $item) {
            if (!is_array($item) || empty($item['slug'])) continue;
            $bySlug[strtolower((string) $item['slug'])] = $item;
        }

        foreach ($stillMissing as $slug) {
            if (!isset($bySlug[$slug])) {
                $entry = ['found' => false];
                kick_cache_set("kick:channel:{$slug}", $entry, KICK_NOT_FOUND_CACHE_TTL);
                $result[$slug] = $entry;
                continue;
            }

            $item = $bySlug[$slug];
            $stream = is_array($item['stream'] ?? null) ? $item['stream'] : [];
            $isLive = !empty($stream['is_live']);
            $category = null;
            if (is_array($item['category'] ?? null) && !empty($item['category']['name'])) {
                $category = (string) $item['category']['name'];
            }

            $entry = [
                'found' => true,
                'live' => $isLive,
                'broadcasterUserId' => isset($item['broadcaster_user_id'])
                    ? (int) $item['broadcaster_user_id']
                    : null,
                'displayName' => (string) ($item['slug'] ?? $slug),
                'avatarUrl' => kick_extract_avatar_url($item),
            ];

            $identityKey = "kick:identity:{$slug}";
            $identity = kick_cache_get($identityKey);
            if (is_array($identity)) {
                if (empty($entry['avatarUrl']) && !empty($identity['avatarUrl'])) {
                    $entry['avatarUrl'] = $identity['avatarUrl'];
                }
                if (empty($entry['broadcasterUserId']) && !empty($identity['broadcasterUserId'])) {
                    $entry['broadcasterUserId'] = $identity['broadcasterUserId'];
                }
                if (($entry['displayName'] ?? '') === $slug && !empty($identity['displayName'])) {
                    $entry['displayName'] = $identity['displayName'];
                }
            }
            if (!empty($entry['broadcasterUserId']) || !empty($entry['avatarUrl'])) {
                kick_cache_set($identityKey, [
                    'broadcasterUserId' => $entry['broadcasterUserId'] ?? null,
                    'avatarUrl' => $entry['avatarUrl'] ?? null,
                    'displayName' => $entry['displayName'] ?? null,
                ], KICK_IDENTITY_CACHE_TTL);
            }

            if ($isLive) {
                $entry['title'] = isset($item['stream_title']) ? (string) $item['stream_title'] : null;
                $entry['category'] = $category;
                $entry['viewerCount'] = isset($stream['viewer_count']) ? (int) $stream['viewer_count'] : null;
                $entry['startedAt'] = !empty($stream['start_time']) ? (string) $stream['start_time'] : null;
            }

            kick_cache_set(
                "kick:channel:{$slug}",
                $entry,
                $isLive ? KICK_CHANNEL_CACHE_TTL : KICK_OFFLINE_CACHE_TTL,
            );
            $result[$slug] = $entry;
        }
    }

    foreach ($locks as $lock) kick_release_lock($lock);
    return $result;
}

/**
 * Fills in avatars for broadcasters whose /channels entry didn't carry one.
 *
 * This is NOT a second avatar pipeline — it's the same request chain, one
 * extra hop, and only for the ids that genuinely came back without a picture.
 * It's batched, cached for a day on a hit and hours on a miss (so a Kick
 * plan that never exposes /users to app tokens costs at most one failed call
 * per broadcaster per KICK_AVATAR_MISS_CACHE_TTL), and a failure is silently
 * absorbed — an avatar is the least important field in the response and must
 * never turn a good viewer count into an "unavailable".
 *
 * @param int[] $userIds
 * @return array<int,?string> user id -> avatar url (null = known to have none)
 */
function kick_resolve_avatars(array $userIds): array
{
    $result = [];
    $misses = [];

    foreach ($userIds as $userId) {
        $cached = kick_cache_get("kick:avatar:{$userId}");
        if (is_array($cached) && array_key_exists('avatarUrl', $cached)) {
            $result[$userId] = is_string($cached['avatarUrl']) ? $cached['avatarUrl'] : null;
        } else {
            $misses[] = $userId;
        }
    }

    if (empty($misses)) return $result;

    $errorCode = null;
    $body = kick_call_api(
        'users',
        kick_build_repeated_query(KICK_USER_QUERY_KEY, $misses),
        $errorCode,
    );

    if ($body === null) {
        // Leave every miss unresolved and uncached-as-miss only if this looks
        // transient; a hard refusal (no scope for app tokens) is exactly the
        // case worth remembering so we stop asking.
        if ($errorCode === 'api_error') {
            foreach ($misses as $userId) {
                kick_cache_set("kick:avatar:{$userId}", ['avatarUrl' => null], KICK_AVATAR_MISS_CACHE_TTL);
                $result[$userId] = null;
            }
        }
        return $result;
    }

    $byId = [];
    foreach (($body['data'] ?? []) as $item) {
        if (!is_array($item) || !isset($item['user_id'])) continue;
        $byId[(int) $item['user_id']] = $item;
    }

    foreach ($misses as $userId) {
        $avatarUrl = isset($byId[$userId]) ? kick_extract_avatar_url($byId[$userId]) : null;
        kick_cache_set(
            "kick:avatar:{$userId}",
            ['avatarUrl' => $avatarUrl],
            $avatarUrl !== null ? KICK_AVATAR_CACHE_TTL : KICK_AVATAR_MISS_CACHE_TTL,
        );
        $result[$userId] = $avatarUrl;
    }

    return $result;
}

/**
 * Orchestrates the whole batch: validate/normalize, resolve channels,
 * backfill any missing avatars, assemble one result per input element (order
 * and duplicates preserved). Never throws — every upstream failure mode
 * becomes a per-channel "unavailable", and a missing config becomes
 * "not_configured", which the frontend renders as "no metadata" rather than
 * as an error.
 *
 * @param string[] $channels raw input strings, not yet normalized
 * @return array[] the response's "results" array
 */
function build_kick_status_results(array $channels): array
{
    $normalizedByInput = [];
    $validSlugs = [];

    foreach ($channels as $input) {
        $normalized = kick_normalize_slug((string) $input);
        $normalizedByInput[] = $normalized;
        if ($normalized !== '' && kick_is_valid_slug($normalized)) {
            $validSlugs[$normalized] = true;
        }
    }

    $configured = kick_is_configured();
    $uniqueValidSlugs = array_keys($validSlugs);

    $errorCode = null;
    $channelsResult = ($configured && !empty($uniqueValidSlugs))
        ? kick_resolve_channels($uniqueValidSlugs, $errorCode)
        : [];
    $channelsFailed = ($channelsResult === null);

    $avatars = [];
    if (!$channelsFailed && !empty($channelsResult)) {
        $needAvatar = [];
        foreach ($channelsResult as $entry) {
            if (empty($entry['found'])) continue;
            if (!empty($entry['avatarUrl'])) continue;
            $userId = $entry['broadcasterUserId'] ?? null;
            if (is_int($userId) && $userId > 0) $needAvatar[$userId] = true;
        }
        if (!empty($needAvatar)) {
            $avatars = kick_resolve_avatars(array_keys($needAvatar));
        }
    }

    $results = [];
    foreach ($channels as $i => $input) {
        $normalized = $normalizedByInput[$i];

        if ($normalized === '' || !kick_is_valid_slug($normalized)) {
            $results[] = ['input' => $input, 'normalized' => $normalized, 'status' => 'invalid_input'];
            continue;
        }

        if (!$configured) {
            $results[] = ['input' => $input, 'normalized' => $normalized, 'status' => 'not_configured'];
            continue;
        }

        if ($channelsFailed) {
            $results[] = ['input' => $input, 'normalized' => $normalized, 'status' => 'unavailable'];
            continue;
        }

        $entry = $channelsResult[$normalized] ?? null;
        if ($entry === null || empty($entry['found'])) {
            $results[] = ['input' => $input, 'normalized' => $normalized, 'status' => 'not_found'];
            continue;
        }

        $avatarUrl = $entry['avatarUrl'] ?? null;
        if (!is_string($avatarUrl) || $avatarUrl === '') {
            $userId = $entry['broadcasterUserId'] ?? null;
            $avatarUrl = (is_int($userId) && isset($avatars[$userId])) ? $avatars[$userId] : null;
        }
        if (!is_string($avatarUrl) || $avatarUrl === '') {
            $identity = kick_cache_get("kick:identity:{$normalized}");
            if (is_array($identity) && is_string($identity['avatarUrl'] ?? null) && $identity['avatarUrl'] !== '') {
                $avatarUrl = $identity['avatarUrl'];
            }
        }

        $out = [
            'input' => $input,
            'normalized' => $normalized,
            'status' => !empty($entry['live']) ? 'live' : 'offline',
            'displayName' => (string) ($entry['displayName'] ?? $normalized),
        ];

        if (!empty($entry['live'])) {
            // Only ever attached to a live result — an offline card must not
            // render a stale viewer count or a duration that keeps ticking.
            if (isset($entry['title']) && $entry['title'] !== null) $out['title'] = $entry['title'];
            if (isset($entry['category']) && $entry['category'] !== null) $out['category'] = $entry['category'];
            if (isset($entry['viewerCount']) && $entry['viewerCount'] !== null) {
                $out['viewerCount'] = (int) $entry['viewerCount'];
            }
            if (isset($entry['startedAt']) && $entry['startedAt'] !== null) {
                $out['startedAt'] = (string) $entry['startedAt'];
            }
        }

        if (is_string($avatarUrl) && $avatarUrl !== '') {
            $out['avatarUrl'] = $avatarUrl;
        }

        $results[] = $out;
    }

    return $results;
}

// --- Request handling -----------------------------------------------------
// Guarded so a test harness can `define('KICK_STATUS_TESTING', true)` and
// `require` this file to get all the functions above without triggering a
// live HTTP request/response cycle.

if (!defined('KICK_STATUS_TESTING')) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        http_response_code(405);
        kick_respond_error('invalid_input', 'Only POST is supported.');
    }

    $raw = file_get_contents('php://input');
    $payload = $raw !== false ? json_decode($raw, true) : null;

    if (!is_array($payload) || ($payload['platform'] ?? null) !== 'kick') {
        kick_respond_error('invalid_input', 'Request body must be {"platform":"kick","channels":[...]}.');
    }

    $channels = $payload['channels'] ?? null;
    if (!is_array($channels) || count($channels) < 1 || count($channels) > KICK_MAX_CHANNELS_PER_REQUEST) {
        kick_respond_error('invalid_input', 'channels must be an array of 1-' . KICK_MAX_CHANNELS_PER_REQUEST . ' items.');
    }

    foreach ($channels as $channel) {
        if (!is_string($channel)) {
            kick_respond_error('invalid_input', 'Each channel must be a string.');
        }
    }

    kick_respond(['platform' => 'kick', 'results' => build_kick_status_results($channels)]);
}
