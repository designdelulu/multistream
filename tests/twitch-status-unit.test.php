<?php
/**
 * Framework-free unit tests for public/api/twitch-status.php.
 *
 * No PHPUnit/Composer in this repo — this mirrors the project's existing
 * zero-dependency PHP posture. Run: php tests/twitch-status-unit.test.php
 *
 * The endpoint file's upstream HTTP call goes through an injectable
 * transport ($GLOBALS['twitch_http_transport']), so every test here runs
 * against canned responses — no real network call is ever made.
 *
 * A few cases (missing config, invalid credentials) need a config file
 * that hasn't already been read-and-memoized by load_twitch_credentials()
 * in this process, so those run in an isolated `php` subprocess instead.
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

$tmpRoot = sys_get_temp_dir() . '/twitch-status-test-' . bin2hex(random_bytes(6));
mkdir($tmpRoot, 0700, true);
$cacheDir = $tmpRoot . '/cache';
$validConfigPath = $tmpRoot . '/twitch-config-valid.php';
file_put_contents(
    $validConfigPath,
    "<?php\nreturn ['client_id' => 'test_client_id', 'client_secret' => 'test_client_secret'];\n",
);

define('TWITCH_CACHE_DIR', $cacheDir);
define('TWITCH_CONFIG_PATH', $validConfigPath);
define('TWITCH_STATUS_TESTING', true);

$endpointFile = realpath(__DIR__ . '/../public/api/twitch-status.php');
if ($endpointFile === false) {
    fwrite(STDERR, "FAIL: could not locate public/api/twitch-status.php\n");
    exit(1);
}

require $endpointFile;

// --- Transport test double -------------------------------------------------

/**
 * URL-substring-dispatched fake transport. $rules maps a substring to match
 * in the request URL to either a fixed response array or a callable
 * (method, url, params, headers) -> response, for stateful cases like a
 * 401-then-success token-retry sequence. Tracks every call for assertions.
 */
function make_dispatch_transport(array $rules): object
{
    $tracker = new stdClass();
    $tracker->calls = [];
    $tracker->transport = function (string $method, string $url, array $params, array $headers) use ($tracker, $rules) {
        $tracker->calls[] = $url;
        foreach ($rules as $match => $response) {
            if (str_contains($url, $match)) {
                return is_callable($response) ? $response($method, $url, $params, $headers) : $response;
            }
        }
        throw new RuntimeException('no transport rule matched ' . $url);
    };
    return $tracker;
}

function call_count(object $tracker, string $urlSubstring): int
{
    return count(array_filter($tracker->calls, static fn(string $url) => str_contains($url, $urlSubstring)));
}

function ok_token_response(): array
{
    return [
        'httpCode' => 200,
        'body' => ['access_token' => 'tok-' . bin2hex(random_bytes(3)), 'expires_in' => 3600],
        'error' => null,
    ];
}

// --- Pure-function tests ---------------------------------------------------

check(normalize_login('  @ChannelOne ') === 'channelone', 'normalize_login trims, lowercases, strips leading @');
check(normalize_login('already_lower') === 'already_lower', 'normalize_login is a no-op on already-clean input');
check(is_valid_login('shroud') === true, 'is_valid_login accepts a plain username');
check(is_valid_login('has space') === false, 'is_valid_login rejects a space');
check(is_valid_login('') === false, 'is_valid_login rejects empty string');
check(is_valid_login(str_repeat('a', 26)) === false, 'is_valid_login rejects 26+ chars');
check(is_valid_login(str_repeat('a', 25)) === true, 'is_valid_login accepts exactly 25 chars');
check(build_repeated_query('login', ['a', 'b']) === 'login=a&login=b', 'build_repeated_query joins repeated keys');
check(build_repeated_query('login', []) === '', 'build_repeated_query handles an empty list');

$creds = load_twitch_credentials();
check($creds !== null && $creds['client_id'] === 'test_client_id', 'load_twitch_credentials reads a valid config file');

// --- Case: empty channel list never calls the transport --------------------

