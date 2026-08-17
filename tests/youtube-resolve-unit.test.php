<?php
/**
 * Framework-free unit tests for public/api/youtube-resolve.php.
 *
 * No PHPUnit/Composer in this repo — same zero-dependency posture as the
 * twitch/kick equivalents. Run: php tests/youtube-resolve-unit.test.php
 *
 * The endpoint's GET contract is exercised through youtube_resolve_handle_get
 * (the pure handler the request block delegates to). Tests never touch the
 * network: within-budget cases stop at validation (before any API call), and
 * over-budget cases are served the rate_limited body.
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

$tmpRoot = sys_get_temp_dir() . '/youtube-resolve-test-' . bin2hex(random_bytes(6));
mkdir($tmpRoot, 0700, true);
$cacheDir = $tmpRoot . '/cache';
$configPath = $tmpRoot . '/youtube-config.php';
file_put_contents($configPath, "<?php\nreturn ['api_key' => 'test_api_key'];\n");

define('YOUTUBE_CACHE_DIR', $cacheDir);
define('YOUTUBE_CONFIG_PATH', $configPath);
define('YOUTUBE_RESOLVE_TESTING', true);
define('YOUTUBE_RESOLVE_RATE_MAX', 3);
define('YOUTUBE_RESOLVE_RATE_WINDOW', 60);

$endpointFile = realpath(__DIR__ . '/../public/api/youtube-resolve.php');
if ($endpointFile === false) {
    fwrite(STDERR, "FAIL: could not locate public/api/youtube-resolve.php\n");
    exit(1);
}

require $endpointFile;

// --- Validation (within budget; never reaches the API) ---------------------

$_SERVER['REMOTE_ADDR'] = '10.1.1.1';

$missingIds = youtube_resolve_handle_get(['mode' => 'stats']);
check(($missingIds['code'] ?? '') === 'invalid_input', 'stats without ids is invalid_input');

// 51 DISTINCT valid-shaped ids (array_unique would collapse identical ones).
$ids51 = array_map(static fn (int $i): string => str_repeat('a', 9) . str_pad(dechex($i), 2, '0', STR_PAD_LEFT), range(0, 50));
$tooManyIds = youtube_resolve_handle_get(['mode' => 'stats', 'ids' => implode(',', $ids51)]);
check(($tooManyIds['code'] ?? '') === 'invalid_input', 'stats with >50 ids is invalid_input');

$badMode = youtube_resolve_handle_get(['mode' => 'video', 'value' => 'x']);
check(($badMode['code'] ?? '') === 'invalid_input', 'an unknown mode is invalid_input');

// --- Per-IP throttle --------------------------------------------------------

$_SERVER['REMOTE_ADDR'] = '10.2.2.2';
$hits = ['invalid_input', 'invalid_input', 'invalid_input'];
foreach ($hits as $i => $expected) {
    $r = youtube_resolve_handle_get(['mode' => 'stats']);
    check(($r['code'] ?? '') === $expected, 'within-budget request ' . ($i + 1) . ' reaches validation');
}
$limited = youtube_resolve_handle_get(['mode' => 'stats', 'ids' => str_repeat('a', 11)]);
check(($limited['code'] ?? '') === 'rate_limited', 'request past budget is rate_limited');
check(($limited['status'] ?? '') === 'error', 'rate_limited body is a soft error the frontend maps to keep-last-known');

$_SERVER['REMOTE_ADDR'] = '10.2.2.3';
$otherIp = youtube_resolve_handle_get(['mode' => 'stats']);
check(($otherIp['code'] ?? '') === 'invalid_input', 'a different IP keeps its own budget');

// The sliding window expires: backdate the counter file directly.
$ratePath = YOUTUBE_CACHE_DIR . '/' . hash('sha256', 'youtube:resolve-rate:' . hash('sha256', '10.2.2.2')) . '.json';
check(is_file($ratePath), 'the throttle counter is a cache file');
file_put_contents($ratePath, json_encode(['expiresAt' => time() - 5, 'value' => ['count' => 99]]));
$_SERVER['REMOTE_ADDR'] = '10.2.2.2';
$afterExpiry = youtube_resolve_handle_get(['mode' => 'stats']);
check(($afterExpiry['code'] ?? '') === 'invalid_input', 'the budget resets when the window expires');

// --- mode=stats response cache ------------------------------------------------

$idA = 'aaaaaaaaaa1';
$idB = 'aaaaaaaaaa2';
$transportCalls = 0;
$failNext = false;
$GLOBALS['youtube_http_transport'] = static function (string $url) use (&$transportCalls, &$failNext, $idA, $idB): array {
    $transportCalls++;
    if ($failNext) {
        return ['httpCode' => 500, 'body' => null];
    }
    return [
        'httpCode' => 200,
        'body' => [
            'items' => [
                ['id' => $idA, 'liveStreamingDetails' => ['concurrentViewers' => '123', 'actualStartTime' => '2026-01-01T00:00:00Z'], 'snippet' => ['title' => 'Stream A']],
                ['id' => $idB, 'snippet' => ['title' => 'Video B']],
            ],
        ],
    ];
};

$_SERVER['REMOTE_ADDR'] = '10.4.4.1';
$first = youtube_resolve_handle_get(['mode' => 'stats', 'ids' => "{$idA},{$idB}"]);
check(($first['status'] ?? '') === 'ok', 'first stats call succeeds');
check($transportCalls === 1, 'first stats call hits the upstream once');
check(($first['results'][0]['viewerCount'] ?? null) === 123, 'live entry carries the concurrent viewer count');
check(($first['results'][1]['status'] ?? '') === 'ended', 'an entry without concurrentViewers is ended, not live');

$second = youtube_resolve_handle_get(['mode' => 'stats', 'ids' => "{$idB},{$idA}"]);
check(($second['status'] ?? '') === 'ok' && $transportCalls === 1, 'the same ids in any order are served from cache');
check($second === $first, 'the cached body is identical to the fresh one');

$third = youtube_resolve_handle_get(['mode' => 'stats', 'ids' => $idA]);
check(($third['status'] ?? '') === 'ok' && $transportCalls === 2, 'a different id set is its own cache key');

// Upstream failures are never cached — the next poll retries upstream.
$_SERVER['REMOTE_ADDR'] = '10.4.4.2';
$failNext = true;
$failed = youtube_resolve_handle_get(['mode' => 'stats', 'ids' => 'cccccccccc1']);
check(($failed['code'] ?? '') === 'api_error', 'an upstream 500 is a soft api_error');
$failNext = false;
$retried = youtube_resolve_handle_get(['mode' => 'stats', 'ids' => 'cccccccccc1']);
check(($retried['status'] ?? '') === 'ok' && $transportCalls === 4, 'the failure was not cached — the next poll retries upstream');

// TTL expiry: backdate the cache entry and confirm a refetch.
$_SERVER['REMOTE_ADDR'] = '10.4.4.3';
$statsPath = YOUTUBE_CACHE_DIR . '/' . hash('sha256', 'stats:' . md5(implode(',', [$idA, $idB]))) . '.json';
check(is_file($statsPath), 'the stats cache entry is a cache file');
file_put_contents($statsPath, json_encode(['expiresAt' => time() - 5, 'value' => ['status' => 'ok', 'results' => []]]));
$refetched = youtube_resolve_handle_get(['mode' => 'stats', 'ids' => "{$idA},{$idB}"]);
check($transportCalls === 5, 'an expired entry is refetched');
check($refetched === $first, 'the refetched body matches the pre-expiry one');

// --- Summary -----------------------------------------------------------------

fwrite(STDOUT, "{$testCount} checks, " . ($testCount - $failures) . " passed, {$failures} failed\n");
exit($failures === 0 ? 0 : 1);
