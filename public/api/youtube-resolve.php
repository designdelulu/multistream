<?php
/**
 * YouTube channel/live resolver for MultiStream.cc.
 *
 * Contract: GET /api/youtube-resolve.php?mode={handle|username|channelId}&value=...
 * Always responds 200 application/json; the *body*'s `status` field
 * ("live" | "offline" | "error") is what callers branch on, never the HTTP
 * status — see src/platforms/youtubeResolver.ts on the frontend.
 *
 * Only handle/username/channelId lookups ever reach this file. Direct video
 * URLs are parsed entirely client-side (src/platforms/youtube.ts) and never
 * call this endpoint — that keeps quota usage to exactly the inputs that
 * genuinely need a live-status check.
 *
 * ---------------------------------------------------------------------
 * REQUIRED MANUAL SETUP (not part of this repo, not committed):
 *
 * 1. Create a config file OUTSIDE the web root containing your YouTube Data
 *    API v3 key:
 *
 *      <?php
 *      return [
 *          'api_key' => 'YOUR_YOUTUBE_DATA_API_KEY_HERE',
 *      ];
 *
 *    On DreamHost, if this site's web root is ~/multistream.cc/, put that
 *    file at ~/multistream-secrets/youtube-config.php — i.e. one level
 *    above the web root, in your DreamHost home directory. Adjust
 *    YOUTUBE_CONFIG_PATH below if your account's layout differs (it
 *    varies — this repo cannot know your actual home-directory path).
 *
 * 2. That same ~/multistream-secrets/ directory must be writable by PHP —
 *    it also holds the file-based cache (a `cache/` subdirectory, created
 *    automatically). If it can't be created/written, this script logs a
 *    warning and simply runs without caching rather than failing requests.
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

// This file lives at <web-root>/api/youtube-resolve.php. Two levels up
// from __DIR__ (api/) is the DreamHost home directory in the common
// "~/<domain>/api/" layout — adjust if your account differs.
define('YOUTUBE_CONFIG_PATH', dirname(__DIR__, 2) . '/multistream-secrets/youtube-config.php');
define('YOUTUBE_CACHE_DIR', dirname(__DIR__, 2) . '/multistream-secrets/cache');

define('HANDLE_CACHE_TTL', 24 * 60 * 60); // handle/username -> channelId rarely changes
define('LIVE_CACHE_TTL', 60); // currently-live result
define('OFFLINE_CACHE_TTL', 180); // currently-offline (negative cache)
define('LOCK_WAIT_MS', 150);
define('LOCK_WAIT_MAX_MS', 2000);
define('UPSTREAM_TIMEOUT_SECONDS', 5);

// --- Response helpers --------------------------------------------------

// (No `never` return type — kept PHP 8.0-compatible; `exit`/`respond()` still halt execution.)
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

function load_api_key(): ?string
{
    if (!is_readable(YOUTUBE_CONFIG_PATH)) {
        error_log("youtube-resolve: config file not readable at " . YOUTUBE_CONFIG_PATH);
        return null;
    }
    $config = include YOUTUBE_CONFIG_PATH;
    if (!is_array($config) || empty($config['api_key']) || !is_string($config['api_key'])) {
        error_log('youtube-resolve: config file did not return a valid api_key');
        return null;
    }
    return $config['api_key'];
}

// --- File-based cache (best-effort; never fatal) -------------------------

function cache_dir_ready(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;

    if (!is_dir(YOUTUBE_CACHE_DIR)) {
        $ready = @mkdir(YOUTUBE_CACHE_DIR, 0700, true);
        if (!$ready) {
            error_log('youtube-resolve: could not create cache dir ' . YOUTUBE_CACHE_DIR . ' — continuing without caching');
        }
        return $ready;
    }

    $ready = is_writable(YOUTUBE_CACHE_DIR);
    if (!$ready) {
        error_log('youtube-resolve: cache dir not writable — continuing without caching');
    }
    return $ready;
}

function cache_path(string $key): string
{
    return YOUTUBE_CACHE_DIR . '/' . hash('sha256', $key) . '.json';
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

// --- Best-effort concurrent de-dupe --------------------------------------

/**
 * Acquires an exclusive lock for $key, or waits briefly for a concurrent
 * resolver to finish and populate the cache instead. Returns:
 *   - a lock resource: caller now owns the resolution, must release_lock()
 *     when done (whether or not it wrote to cache)
 *   - null: another request just finished — caller should re-check
 *     cache_get() for a fresh result before falling back to calling the API
 *     itself (only happens if that concurrent write also somehow missed).
 */