$GLOBALS['twitch_http_transport'] = static function (...$args): array {
    throw new RuntimeException('transport should not be called for an empty batch');
};
$emptyResult = build_twitch_status_results([]);
check($emptyResult === [], 'build_twitch_status_results([]) returns an empty result set with no upstream calls');

// --- Case: invalid characters short-circuit before any upstream call -------

$GLOBALS['twitch_http_transport'] = static function (...$args): array {
    throw new RuntimeException('transport should not be called for an all-invalid batch');
};
$invalidOnly = build_twitch_status_results(['!!!bad!!!', 'also bad']);
check(count($invalidOnly) === 2, 'invalid-only batch still returns one result per input');
check($invalidOnly[0]['status'] === 'invalid_input', 'invalid characters map to invalid_input');
check($invalidOnly[1]['status'] === 'invalid_input', 'a second invalid entry also maps to invalid_input');

// --- Case: mixed live/offline/not-found, mixed case, duplicate, invalid ----
// Also proves batching: one token call, one /helix/users call, one
// /helix/streams call, no matter how many channels or duplicates.

$mixedTracker = make_dispatch_transport([
    'oauth2/token' => ok_token_response(),
    'helix/users' => [
        'httpCode' => 200,
        'body' => ['data' => [
            ['id' => '1', 'login' => 'shroud', 'display_name' => 'Shroud'],
            ['id' => '2', 'login' => 'offlineuser', 'display_name' => 'OfflineUser'],
        ]],
        'error' => null,
    ],
    'helix/streams' => [
        'httpCode' => 200,
        'body' => ['data' => [[
            'user_login' => 'shroud',
            'user_name' => 'Shroud',
            'title' => 'Great stream',
            'game_name' => 'Just Chatting',
            'viewer_count' => 42,
            'started_at' => '2026-01-01T00:00:00Z',
            'thumbnail_url' => 'https://example/{width}x{height}.jpg',
        ]]],
        'error' => null,
    ],
]);
$GLOBALS['twitch_http_transport'] = $mixedTracker->transport;

$mixed = build_twitch_status_results(['Shroud', 'offlineuser', 'NoSuchUser', 'shroud', '!!!bad!!!']);

check(count($mixed) === 5, 'results array preserves one entry per input, including duplicates');
check($mixed[0]['status'] === 'live' && $mixed[0]['normalized'] === 'shroud', 'existing + live channel resolves to live');
check($mixed[0]['title'] === 'Great stream' && $mixed[0]['category'] === 'Just Chatting', 'live result carries title/category');
check($mixed[0]['viewerCount'] === 42, 'live result carries viewer count');
check(str_contains((string) $mixed[0]['thumbnailUrl'], '320x180'), 'thumbnail template placeholders are substituted');
check($mixed[1]['status'] === 'offline' && $mixed[1]['displayName'] === 'OfflineUser', 'existing + not-live channel resolves to offline');
check($mixed[2]['status'] === 'not_found', 'a login absent from Get Users resolves to not_found');
check($mixed[3]['status'] === 'live' && $mixed[3]['normalized'] === 'shroud', 'a duplicate input resolves the same as the first occurrence');
check($mixed[4]['status'] === 'invalid_input', 'an invalid entry inside an otherwise valid batch still gets invalid_input, not a batch-wide rejection');

check(call_count($mixedTracker, 'oauth2/token') === 1, 'exactly one token request for the whole batch');
check(call_count($mixedTracker, 'helix/users') === 1, 'exactly one Get Users call regardless of batch size/duplicates');
check(call_count($mixedTracker, 'helix/streams') === 1, 'exactly one Get Streams call regardless of batch size/duplicates');

// --- Case: cached live + offline results serve with zero upstream calls ---

