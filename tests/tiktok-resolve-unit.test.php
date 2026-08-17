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

function set_redirect_transport(callable $fn): void
{
    $GLOBALS['tiktok_redirect_transport'] = $fn;
}

/** Routes perform_upstream_request by URL prefix — for tests that need the primary and fallback calls to answer differently. */
function routed_upstream_transport(array $handlersByUrlPrefix): callable
{
    return static function (string $url, array $headers) use ($handlersByUrlPrefix): array {
        foreach ($handlersByUrlPrefix as $prefix => $handler) {
            if (str_starts_with($url, $prefix)) return $handler($url, $headers);
        }
        return ['httpCode' => 0, 'body' => null, 'error' => 'unexpected_url_in_test'];
    };
}

/** Maps specific request URLs to a Location — anything unmapped errors out (a test bug, not TikTok's fault). */
function chained_redirect_transport(array $locationByUrl): callable
{
    return static function (string $url) use ($locationByUrl): array {
        if (!array_key_exists($url, $locationByUrl)) {
            return ['httpCode' => 0, 'location' => null, 'error' => 'unexpected_url_in_test'];
        }
        return ['httpCode' => 301, 'location' => $locationByUrl[$url], 'error' => null];
    };
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

// --- is_tiktok_short_link -------------------------------------------------

check(is_tiktok_short_link('https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/') === true, 'recognizes a vt.tiktok.com share link');
check(is_tiktok_short_link('https://vm.tiktok.com/ZMxxxxxxx/') === true, 'recognizes a vm.tiktok.com share link');
check(is_tiktok_short_link('vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/') === true, 'recognizes a schemeless short link');
check(is_tiktok_short_link('https://www.tiktok.com/@creator/live') === false, 'canonical URL is not a short link');
check(is_tiktok_short_link('https://bit.ly/abc123') === false, 'a non-TikTok shortener is not a TikTok short link');
check(is_tiktok_short_link('') === false, 'rejects empty input');

// --- resolve_tiktok_short_link ---------------------------------------------
// Real format captured from an actual TikTok LIVE room's app-equivalent Share
// link on 2026-08-13: https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/ → HTTP 301 →
// https://www.tiktok.com/@itstaylaig/live?_d=...&_r=1&... (single hop).

set_redirect_transport(chained_redirect_transport([
    'https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/' => 'https://www.tiktok.com/@itstaylaig/live?_r=1&tt_from=copy',
]));
check(
    resolve_tiktok_short_link('https://vt.tiktok.com/ZS9k6GMYcaayX-gIzBB/') === 'https://www.tiktok.com/@itstaylaig/live?_r=1&tt_from=copy',
    'resolves a real single-hop vt.tiktok.com redirect to its canonical LIVE URL',
);
check(
    parse_tiktok_live_url('https://www.tiktok.com/@itstaylaig/live?_r=1&tt_from=copy') === 'itstaylaig',
    'the resolved URL parses to the correct handle',
);

set_redirect_transport(chained_redirect_transport([
    'https://vm.tiktok.com/ZMchain1/' => 'https://vt.tiktok.com/ZTchain2/',
    'https://vt.tiktok.com/ZTchain2/' => 'https://www.tiktok.com/@creator/live',
]));
check(
    resolve_tiktok_short_link('https://vm.tiktok.com/ZMchain1/') === 'https://www.tiktok.com/@creator/live',
    'follows a multi-hop short-link chain (vm → vt → canonical) within the redirect cap',
);

set_redirect_transport(chained_redirect_transport([
    'https://vt.tiktok.com/ZSevil/' => 'https://evil-lookalike.example/@creator/live',
]));
check(
    resolve_tiktok_short_link('https://vt.tiktok.com/ZSevil/') === null,
    'refuses to follow a redirect that leaves TikTok-owned hosts',
);

set_redirect_transport(chained_redirect_transport([
    'https://vt.tiktok.com/ZSloop1/' => 'https://vm.tiktok.com/ZSloop2/',
    'https://vm.tiktok.com/ZSloop2/' => 'https://vt.tiktok.com/ZSloop1/',
]));
check(
    resolve_tiktok_short_link('https://vt.tiktok.com/ZSloop1/') === null,
    'a redirect loop is rejected once the hop cap is exceeded, not followed forever',
);

set_redirect_transport(chained_redirect_transport([
    'https://vt.tiktok.com/ZSrelative/' => '/@creator/live',
]));
check(
    resolve_tiktok_short_link('https://vt.tiktok.com/ZSrelative/') === null,
    'a relative Location header is rejected rather than guessed against a base host',
);

set_transport(fixed_transport(0, null, 'unused')); // resolve_tiktok_live isn't exercised by these checks
set_redirect_transport(chained_redirect_transport([
    'https://vt.tiktok.com/ZSinvalid/' => 'https://www.tiktok.com/?_r=1', // TikTok's own behavior for an unknown/expired code
]));
check(
    resolve_tiktok_short_link('https://vt.tiktok.com/ZSinvalid/') === 'https://www.tiktok.com/?_r=1',
    'an expired/unknown short code still resolves the redirect itself (TikTok sends it to the homepage)',
);
check(
    parse_tiktok_live_url('https://www.tiktok.com/?_r=1') === null,
    'but the homepage it lands on is correctly rejected as not a LIVE URL — no @handle to extract',
);

set_redirect_transport(chained_redirect_transport([
    'https://vt.tiktok.com/ZSvideo/' => 'https://www.tiktok.com/@creator/video/7123456789012345678',
]));
check(
    resolve_tiktok_short_link('https://vt.tiktok.com/ZSvideo/') === 'https://www.tiktok.com/@creator/video/7123456789012345678',
    'a short link to a regular video resolves the redirect (the video-vs-live distinction is parse_tiktok_live_url\'s job, not the redirect resolver\'s)',
);
check(
    parse_tiktok_live_url('https://www.tiktok.com/@creator/video/7123456789012345678') === null,
    'a resolved video URL is still correctly rejected as not LIVE — short links can never be misclassified as LIVE',
);

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

// --- resolve_tiktok_live: avatar extraction ----------------------------------

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => [
        'user' => ['avatarMedium' => 'https://p16-sign.tiktokcdn.com/creator.webp'],
        'liveRoom' => [
            'status' => 2,
            'title' => 'With avatar',
            'streamData' => [
                'pull_data' => [
                    'stream_data' => json_encode([
                        'data' => [
                            'hd' => ['main' => ['flv' => 'https://cdn.example/hd.flv?expire=1999999999']],
                        ],
                    ]),
                ],
            ],
        ],
    ],
]));
$withAvatar = resolve_tiktok_live('creator');
check(($withAvatar['avatarUrl'] ?? null) === 'https://p16-sign.tiktokcdn.com/creator.webp', 'live room avatar is surfaced when present');
check(tiktok_extract_avatar_url(['data' => ['user' => ['avatarThumb' => 'https://p16.tiktokcdn.com/t.webp']]]) === 'https://p16.tiktokcdn.com/t.webp', 'extracts avatarThumb');
check(tiktok_extract_avatar_url(['data' => ['user' => ['avatarThumb' => 'javascript:alert(1)']]]) === null, 'rejects a non-https avatar URL');

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

