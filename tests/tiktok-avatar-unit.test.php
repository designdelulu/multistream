<?php
/**
 * Framework-free unit tests for public/api/tiktok-avatar.php.
 *
 * Run: php tests/tiktok-avatar-unit.test.php
 */

declare(strict_types=1);

$failures = 0;
$testCount = 0;

function check(bool $condition, string $message): void
{
    global $failures, $testCount;
    $testCount++;
    if ($condition) {
        return;
    }
    $failures++;
    fwrite(STDERR, "FAIL: {$message}\n");
}

$tmpRoot = sys_get_temp_dir() . '/tiktok-avatar-test-' . bin2hex(random_bytes(6));
mkdir($tmpRoot, 0700, true);
define('TIKTOK_CACHE_DIR', $tmpRoot . '/cache');
define('TIKTOK_AVATAR_TESTING', true);

$endpointFile = realpath(__DIR__ . '/../public/api/tiktok-avatar.php');
if ($endpointFile === false) {
    fwrite(STDERR, "FAIL: could not locate public/api/tiktok-avatar.php\n");
    exit(1);
}

require $endpointFile;

function set_avatar_transport(callable $fn): void
{
    $GLOBALS['tiktok_avatar_http_transport'] = $fn;
}

check(tiktok_avatar_valid_username('creator') === true, 'accepts a normal handle');
check(tiktok_avatar_valid_username('user.name_1') === true, 'accepts dots and underscores');
check(tiktok_avatar_valid_username('') === false, 'rejects empty');
check(tiktok_avatar_valid_username('has space') === false, 'rejects spaces');
check(tiktok_avatar_valid_username('../etc/passwd') === false, 'rejects path traversal');
check(tiktok_avatar_valid_username('https://evil.example/x') === false, 'rejects a URL as username');

check(tiktok_avatar_host_allowed('https://unavatar.io/tiktok/creator?fallback=false') === true, 'allows unavatar.io');
check(tiktok_avatar_host_allowed('https://p16-sign.tiktokcdn.com/a.webp') === true, 'allows tiktokcdn');
check(tiktok_avatar_host_allowed('https://evil.example/x.png') === false, 'rejects an arbitrary host');
check(tiktok_avatar_host_allowed('http://unavatar.io/tiktok/x') === false, 'rejects non-https');

$png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', true);
set_avatar_transport(static function (string $url) use ($png): array {
    if (!str_contains($url, 'unavatar.io/tiktok/creator')) {
        return ['ok' => false, 'bytes' => null, 'contentType' => null, 'error' => 'unexpected'];
    }
    return ['ok' => true, 'bytes' => $png, 'contentType' => 'image/png', 'error' => null];
});

$first = tiktok_avatar_resolve('creator');
check($first['ok'] === true, 'unavatar fallback returns an image');
check($first['source'] === 'unavatar', 'source is unavatar when no resolver URL is cached');
check($first['contentType'] === 'image/png', 'content type is image/png');

$calls = 0;
set_avatar_transport(static function () use (&$calls): array {
    $calls++;
    return ['ok' => false, 'bytes' => null, 'contentType' => null, 'error' => 'should_not_fetch'];
});
$cached = tiktok_avatar_resolve('creator');
check($cached['ok'] === true && $calls === 0, 'a hit is served from cache without refetching');

set_avatar_transport(static function (): array {
    return ['ok' => false, 'bytes' => null, 'contentType' => null, 'error' => 'missing'];
});
$miss = tiktok_avatar_resolve('nobodyhere');
check($miss['ok'] === false, 'a failed fetch is a miss');

$missCalls = 0;
set_avatar_transport(static function () use (&$missCalls): array {
    $missCalls++;
    return ['ok' => true, 'bytes' => 'x', 'contentType' => 'image/png', 'error' => null];
});
$negative = tiktok_avatar_resolve('nobodyhere');
check($negative['ok'] === false && $missCalls === 0, 'a miss is negative-cached');

tiktok_avatar_cache_set('tiktok:avatar-src:cacheduser', 'https://p16-sign.tiktokcdn.com/a.webp', 3600);
set_avatar_transport(static function (string $url) use ($png): array {
    if (str_contains($url, 'p16-sign.tiktokcdn.com')) {
        return ['ok' => true, 'bytes' => $png, 'contentType' => 'image/webp', 'error' => null];
    }
    return ['ok' => false, 'bytes' => null, 'contentType' => null, 'error' => 'unused'];
});
$fromResolver = tiktok_avatar_resolve('cacheduser');
check($fromResolver['ok'] === true && $fromResolver['source'] === 'resolver', 'prefers a cached resolver CDN URL over unavatar');

fwrite(STDOUT, "{$testCount} checks, " . ($testCount - $failures) . " passed, {$failures} failed\n");
exit($failures === 0 ? 0 : 1);
