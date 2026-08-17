<?php
/**
 * Framework-free unit tests for public/api/kick-status.php.
 *
 * No PHPUnit/Composer in this repo — this mirrors the project's existing
 * zero-dependency PHP posture, and the twitch-status equivalent next to it.
 * Run: php tests/kick-status-unit.test.php
 *
 * The endpoint file's upstream HTTP calls go through an injectable transport
 * ($GLOBALS['kick_http_transport']), so every test here runs against canned
 * responses shaped like Kick's current official Public API (v1) — no real
 * network call is ever made, and none of these tests requires the Kick
 * credentials that are not installed yet.
 *
 * The "no credentials at all" case needs a config path that hasn't already
 * been read-and-memoized by load_kick_credentials() in this process, so it
 * runs in an isolated `php` subprocess instead.
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

$tmpRoot = sys_get_temp_dir() . '/kick-status-test-' . bin2hex(random_bytes(6));
mkdir($tmpRoot, 0700, true);
$cacheDir = $tmpRoot . '/cache';
$validConfigPath = $tmpRoot . '/kick-config-valid.php';
file_put_contents(
    $validConfigPath,
    "<?php\nreturn ['client_id' => 'test_client_id', 'client_secret' => 'test_client_secret'];\n",
);

define('KICK_CACHE_DIR', $cacheDir);
define('KICK_CONFIG_PATH', $validConfigPath);
define('KICK_STATUS_TESTING', true);
$endpointFile = realpath(__DIR__ . '/../public/api/kick-status.php');
if ($endpointFile === false) {
    fwrite(STDERR, "FAIL: could not locate public/api/kick-status.php\n");
    exit(1);
}

require $endpointFile;

// --- Transport test double -------------------------------------------------

/** Same URL-substring dispatch harness the twitch-status tests use. */
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
        'body' => [
            'access_token' => 'tok-' . bin2hex(random_bytes(3)),
            'token_type' => 'Bearer',
            'expires_in' => 3600,
        ],
        'error' => null,
    ];
}

/** One /public/v1/channels item, shaped like Kick's documented response. */
function channel_item(string $slug, int $userId, bool $live, array $overrides = []): array
{
    $item = [
        'slug' => $slug,
        'broadcaster_user_id' => $userId,
        'banner_picture' => 'https://files.kick.com/banner.jpg',
        'channel_description' => 'desc',
        'stream_title' => 'LOCKED-IN-ATHON DAY 33',
        'category' => ['id' => 15, 'name' => 'Just Chatting', 'thumbnail' => 'https://files.kick.com/cat.jpg'],
        'stream' => [
            'is_live' => $live,
            'is_mature' => false,
            'language' => 'en',
            'start_time' => $live ? '2026-08-14T05:12:00Z' : '',
            'viewer_count' => $live ? 8200 : 0,
        ],
    ];
    return array_replace_recursive($item, $overrides);
}

// --- Pure-function tests ---------------------------------------------------

check(kick_normalize_slug('  @DeenTheGreat ') === 'deenthegreat', 'kick_normalize_slug trims, lowercases, strips leading @');
check(kick_normalize_slug('already-lower_1') === 'already-lower_1', 'kick_normalize_slug is a no-op on already-clean input');
check(kick_is_valid_slug('deenthegreat') === true, 'kick_is_valid_slug accepts a plain slug');
check(kick_is_valid_slug('with-dash_and_underscore') === true, 'kick_is_valid_slug accepts dash and underscore (Kick allows both)');
check(kick_is_valid_slug('has space') === false, 'kick_is_valid_slug rejects a space');
check(kick_is_valid_slug('') === false, 'kick_is_valid_slug rejects empty string');
check(kick_is_valid_slug(str_repeat('a', 26)) === false, 'kick_is_valid_slug rejects 26+ chars');
check(
    kick_build_repeated_query('slug', ['a', 'b']) === 'slug=a&slug=b',
    'kick_build_repeated_query joins repeated keys',
);
check(kick_build_repeated_query('slug', []) === '', 'kick_build_repeated_query handles an empty list');

