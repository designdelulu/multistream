<?php
/**
 * Same-origin TikTok avatar proxy for the Story Card canvas.
 *
 * GET /api/tiktok-avatar.php?u={validated_username}
 *
 * Not an open image proxy: the only accepted input is a TikTok handle
 * matching the same charset as tiktok-resolve.php, and the only upstream
 * hosts this script will fetch are unavatar.io (approved fallback) and
 * TikTok-owned CDN hosts cached from a prior live-room resolve.
 *
 * Success (and misses) are cached for hours/days so Story Card generation
 * does not refetch. Negative-cached failures return 404 so the canvas
 * falls back to initials.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

if (!defined('TIKTOK_CACHE_DIR')) {
    define('TIKTOK_CACHE_DIR', dirname(__DIR__, 2) . '/multistream-secrets/cache');
}

define('TIKTOK_AVATAR_HIT_TTL', 7 * 24 * 3600);
define('TIKTOK_AVATAR_MISS_TTL', 6 * 3600);
define('TIKTOK_AVATAR_MAX_BYTES', 256 * 1024);
define('TIKTOK_AVATAR_TIMEOUT_SECONDS', 8);
define('TIKTOK_AVATAR_UNAVATAR', 'https://unavatar.io/tiktok/%s?fallback=false');

function tiktok_avatar_cache_dir_ready(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;

    if (!is_dir(TIKTOK_CACHE_DIR)) {
        $ready = @mkdir(TIKTOK_CACHE_DIR, 0700, true);
        return $ready;
    }

    $ready = is_writable(TIKTOK_CACHE_DIR);
    return $ready;
}

function tiktok_avatar_cache_path(string $key): string
{
    return TIKTOK_CACHE_DIR . '/' . hash('sha256', $key) . '.json';
}

function tiktok_avatar_cache_get(string $key): mixed
{
    if (!tiktok_avatar_cache_dir_ready()) return null;
    $path = tiktok_avatar_cache_path($key);
    if (!is_readable($path)) return null;

    $raw = @file_get_contents($path);
    if ($raw === false) return null;

    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !isset($decoded['expiresAt'], $decoded['value'])) return null;
    if (time() >= $decoded['expiresAt']) return null;

    return $decoded['value'];
}

function tiktok_avatar_cache_set(string $key, mixed $value, int $ttlSeconds): void
{
    if (!tiktok_avatar_cache_dir_ready()) return;
    $payload = json_encode(['expiresAt' => time() + $ttlSeconds, 'value' => $value]);
    if ($payload === false) return;
    @file_put_contents(tiktok_avatar_cache_path($key), $payload, LOCK_EX);
}

function tiktok_avatar_valid_username(string $username): bool
{
    return (bool) preg_match('/^[a-zA-Z0-9_.]{1,64}$/', $username);
}

function tiktok_avatar_host_allowed(string $url): bool
{
    $parts = parse_url($url);
    if (($parts['scheme'] ?? '') !== 'https') return false;
    $host = strtolower($parts['host'] ?? '');
    if ($host === '') return false;
    if ($host === 'unavatar.io' || $host === 'www.unavatar.io') return true;
    foreach (['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktok.com'] as $suffix) {
        if ($host === $suffix || str_ends_with($host, '.' . $suffix)) return true;
    }
    return false;
}

/**
 * @return array{ok:bool,bytes:?string,contentType:?string,error:?string}
 */
function tiktok_avatar_fetch(string $url): array
{
    $transport = $GLOBALS['tiktok_avatar_http_transport'] ?? null;
    if (is_callable($transport)) {
        return $transport($url);
    }

    if (!function_exists('curl_init')) {
        return ['ok' => false, 'bytes' => null, 'contentType' => null, 'error' => 'curl_unavailable'];
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_TIMEOUT => TIKTOK_AVATAR_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => TIKTOK_AVATAR_TIMEOUT_SECONDS,
        CURLOPT_MAXFILESIZE => TIKTOK_AVATAR_MAX_BYTES,
        CURLOPT_HTTPHEADER => [
            'User-Agent: MultiStream.cc avatar proxy',
            'Accept: image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ],
    ]);
    $raw = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $contentType = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $error = curl_error($ch);

    if ($raw === false || $httpCode < 200 || $httpCode >= 300) {
        return ['ok' => false, 'bytes' => null, 'contentType' => null, 'error' => $error !== '' ? $error : "HTTP {$httpCode}"];
    }
    if (!is_string($raw) || $raw === '' || strlen($raw) > TIKTOK_AVATAR_MAX_BYTES) {
        return ['ok' => false, 'bytes' => null, 'contentType' => null, 'error' => 'too_large_or_empty'];
    }
    if (!preg_match('#^image/(jpeg|jpg|png|webp|gif|avif)#i', $contentType)) {
        return ['ok' => false, 'bytes' => null, 'contentType' => null, 'error' => 'not_image'];
    }

    return ['ok' => true, 'bytes' => $raw, 'contentType' => strtolower(trim(explode(';', $contentType)[0])), 'error' => null];
}