$GLOBALS['twitch_http_transport'] = static function (string $method, string $url): array {
    throw new RuntimeException("unexpected upstream call on a cache hit: {$method} {$url}");
};
try {
    $cachedLive = build_twitch_status_results(['shroud']);
    check($cachedLive[0]['status'] === 'live', 'a cached live result is served without any upstream call');
} catch (RuntimeException $e) {
    check(false, 'cached live lookup unexpectedly hit the network: ' . $e->getMessage());
}
try {
    $cachedOffline = build_twitch_status_results(['offlineuser']);
    check($cachedOffline[0]['status'] === 'offline', 'a cached offline result is served without any upstream call');
} catch (RuntimeException $e) {
    check(false, 'cached offline lookup unexpectedly hit the network: ' . $e->getMessage());
}
try {
    $cachedNotFound = build_twitch_status_results(['nosuchuser']);
    check($cachedNotFound[0]['status'] === 'not_found', 'a cached not_found result is served without any upstream call');
} catch (RuntimeException $e) {
    check(false, 'cached not_found lookup unexpectedly hit the network: ' . $e->getMessage());
}

// --- Case: expired access token — 401 triggers exactly one retry ----------
// A token is already cached from the earlier tests above (this mirrors the
// real scenario: a previously-good cached token that Twitch now rejects
// early), so the 401 should force exactly one *fresh* token fetch, not a
// first-ever one.

cache_delete('twitch:live:freshlogin');
cache_delete('twitch:user:freshlogin');

$usersCallCount = 0;
$retryTracker = make_dispatch_transport([
    'oauth2/token' => ok_token_response(),
    'helix/users' => static function () use (&$usersCallCount): array {
        $usersCallCount++;
        if ($usersCallCount === 1) {
            return ['httpCode' => 401, 'body' => ['error' => 'Unauthorized'], 'error' => null];
        }
        return [
            'httpCode' => 200,
            'body' => ['data' => [['id' => '9', 'login' => 'freshlogin', 'display_name' => 'FreshLogin']]],
            'error' => null,
        ];
    },
    'helix/streams' => ['httpCode' => 200, 'body' => ['data' => []], 'error' => null],
]);
$GLOBALS['twitch_http_transport'] = $retryTracker->transport;

$retryResult = build_twitch_status_results(['freshlogin']);

check($usersCallCount === 2, 'a 401 from Get Users triggers exactly one retry (two calls total)');
check(call_count($retryTracker, 'oauth2/token') === 1, 'a 401 forces exactly one fresh token fetch, reusing the retry — not a second stale attempt');
check($retryResult[0]['status'] === 'offline', 'the retried request succeeds and resolves normally');

// --- Case: upstream timeout / transport-level error ------------------------

cache_delete('twitch:user:timeoutlogin');
$GLOBALS['twitch_http_transport'] = make_dispatch_transport([
    'oauth2/token' => ok_token_response(),
    'helix/users' => ['httpCode' => 0, 'body' => null, 'error' => 'Operation timed out'],
])->transport;

$timeoutResult = build_twitch_status_results(['timeoutlogin']);
check($timeoutResult[0]['status'] === 'unavailable', 'a transport-level timeout resolves to unavailable, not a thrown error');

// --- Case: rate-limit / upstream error -------------------------------------

cache_delete('twitch:user:ratelimited');
$GLOBALS['twitch_http_transport'] = make_dispatch_transport([
    'oauth2/token' => ok_token_response(),
    'helix/users' => ['httpCode' => 429, 'body' => ['error' => 'Too Many Requests'], 'error' => null],
])->transport;

$rateLimitedResult = build_twitch_status_results(['ratelimited']);
check($rateLimitedResult[0]['status'] === 'unavailable', 'a 429 from Twitch resolves to unavailable, not a thrown error');

// --- Case: missing config / invalid credentials ----------------------------
// Isolated subprocess: load_twitch_credentials() memoizes per-process, so a
// "config missing" or "bad credentials" scenario needs a fresh process
// rather than redefining constants mid-run.