check(
    kick_extract_avatar_url(['profile_picture' => 'https://files.kick.com/p.webp']) === 'https://files.kick.com/p.webp',
    'kick_extract_avatar_url reads a top-level profile_picture',
);
check(
    kick_extract_avatar_url(['user' => ['profile_picture' => 'https://files.kick.com/n.webp']]) === 'https://files.kick.com/n.webp',
    'kick_extract_avatar_url reads a nested user.profile_picture',
);
check(
    kick_extract_avatar_url(['banner_picture' => 'https://files.kick.com/banner.jpg']) === null,
    'kick_extract_avatar_url never accepts banner_picture as an avatar',
);
check(kick_extract_avatar_url([]) === null, 'kick_extract_avatar_url returns null when nothing is present');
check(
    kick_extract_avatar_url(['profile_picture' => 'not-a-url']) === null,
    'kick_extract_avatar_url rejects a non-http value',
);

$creds = load_kick_credentials();
check($creds !== null && $creds['client_id'] === 'test_client_id', 'load_kick_credentials reads a valid config file');
check(kick_is_configured() === true, 'kick_is_configured is true once a valid config is readable');

// --- Case: empty channel list never calls the transport --------------------

$GLOBALS['kick_http_transport'] = static function (...$args): array {
    throw new RuntimeException('transport should not be called for an empty batch');
};
check(build_kick_status_results([]) === [], 'build_kick_status_results([]) returns an empty result set with no upstream calls');

// --- Case: invalid characters short-circuit before any upstream call -------

$GLOBALS['kick_http_transport'] = static function (...$args): array {
    throw new RuntimeException('transport should not be called for an all-invalid batch');
};
$invalidOnly = build_kick_status_results(['!!!bad!!!', 'also bad']);
check(count($invalidOnly) === 2, 'invalid-only batch still returns one result per input');
check($invalidOnly[0]['status'] === 'invalid_input', 'invalid characters map to invalid_input');

// --- Case: live + offline + not-found + duplicate + invalid, one batch -----
// Also proves batching: one token call and one /channels call no matter how
// many slugs or duplicates are in the request.

$mixedTracker = make_dispatch_transport([
    'oauth/token' => ok_token_response(),
    'public/v1/channels' => [
        'httpCode' => 200,
        'body' => ['data' => [
            channel_item('deenthegreat', 101, true, ['profile_picture' => 'https://files.kick.com/deen.webp']),
            channel_item('offlineguy', 102, false, ['profile_picture' => 'https://files.kick.com/off.webp']),
        ]],
        'error' => null,
    ],
]);
$GLOBALS['kick_http_transport'] = $mixedTracker->transport;

$mixed = build_kick_status_results(['DeenTheGreat', 'offlineguy', 'nosuchchannel', 'deenthegreat', '!!!bad!!!']);

check(count($mixed) === 5, 'results array preserves one entry per input, including duplicates');
check($mixed[0]['status'] === 'live' && $mixed[0]['normalized'] === 'deenthegreat', 'a live channel resolves to live');
check($mixed[0]['viewerCount'] === 8200, 'live result carries the viewer count');
check($mixed[0]['startedAt'] === '2026-08-14T05:12:00Z', 'live result carries the stream start time for client-side duration');
check($mixed[0]['category'] === 'Just Chatting', 'live result carries the category name');
check($mixed[0]['title'] === 'LOCKED-IN-ATHON DAY 33', 'live result carries the stream title');
check($mixed[0]['avatarUrl'] === 'https://files.kick.com/deen.webp', 'live result carries the profile image from the same response');
check($mixed[1]['status'] === 'offline', 'a non-live channel resolves to offline');
check(!isset($mixed[1]['viewerCount']), 'an offline result never carries a stale viewer count');
check(!isset($mixed[1]['startedAt']), 'an offline result never carries a start time (so no ticking duration)');
check($mixed[1]['avatarUrl'] === 'https://files.kick.com/off.webp', 'an offline result still carries its avatar');
check($mixed[2]['status'] === 'not_found', 'a slug absent from the channels response resolves to not_found');
check($mixed[3]['status'] === 'live', 'a duplicate input resolves the same as the first occurrence');
check($mixed[4]['status'] === 'invalid_input', 'an invalid entry inside an otherwise valid batch still gets invalid_input');

