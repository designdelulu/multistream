<?php
/**
 * Framework-free unit tests for public/api/tiktok-resolve.php.
 *
 * No PHPUnit/Composer in this repo — mirrors tests/twitch-status-unit.test.php.
 * Run: php tests/tiktok-resolve-unit.test.php
 *
 * The endpoint file's upstream HTTP call goes through an injectable
 * transport ($GLOBALS['tiktok_http_transport']), so every test here runs
 * against canned responses — no real network call is ever made.
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

// --- Fixture setup --------------------------------------------------------

$tmpRoot = sys_get_temp_dir() . '/tiktok-resolve-test-' . bin2hex(random_bytes(6));
mkdir($tmpRoot, 0700, true);

define('TIKTOK_CACHE_DIR', $tmpRoot . '/cache');
define('TIKTOK_RESOLVE_TESTING', true);

$endpointFile = realpath(__DIR__ . '/../public/api/tiktok-resolve.php');
if ($endpointFile === false) {
    fwrite(STDERR, "FAIL: could not locate public/api/tiktok-resolve.php\n");
    exit(1);
}

require $endpointFile;

function set_transport(callable $fn): void
{
    $GLOBALS['tiktok_http_transport'] = $fn;
}

function fixed_transport(int $httpCode, ?array $body, ?string $error = null): callable
{
    return static fn(string $url, array $headers) => ['httpCode' => $httpCode, 'body' => $body, 'error' => $error];
}

// --- parse_tiktok_live_url ---------------------------------------------------

check(parse_tiktok_live_url('https://www.tiktok.com/@creator/live') === 'creator', 'parses a canonical LIVE URL');
check(parse_tiktok_live_url('https://tiktok.com/@creator/live') === 'creator', 'parses a LIVE URL without www');
check(parse_tiktok_live_url('https://www.tiktok.com/@creator') === 'creator', 'parses a bare profile URL');
check(parse_tiktok_live_url('tiktok.com/@creator/live') === 'creator', 'parses a schemeless URL');
check(parse_tiktok_live_url('https://www.tiktok.com/@CreatorName/live') === 'creatorname', 'lowercases the handle');
check(parse_tiktok_live_url('https://www.tiktok.com/@creator/video/123') === null, 'rejects a video URL — never misclassified as LIVE');
check(parse_tiktok_live_url('https://www.tiktok.com/@creator/photo/123') === null, 'rejects a photo URL');
check(parse_tiktok_live_url('https://www.evil.com/@creator/live') === null, 'rejects a non-TikTok host');
check(parse_tiktok_live_url('https://www.tiktok.com/creator/live') === null, 'rejects a URL missing the @ handle');
check(parse_tiktok_live_url('not a url at all $$$') === null, 'rejects garbage input');
check(parse_tiktok_live_url('') === null, 'rejects empty input');
// Confirms the parser never fetches — a client could hand it any string,
// including one aimed at an internal host, and it just returns null.
check(parse_tiktok_live_url('http://169.254.169.254/@x/live') === null, 'rejects a non-tiktok.com host used as an SSRF probe');

// --- resolve_tiktok_live: live ------------------------------------------------

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => [
        'liveRoom' => [
            'status' => 2,
            'title' => 'Test stream',
            'streamData' => [
                'pull_data' => [
                    'stream_data' => json_encode([
                        'data' => [
                            'hd' => ['main' => ['flv' => 'https://cdn.example/hd.flv?expire=1999999999']],
                            'sd' => ['main' => ['flv' => 'https://cdn.example/sd.flv?expire=1999999999']],
                        ],
                    ]),
                ],
            ],
        ],
    ],
]));
$live = resolve_tiktok_live('creator');
check($live['live'] === true && $live['state'] === 'live', 'a live room with stream data resolves to live=true');
check(count($live['qualities']) === 2, 'both quality variants are surfaced');
check($live['qualities'][0]['protocol'] === 'flv', 'quality protocol is flv');
check($live['expiresAt'] !== null, 'expiresAt is parsed from the flv url\'s expire param');
check($live['title'] === 'Test stream', 'title is passed through');

// --- resolve_tiktok_live: offline ---------------------------------------------

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => ['liveRoom' => ['status' => 4, 'title' => 'Offline creator']],
]));
$offline = resolve_tiktok_live('creator');
check($offline['live'] === false && $offline['state'] === 'offline', 'status 4 resolves to offline');

// --- resolve_tiktok_live: invalid creator -------------------------------------

set_transport(fixed_transport(200, ['statusCode' => 1, 'message' => 'user_not_found']));
$invalid = resolve_tiktok_live('nosuchuser');
check($invalid['live'] === false && $invalid['state'] === 'invalid_creator', 'non-zero statusCode resolves to invalid_creator');

// --- resolve_tiktok_live: missing liveRoom ------------------------------------

set_transport(fixed_transport(200, ['statusCode' => 0, 'data' => []]));
$missingRoom = resolve_tiktok_live('creator');
check($missingRoom['state'] === 'provider_error', 'missing liveRoom resolves to provider_error');

// --- resolve_tiktok_live: no stream data --------------------------------------

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => ['liveRoom' => ['status' => 2, 'title' => 'x']],
]));
$noData = resolve_tiktok_live('creator');
check($noData['state'] === 'no_stream_data', 'a live room with no streamData resolves to no_stream_data');

// --- resolve_tiktok_live: no playable streams ---------------------------------

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => [
        'liveRoom' => [
            'status' => 2,
            'streamData' => ['pull_data' => ['stream_data' => json_encode(['data' => ['hd' => ['main' => []]]])]],
        ],
    ],
]));
$noPlayable = resolve_tiktok_live('creator');
check($noPlayable['state'] === 'no_playable_streams', 'stream data with no flv urls resolves to no_playable_streams');

// --- resolve_tiktok_live: transport failure -----------------------------------

set_transport(fixed_transport(0, null, 'connection_reset'));
$networkErr = resolve_tiktok_live('creator');
check($networkErr['state'] === 'network_error', 'a transport-level error resolves to network_error');

// --- resolve_tiktok_live: non-200 upstream ------------------------------------

set_transport(fixed_transport(500, null));
$httpErr = resolve_tiktok_live('creator');
check($httpErr['state'] === 'upstream_http_error', 'a non-JSON/error upstream body resolves to upstream_http_error');

// --- cache round-trip ----------------------------------------------------------

cache_set('tiktok:test-key', ['hello' => 'world'], 60);
check(cache_get('tiktok:test-key') === ['hello' => 'world'], 'cache_get returns a value just written by cache_set');
check(cache_get('tiktok:missing-key') === null, 'cache_get misses cleanly for an unknown key');

// --- rate limiter ----------------------------------------------------------

for ($i = 0; $i < RATE_LIMIT_MAX_REQUESTS; $i++) {
    check(rate_limit_exceeded('1.2.3.4') === false, "request {$i} under the limit is allowed");
}
check(rate_limit_exceeded('1.2.3.4') === true, 'the request beyond RATE_LIMIT_MAX_REQUESTS is rejected');
check(rate_limit_exceeded('5.6.7.8') === false, 'a different IP has its own independent window');

// --- Summary ----------------------------------------------------------------

fwrite(STDOUT, "{$testCount} checks, " . ($testCount - $failures) . " passed, {$failures} failed\n");
exit($failures === 0 ? 0 : 1);