function acquire_or_wait_lock(string $key)
{
    if (!cache_dir_ready()) return fopen('php://memory', 'r'); // no-op lock, caching is off anyway

    $lockPath = YOUTUBE_CACHE_DIR . '/' . hash('sha256', $key) . '.lock';
    $handle = @fopen($lockPath, 'c');
    if ($handle === false) return fopen('php://memory', 'r');

    if (flock($handle, LOCK_EX | LOCK_NB)) {
        return $handle;
    }

    // Someone else is resolving this key right now — wait briefly for them
    // to finish rather than firing a duplicate upstream call.
    $waited = 0;
    while ($waited < LOCK_WAIT_MAX_MS) {
        usleep(LOCK_WAIT_MS * 1000);
        $waited += LOCK_WAIT_MS;
        if (flock($handle, LOCK_EX | LOCK_NB)) {
            return $handle;
        }
    }

    // Gave up waiting — proceed independently rather than risk a deadlock.
    fclose($handle);
    return null;
}

function release_lock($handle): void
{
    if ($handle === null) return;
    flock($handle, LOCK_UN);
    fclose($handle);
}

// --- YouTube Data API calls -----------------------------------------------

/**
 * @return array{ok:true,data:array}|array{ok:false,code:string}
 */
function youtube_api_get(string $path, array $params, string $apiKey): array
{
    if (!function_exists('curl_init')) {
        error_log('youtube-resolve: curl extension not available');
        return ['ok' => false, 'code' => 'api_error'];
    }

    $params['key'] = $apiKey;
    $url = 'https://www.googleapis.com/youtube/v3/' . $path . '?' . http_build_query($params);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => UPSTREAM_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => UPSTREAM_TIMEOUT_SECONDS,
        CURLOPT_FAILONERROR => false,
    ]);
    $body = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    // No curl_close() — a no-op since PHP 8.0 (handles are GC'd automatically);
    // calling it is deprecated as of PHP 8.5.

    if ($body === false) {
        error_log('youtube-resolve: curl error calling ' . $path . ': ' . $curlError);
        return ['ok' => false, 'code' => 'api_error'];
    }

    $decoded = json_decode($body, true);

    if ($httpCode === 403 && is_array($decoded)) {
        $reasons = array_column($decoded['error']['errors'] ?? [], 'reason');
        if (in_array('quotaExceeded', $reasons, true) || in_array('dailyLimitExceeded', $reasons, true)) {
            return ['ok' => false, 'code' => 'quota_exceeded'];
        }
    }

    if ($httpCode !== 200 || !is_array($decoded)) {
        error_log('youtube-resolve: upstream ' . $path . ' returned HTTP ' . $httpCode);
        return ['ok' => false, 'code' => 'api_error'];
    }

    return ['ok' => true, 'data' => $decoded];
}

/** @return array{ok:true,channelId:string}|array{ok:false,code:string} */
function resolve_channel_id(string $mode, string $value, string $apiKey): array
{
    if ($mode === 'channelId') {
        return ['ok' => true, 'channelId' => $value];
    }

    $cacheKey = "handle-resolve:{$mode}:{$value}";
    $cached = cache_get($cacheKey);
    if (is_string($cached)) {
        return ['ok' => true, 'channelId' => $cached];
    }

    $lock = acquire_or_wait_lock($cacheKey);
    if ($lock === null) {
        $cached = cache_get($cacheKey);
        if (is_string($cached)) {
            return ['ok' => true, 'channelId' => $cached];
        }
    }

    try {
        // A concurrent request may have just populated this while we waited.
        $cached = cache_get($cacheKey);
        if (is_string($cached)) {
            return ['ok' => true, 'channelId' => $cached];
        }

        $params = $mode === 'handle'
            ? ['forHandle' => '@' . ltrim($value, '@'), 'part' => 'id']
            : ['forUsername' => $value, 'part' => 'id'];

        $result = youtube_api_get('channels', $params, $apiKey);
        if (!$result['ok']) {
            return $result;
        }

        $items = $result['data']['items'] ?? [];
        if (empty($items) || empty($items[0]['id'])) {
            return ['ok' => false, 'code' => 'channel_not_found'];
        }

        $channelId = $items[0]['id'];
        cache_set($cacheKey, $channelId, HANDLE_CACHE_TTL);
        return ['ok' => true, 'channelId' => $channelId];
    } finally {
        release_lock($lock);
    }
}