check(call_count($mixedTracker, 'oauth/token') === 1, 'exactly one token request for the whole batch');
check(call_count($mixedTracker, 'public/v1/channels') === 1, 'exactly one channels call regardless of batch size/duplicates');
check(call_count($mixedTracker, 'public/v1/users') === 0, 'no users call when the channels response already carried every avatar');

// --- Case: cached results serve with zero upstream calls -------------------
// Proves the cached-token + cached-channel path: a second identical request
// costs no OAuth token request and no API request at all.

$GLOBALS['kick_http_transport'] = static function (string $method, string $url): array {
    throw new RuntimeException("unexpected upstream call on a cache hit: {$method} {$url}");
};
try {
    $cachedLive = build_kick_status_results(['deenthegreat']);
    check($cachedLive[0]['status'] === 'live', 'a cached live result is served without any upstream call');
    check($cachedLive[0]['avatarUrl'] === 'https://files.kick.com/deen.webp', 'a cached result still carries its avatar');
    $cachedOffline = build_kick_status_results(['offlineguy']);
    check($cachedOffline[0]['status'] === 'offline', 'a cached offline result is served without any upstream call');
    $cachedNotFound = build_kick_status_results(['nosuchchannel']);
    check($cachedNotFound[0]['status'] === 'not_found', 'a cached not_found result is served without any upstream call');
} catch (RuntimeException $e) {
    check(false, 'a cached lookup unexpectedly hit the network: ' . $e->getMessage());
}

// --- Case: avatar backfill via /users when /channels has no picture --------

$backfillTracker = make_dispatch_transport([
    'oauth/token' => ok_token_response(),
    'public/v1/channels' => [
        'httpCode' => 200,
        'body' => ['data' => [channel_item('nopicture', 303, true)]],
        'error' => null,
    ],
    'public/v1/users' => [
        'httpCode' => 200,
        'body' => ['data' => [[
            'user_id' => 303,
            'name' => 'NoPicture',
            'profile_picture' => 'https://files.kick.com/backfilled.webp',
        ]]],
        'error' => null,
    ],
]);
$GLOBALS['kick_http_transport'] = $backfillTracker->transport;

$backfilled = build_kick_status_results(['nopicture']);
check($backfilled[0]['status'] === 'live', 'the backfill path does not disturb the live status itself');
check(
    $backfilled[0]['avatarUrl'] === 'https://files.kick.com/backfilled.webp',
    'an avatar missing from /channels is backfilled from the same batched pipeline via /users',
);
check(call_count($backfillTracker, 'public/v1/users') === 1, 'the backfill is one batched users call, not one per channel');

// --- Case: /users refusing app tokens must not break the metadata ----------
// The most likely real-world outcome once credentials are installed: Kick's
// users endpoint requires a user-scoped token, so an app token gets a 403.
// The viewer count and duration must still come through untouched, and the
// failure must be remembered rather than retried on every poll.

$refusedTracker = make_dispatch_transport([
    'oauth/token' => ok_token_response(),
    'public/v1/channels' => [
        'httpCode' => 200,
        'body' => ['data' => [channel_item('nopics', 404, true)]],
        'error' => null,
    ],
    'public/v1/users' => ['httpCode' => 403, 'body' => ['message' => 'Forbidden'], 'error' => null],
]);
$GLOBALS['kick_http_transport'] = $refusedTracker->transport;

$refused = build_kick_status_results(['nopics']);
check($refused[0]['status'] === 'live', 'a refused avatar lookup still returns a live status');
check($refused[0]['viewerCount'] === 8200, 'a refused avatar lookup still returns the viewer count');
check(!isset($refused[0]['avatarUrl']), 'a refused avatar lookup simply omits avatarUrl (initials fallback on the client)');