// --- resolve_tiktok_live: hls extracted alongside flv --------------------------

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
                            'hd' => ['main' => ['flv' => 'https://cdn.example/hd.flv?expire=1999999999', 'hls' => 'https://cdn.example/hd.m3u8']],
                        ],
                    ]),
                ],
            ],
        ],
    ],
]));
$withHls = resolve_tiktok_live('creator');
check(count($withHls['qualities']) === 2, 'both an flv and an hls candidate are surfaced for the same quality name');
check($withHls['qualities'][0]['id'] === 'hd' && $withHls['qualities'][0]['protocol'] === 'flv', 'the flv entry keeps the plain quality-name id — existing client id lookup is unaffected');
check($withHls['qualities'][1]['id'] === 'hd-hls' && $withHls['qualities'][1]['protocol'] === 'hls', 'the hls entry is appended after, with a -hls suffixed id so it never collides');

// --- resolve_tiktok_live: HEVC fallback and standard precedence ----------------

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => [
        'liveRoom' => [
            'status' => 2,
            'hevcStreamData' => [
                'pull_data' => [
                    'stream_data' => json_encode([
                        'data' => [
                            'origin' => ['main' => ['flv' => 'https://cdn.example/hevc.flv?expire=1999999999']],
                        ],
                    ]),
                ],
            ],
        ],
    ],
]));
$hevcOnly = resolve_tiktok_live('creator');
check($hevcOnly['state'] === 'live', 'an HEVC-only live room resolves as playable');
check(($hevcOnly['qualities'][0]['url'] ?? '') === 'https://cdn.example/hevc.flv?expire=1999999999', 'HEVC FLV is exposed when standard stream data is absent');

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => [
        'liveRoom' => [
            'status' => 2,
            'streamData' => ['pull_data' => ['stream_data' => json_encode([
                'data' => ['hd' => ['main' => ['flv' => 'https://cdn.example/h264.flv']]],
            ])]],
            'hevcStreamData' => ['pull_data' => ['stream_data' => json_encode([
                'data' => ['origin' => ['main' => ['flv' => 'https://cdn.example/hevc.flv']]],
            ])]],
        ],
    ],
]));
$standardWins = resolve_tiktok_live('creator');
check(count($standardWins['qualities']) === 1, 'HEVC candidates are not mixed into a playable standard response');
check(($standardWins['qualities'][0]['url'] ?? '') === 'https://cdn.example/h264.flv', 'standard H.264 stream data takes precedence over HEVC');

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => [
        'liveRoom' => [
            'status' => 2,
            'hevcStreamData' => ['pull_data' => ['stream_data' => json_encode([
                'data' => ['origin' => ['main' => []]],
            ])]],
        ],
    ],
]));
$emptyHevc = resolve_tiktok_live('creator');
check($emptyHevc['state'] === 'no_stream_data', 'empty HEVC data preserves the missing-stream fallback state');