/**
 * @return array{ok:bool,bytes:?string,contentType:?string,source:?string}
 */
function tiktok_avatar_resolve(string $username): array
{
    $cacheKey = 'tiktok:avatar-bytes:' . strtolower($username);
    $cached = tiktok_avatar_cache_get($cacheKey);
    if (is_array($cached) && array_key_exists('miss', $cached) && $cached['miss'] === true) {
        return ['ok' => false, 'bytes' => null, 'contentType' => null, 'source' => null];
    }
    if (is_array($cached) && isset($cached['bytes'], $cached['contentType']) && is_string($cached['bytes']) && is_string($cached['contentType'])) {
        $bytes = base64_decode($cached['bytes'], true);
        if ($bytes !== false && $bytes !== '') {
            return ['ok' => true, 'bytes' => $bytes, 'contentType' => $cached['contentType'], 'source' => $cached['source'] ?? 'cache'];
        }
    }

    $candidates = [];
    $fromResolve = tiktok_avatar_cache_get('tiktok:avatar-src:' . strtolower($username));
    if (is_string($fromResolve) && tiktok_avatar_host_allowed($fromResolve)) {
        $candidates[] = ['url' => $fromResolve, 'source' => 'resolver'];
    }
    $candidates[] = [
        'url' => sprintf(TIKTOK_AVATAR_UNAVATAR, rawurlencode($username)),
        'source' => 'unavatar',
    ];

    foreach ($candidates as $candidate) {
        if (!tiktok_avatar_host_allowed($candidate['url'])) continue;
        $fetched = tiktok_avatar_fetch($candidate['url']);
        if (!$fetched['ok'] || $fetched['bytes'] === null || $fetched['contentType'] === null) continue;

        tiktok_avatar_cache_set($cacheKey, [
            'bytes' => base64_encode($fetched['bytes']),
            'contentType' => $fetched['contentType'],
            'source' => $candidate['source'],
        ], TIKTOK_AVATAR_HIT_TTL);

        return [
            'ok' => true,
            'bytes' => $fetched['bytes'],
            'contentType' => $fetched['contentType'],
            'source' => $candidate['source'],
        ];
    }

    tiktok_avatar_cache_set($cacheKey, ['miss' => true], TIKTOK_AVATAR_MISS_TTL);
    return ['ok' => false, 'bytes' => null, 'contentType' => null, 'source' => null];
}

function tiktok_avatar_respond_image(string $bytes, string $contentType): void
{
    header('Content-Type: ' . $contentType);
    header('Cache-Control: public, max-age=' . TIKTOK_AVATAR_HIT_TTL);
    header('Access-Control-Allow-Origin: *');
    echo $bytes;
    exit;
}

function tiktok_avatar_respond_miss(): void
{
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: public, max-age=' . TIKTOK_AVATAR_MISS_TTL);
    echo 'not found';
    exit;
}

if (!defined('TIKTOK_AVATAR_TESTING')) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        http_response_code(405);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Only GET is supported.';
        exit;
    }

    $username = isset($_GET['u']) && is_string($_GET['u']) ? $_GET['u'] : '';
    if (!tiktok_avatar_valid_username($username)) {
        http_response_code(400);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'invalid username';
        exit;
    }

    $resolved = tiktok_avatar_resolve($username);
    if ($resolved['ok'] && $resolved['bytes'] !== null && $resolved['contentType'] !== null) {
        tiktok_avatar_respond_image($resolved['bytes'], $resolved['contentType']);
    }
    tiktok_avatar_respond_miss();
}