$GLOBALS['kick_http_transport'] = static function (string $method, string $url): array {
    if (str_contains($url, 'public/v1/users')) {
        throw new RuntimeException('users endpoint should not be re-asked within the miss TTL');
    }
    return ['httpCode' => 200, 'body' => ['data' => []], 'error' => null];
};
try {
    build_kick_status_results(['nopics']);
    check(true, 'a known-missing avatar is not re-requested on the next poll');
} catch (RuntimeException $e) {
    check(false, $e->getMessage());
}

// --- Case: creator identity (avatar + user id) survives live → offline -----
// Channel cache is short-TTL (viewer count). Identity is long-TTL. A later
// /channels payload that omits the profile picture must not drop the avatar.

$identityTracker = make_dispatch_transport([
    'oauth/token' => ok_token_response(),
    'public/v1/channels' => [
        'httpCode' => 200,
        'body' => ['data' => [
            channel_item('keepface', 707, true, ['profile_picture' => 'https://files.kick.com/keep.webp']),
        ]],
        'error' => null,
    ],
]);
$GLOBALS['kick_http_transport'] = $identityTracker->transport;
$identityLive = build_kick_status_results(['keepface']);
check($identityLive[0]['status'] === 'live', 'identity fixture starts live');
check($identityLive[0]['avatarUrl'] === 'https://files.kick.com/keep.webp', 'identity fixture stores the live avatar');

kick_cache_delete('kick:channel:keepface');

$identityOfflineTracker = make_dispatch_transport([
    'oauth/token' => ok_token_response(),
    'public/v1/channels' => [
        'httpCode' => 200,
        'body' => ['data' => [channel_item('keepface', 707, false)]],
        'error' => null,
    ],
    'public/v1/users' => static function (): array {
        throw new RuntimeException('identity cache should supply the avatar without a users refetch');
    },
]);
$GLOBALS['kick_http_transport'] = $identityOfflineTracker->transport;
try {
    $identityOffline = build_kick_status_results(['keepface']);
    check($identityOffline[0]['status'] === 'offline', 'the same slug reports offline after the live session ends');
    check(!isset($identityOffline[0]['viewerCount']), 'offline transition clears live-session viewer count');
    check(!isset($identityOffline[0]['startedAt']), 'offline transition clears live-session start time');
    check(
        ($identityOffline[0]['avatarUrl'] ?? null) === 'https://files.kick.com/keep.webp',
        'creator avatar is retained from identity cache when /channels omits it',
    );
    check(call_count($identityOfflineTracker, 'public/v1/users') === 0, 'identity hit does not call /users');
} catch (RuntimeException $e) {
    check(false, 'offline identity lookup hit /users unexpectedly: ' . $e->getMessage());
}

// --- Case: expired access token — 401 triggers exactly one retry -----------

$retryTracker = make_dispatch_transport([
    'oauth/token' => static fn(): array => ok_token_response(),
    'public/v1/channels' => (static function () {
        $seen = 0;
        return static function () use (&$seen): array {
            $seen++;
            if ($seen === 1) {
                return ['httpCode' => 401, 'body' => ['message' => 'Unauthorized'], 'error' => null];
            }
            return [
                'httpCode' => 200,
                'body' => ['data' => [channel_item('retrychannel', 505, true, [
                    'profile_picture' => 'https://files.kick.com/retry.webp',
                ])]],
                'error' => null,
            ];
        };
    })(),
]);
$GLOBALS['kick_http_transport'] = $retryTracker->transport;

$retried = build_kick_status_results(['retrychannel']);
check($retried[0]['status'] === 'live', 'a 401 is retried with a fresh token and then succeeds');
check(call_count($retryTracker, 'public/v1/channels') === 2, 'a 401 causes exactly one retry, not a loop');
check(call_count($retryTracker, 'oauth/token') === 1, 'the 401 retry fetches exactly one fresh token');