// --- resolve_tiktok_live: bounded fallback rescues an empty primary response ---

set_transport(routed_upstream_transport([
    'https://www.tiktok.com/api-live/user/room' => fn() => ['httpCode' => 200, 'body' => [
        'statusCode' => 0,
        'data' => ['liveRoom' => ['status' => 2, 'title' => 'Guest on someone else\'s live', 'streamId' => '123456']],
    ], 'error' => null],
    'https://www.tiktok.com/api/live/detail/' => fn() => ['httpCode' => 200, 'body' => [
        'statusCode' => 0,
        'LiveRoomInfo' => ['liveUrl' => 'https://pull-hls.tiktokcdn.example/live/123456.m3u8'],
    ], 'error' => null],
]));
$fallbackRescued = resolve_tiktok_live('creator');
check($fallbackRescued['state'] === 'live', 'a room confirmed live with no primary stream data is rescued by the fallback endpoint');
check(count($fallbackRescued['qualities']) === 1 && $fallbackRescued['qualities'][0]['id'] === 'fallback-hls', 'the fallback contributes a single fallback-hls quality');
check($fallbackRescued['qualities'][0]['url'] === 'https://pull-hls.tiktokcdn.example/live/123456.m3u8', 'the fallback liveUrl is passed through');

// --- resolve_tiktok_live: fallback attempted but also fails --------------------
// Real-tested 2026-08-14 against a genuinely live TikTok room: this is what
// production currently gets back from the fallback endpoint.

set_transport(routed_upstream_transport([
    'https://www.tiktok.com/api-live/user/room' => fn() => ['httpCode' => 200, 'body' => [
        'statusCode' => 0,
        'data' => ['liveRoom' => ['status' => 2, 'streamId' => '123456']],
    ], 'error' => null],
    'https://www.tiktok.com/api/live/detail/' => fn() => ['httpCode' => 200, 'body' => [
        'statusCode' => 10201,
        'statusMsg' => 'live detail API is deprecated',
    ], 'error' => null],
]));
$fallbackFailed = resolve_tiktok_live('creator');
check($fallbackFailed['state'] === 'no_stream_data', 'when the fallback also yields nothing usable, the original no_stream_data state still wins — no crash, no false live=true');
check($fallbackFailed['live'] === false, 'live stays false when both the primary and fallback come up empty');

// --- resolve_tiktok_live: no room id means no fallback attempt -----------------

set_transport(fixed_transport(200, [
    'statusCode' => 0,
    'data' => ['liveRoom' => ['status' => 2]], // no streamId at all
]));
$noRoomId = resolve_tiktok_live('creator');
check($noRoomId['state'] === 'no_stream_data', 'without a room id, resolution still ends cleanly at no_stream_data (fallback is skipped, not attempted with a bad id)');

// --- resolve_tiktok_live: transport failure -----------------------------------

set_transport(fixed_transport(0, null, 'connection_reset'));
$networkErr = resolve_tiktok_live('creator');
check($networkErr['state'] === 'network_error', 'a transport-level error resolves to network_error');

// --- resolve_tiktok_live: timeout is distinguished from a generic network error ---

set_transport(fixed_transport(0, null, 'timeout'));
$timeoutErr = resolve_tiktok_live('creator');
check($timeoutErr['state'] === 'timeout', 'a curl timeout resolves to its own timeout state, not the generic network_error');

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