/** @return array (the final response body) */
function resolve_live_video(string $channelId, string $apiKey): array
{
    $cacheKey = "live:{$channelId}";
    $cached = cache_get($cacheKey);
    if (is_array($cached)) {
        return $cached;
    }

    $lock = acquire_or_wait_lock($cacheKey);
    if ($lock === null) {
        $cached = cache_get($cacheKey);
        if (is_array($cached)) {
            return $cached;
        }
    }

    try {
        $cached = cache_get($cacheKey);
        if (is_array($cached)) {
            return $cached;
        }

        $result = youtube_api_get('search', [
            'channelId' => $channelId,
            'eventType' => 'live',
            'type' => 'video',
            'videoEmbeddable' => 'true',
            'part' => 'snippet',
            'maxResults' => 1,
        ], $apiKey);

        if (!$result['ok']) {
            // Upstream/quota errors are never cached — a transient failure
            // should not poison the next request for the rest of its TTL.
            return ['status' => 'error', 'code' => $result['code'], 'message' => api_error_message($result['code'])];
        }

        $items = $result['data']['items'] ?? [];
        if (empty($items)) {
            $body = ['status' => 'offline', 'channelId' => $channelId];
            cache_set($cacheKey, $body, OFFLINE_CACHE_TTL);
            return $body;
        }

        $item = $items[0];
        $body = [
            'status' => 'live',
            'videoId' => $item['id']['videoId'] ?? '',
            'title' => $item['snippet']['title'] ?? null,
            'channelId' => $channelId,
            'channelTitle' => $item['snippet']['channelTitle'] ?? null,
        ];

        if ($body['videoId'] === '') {
            return ['status' => 'error', 'code' => 'api_error', 'message' => api_error_message('api_error')];
        }

        cache_set($cacheKey, $body, LIVE_CACHE_TTL);
        return $body;
    } finally {
        release_lock($lock);
    }
}

function api_error_message(string $code): string
{
    return match ($code) {
        'quota_exceeded' => 'YouTube API quota exceeded — try again later.',
        default => 'YouTube lookup failed — try again.',
    };
}

// --- Request handling -----------------------------------------------------

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    respond_error('invalid_input', 'Only GET is supported.');
}

$mode = $_GET['mode'] ?? '';
$value = $_GET['value'] ?? '';

if (!in_array($mode, ['handle', 'username', 'channelId'], true) || !is_string($value)) {
    respond_error('invalid_input', 'Missing or invalid mode/value.');
}

$value = trim($value);

$valid = match ($mode) {
    'handle' => (bool) preg_match('/^[A-Za-z0-9._-]{1,100}$/', ltrim($value, '@')),
    'username' => (bool) preg_match('/^[A-Za-z0-9_-]{1,100}$/', $value),
    'channelId' => (bool) preg_match('/^UC[A-Za-z0-9_-]{10,40}$/', $value),
    default => false,
};

if (!$valid || $value === '') {
    respond_error('invalid_input', 'That value is not a valid YouTube ' . $mode . '.');
}

if ($mode === 'handle') {
    $value = ltrim($value, '@');
}

$apiKey = load_api_key();
if ($apiKey === null) {
    respond_error('config_missing', "YouTube isn't configured on this server yet.");
}

$channelResult = resolve_channel_id($mode, $value, $apiKey);
if (!$channelResult['ok']) {
    if ($channelResult['code'] === 'channel_not_found') {
        respond_error('channel_not_found', "We couldn't find that YouTube channel.");
    }
    respond_error($channelResult['code'], api_error_message($channelResult['code']));
}

$liveResult = resolve_live_video($channelResult['channelId'], $apiKey);
respond($liveResult);