// --- Case: upstream failure resolves to unavailable, never an exception ----

$failTracker = make_dispatch_transport([
    'oauth/token' => ok_token_response(),
    'public/v1/channels' => ['httpCode' => 500, 'body' => null, 'error' => null],
]);
$GLOBALS['kick_http_transport'] = $failTracker->transport;
$failed = build_kick_status_results(['brokenchannel']);
check($failed[0]['status'] === 'unavailable', 'an upstream 500 resolves to unavailable, not a thrown error');

// --- Case: no credentials installed -> not_configured ----------------------
// Runs isolated because load_kick_credentials() memoizes per-process.

function run_isolated_case(string $configContents, array $channels): array
{
    $caseRoot = sys_get_temp_dir() . '/kick-status-isolated-' . bin2hex(random_bytes(6));
    mkdir($caseRoot, 0700, true);
    $configPath = $caseRoot . '/kick-config.php';
    if ($configContents !== '') {
        file_put_contents($configPath, $configContents);
    }

    $scriptPath = $caseRoot . '/run.php';
    $endpoint = realpath(__DIR__ . '/../public/api/kick-status.php');
    $script = "<?php\n"
        . "define('KICK_CACHE_DIR', " . var_export($caseRoot . '/cache', true) . ");\n"
        . "define('KICK_CONFIG_PATH', " . var_export($configPath, true) . ");\n"
        . "define('KICK_STATUS_TESTING', true);\n"
        . '$GLOBALS["kick_http_transport"] = static function () {'
        . 'throw new RuntimeException("no upstream call expected without credentials");'
        . "};\n"
        . 'require ' . var_export($endpoint, true) . ";\n"
        . 'echo json_encode(build_kick_status_results(' . var_export($channels, true) . "));\n";
    file_put_contents($scriptPath, $script);

    $output = [];
    $exitCode = 0;
    exec('php ' . escapeshellarg($scriptPath) . ' 2>/dev/null', $output, $exitCode);

    return ['output' => implode("\n", $output), 'exitCode' => $exitCode];
}

$missingConfigCase = run_isolated_case('', ['someuser']);
$missingConfigDecoded = json_decode($missingConfigCase['output'], true);
check(
    $missingConfigCase['exitCode'] === 0
        && is_array($missingConfigDecoded)
        && $missingConfigDecoded[0]['status'] === 'not_configured',
    'a missing config file resolves to not_configured with no upstream call: ' . $missingConfigCase['output'],
);
check(
    is_array($missingConfigDecoded) && !isset($missingConfigDecoded[0]['avatarUrl']),
    'a not_configured result carries no avatar (client falls back to initials)',
);

$badConfigCase = run_isolated_case("<?php\nreturn ['client_id' => '', 'client_secret' => ''];\n", ['someuser']);
$badConfigDecoded = json_decode($badConfigCase['output'], true);
check(
    $badConfigCase['exitCode'] === 0
        && is_array($badConfigDecoded)
        && $badConfigDecoded[0]['status'] === 'not_configured',
    'an empty/blank credential pair also resolves to not_configured: ' . $badConfigCase['output'],
);

// --- Case: lock/unlock round-trip (concurrency primitive) ------------------

$lockA = kick_acquire_or_wait_lock('kick:test-lock-key');
check($lockA !== null, 'kick_acquire_or_wait_lock returns a handle when uncontended');
kick_release_lock($lockA);
$lockB = kick_acquire_or_wait_lock('kick:test-lock-key');
check($lockB !== null, 'a lock can be re-acquired after being released');
kick_release_lock($lockB);

check(KICK_MAX_CHANNELS_PER_REQUEST === 50, 'KICK_MAX_CHANNELS_PER_REQUEST matches Kick\'s documented per-request batch limit');

// --- Summary ----------------------------------------------------------------

fwrite(STDOUT, "{$testCount} checks, " . ($testCount - $failures) . " passed, {$failures} failed\n");
exit($failures > 0 ? 1 : 0);