function run_isolated_case(string $configBody, string $transportBody, array $channels): array
{
    global $cacheDir, $endpointFile;

    $caseRoot = sys_get_temp_dir() . '/twitch-status-test-case-' . bin2hex(random_bytes(6));
    mkdir($caseRoot, 0700, true);
    $configPath = $caseRoot . '/twitch-config.php';
    if ($configBody !== '') {
        file_put_contents($configPath, $configBody);
    }

    $script = '<?php' . "\n"
        . 'define("TWITCH_CACHE_DIR", ' . var_export($cacheDir, true) . ');' . "\n"
        . 'define("TWITCH_CONFIG_PATH", ' . var_export($configPath, true) . ');' . "\n"
        . 'define("TWITCH_STATUS_TESTING", true);' . "\n"
        . 'require ' . var_export($endpointFile, true) . ';' . "\n"
        . $transportBody . "\n"
        . 'echo json_encode(build_twitch_status_results(' . var_export($channels, true) . '));' . "\n";

    $scriptPath = $caseRoot . '/run.php';
    file_put_contents($scriptPath, $script);

    // stderr is discarded (not merged) so error_log() diagnostics never land
    // in the middle of the JSON this script echoes to stdout.
    $output = [];
    $exitCode = 0;
    exec('php ' . escapeshellarg($scriptPath) . ' 2>/dev/null', $output, $exitCode);

    return ['output' => implode("\n", $output), 'exitCode' => $exitCode];
}

// Case: config file doesn't exist at all.
$missingConfigCase = run_isolated_case(
    '', // no config file written
    '', // never reaches a transport call — load_twitch_credentials() fails first
    ['someuser'],
);
$missingConfigDecoded = json_decode($missingConfigCase['output'], true);
check(
    $missingConfigCase['exitCode'] === 0 && is_array($missingConfigDecoded) && $missingConfigDecoded[0]['status'] === 'unavailable',
    'a missing config file resolves to unavailable, not a fatal error: ' . $missingConfigCase['output'],
);

// Case: config file exists but Twitch rejects the client_id/client_secret.
$invalidCredsCase = run_isolated_case(
    "<?php\nreturn ['client_id' => 'bad', 'client_secret' => 'bad'];\n",
    '$GLOBALS["twitch_http_transport"] = static function () {'
        . 'return ["httpCode" => 400, "body" => ["message" => "Invalid client"], "error" => null];'
        . '};',
    ['someuser'],
);
$invalidCredsDecoded = json_decode($invalidCredsCase['output'], true);
check(
    $invalidCredsCase['exitCode'] === 0 && is_array($invalidCredsDecoded) && $invalidCredsDecoded[0]['status'] === 'unavailable',
    'invalid client credentials resolve to unavailable, not a fatal error: ' . $invalidCredsCase['output'],
);

// --- Case: lock/unlock round-trip (concurrency primitive) ------------------
// True multi-process contention (spec #19) is exercised manually per the
// plan's test strategy — PHP's single-process flock semantics can't cleanly
// simulate a second concurrent process within one script. This checks the
// primitive itself is sound: acquire succeeds, release frees it, and a
// second acquire on the same key afterwards also succeeds.

$lockA = acquire_or_wait_lock('twitch:test-lock-key');
check($lockA !== null, 'acquire_or_wait_lock returns a handle when uncontended');
release_lock($lockA);
$lockB = acquire_or_wait_lock('twitch:test-lock-key');
check($lockB !== null, 'a lock can be re-acquired after being released');
release_lock($lockB);

// --- Case: MAX_CHANNELS_PER_REQUEST sanity check ---------------------------
// The oversized-batch (>100) rejection itself lives in the HTTP
// request-handling block (guarded out under TWITCH_STATUS_TESTING), not in
// a pure function — exercised via the manual/browser curl pass instead.

check(MAX_CHANNELS_PER_REQUEST === 100, 'MAX_CHANNELS_PER_REQUEST matches Helix\'s documented per-request login limit');

// --- Summary ----------------------------------------------------------------

fwrite(STDOUT, "{$testCount} checks, " . ($testCount - $failures) . " passed, {$failures} failed\n");
exit($failures > 0 ? 1 : 0);
