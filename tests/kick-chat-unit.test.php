<?php
/**
 * Framework-free unit tests for Kick chat buffer + subscription reuse.
 *
 * Run: php tests/kick-chat-unit.test.php
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

$tmpRoot = sys_get_temp_dir() . '/kick-chat-test-' . bin2hex(random_bytes(6));
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
define('KICK_CHAT_TESTING', true);
define('KICK_CHAT_MAX_MESSAGES', 3);
define('KICK_CHAT_SUB_DAILY_CAP', 50);
define('KICK_CHAT_SUB_FAIL_TTL', 30 * 60);
define('KICK_CHAT_RATE_GET_MAX', 3);
define('KICK_CHAT_RATE_GET_WINDOW', 60);

$endpointFile = realpath(__DIR__ . '/../public/api/kick-chat.php');
if ($endpointFile === false) {
    fwrite(STDERR, "FAIL: could not locate public/api/kick-chat.php\n");
    exit(1);
}
require $endpointFile;

function make_dispatch_transport(array $rules): object
{
    $tracker = new stdClass();
    $tracker->calls = [];
    $tracker->transport = function (string $method, string $url, array $params, array $headers) use ($tracker, $rules) {
        $tracker->calls[] = $method . ' ' . $url;
        foreach ($rules as $match => $response) {
            if (str_contains($url, $match)) {
                return is_callable($response) ? $response($method, $url, $params, $headers) : $response;
            }
        }
        throw new RuntimeException('no transport rule matched ' . $url);
    };
    return $tracker;
}

function ok_token_response(): array
{
    return [
        'httpCode' => 200,
        'body' => [
            'access_token' => 'tok-chat-test',
            'token_type' => 'Bearer',
            'expires_in' => 3600,
        ],
        'error' => null,
    ];
}

$msg = static function (string $id, string $content): array {
    $normalized = kick_chat_normalize_message([
        'message_id' => $id,
        'sender' => ['username' => 'u-' . $id],
        'content' => $content,
        'created_at' => '2026-08-15T12:00:00Z',
        'broadcaster' => ['channel_slug' => 'deenthegreat'],
    ]);
    if ($normalized === null) {
        throw new RuntimeException('fixture failed to normalize ' . $id);
    }
    return $normalized;
};

check(kick_chat_append_message('deenthegreat', $msg('a', 'one')), 'first message stores');
check(kick_chat_append_message('deenthegreat', $msg('b', 'two')), 'second message stores');
check(!kick_chat_append_message('deenthegreat', $msg('a', 'one again')), 'duplicate message_id is rejected');
check(count(kick_chat_messages_after('deenthegreat', null)) === 2, 'buffer has two unique messages');

$afterA = kick_chat_messages_after('deenthegreat', 'a');
check(count($afterA) === 1 && ($afterA[0]['messageId'] ?? '') === 'b', 'after= cursor returns only newer messages');

$unknown = kick_chat_messages_after('deenthegreat', 'missing');
check(count($unknown) === 2, 'unknown after= cursor resyncs the recent window');

check(kick_chat_append_message('deenthegreat', $msg('c', 'three')), 'third message stores');
check(kick_chat_append_message('deenthegreat', $msg('d', 'four')), 'fourth message stores');
$capped = kick_chat_messages_after('deenthegreat', null);
check(count($capped) === 3, 'buffer is capped at KICK_CHAT_MAX_MESSAGES');
check(($capped[0]['messageId'] ?? '') === 'b', 'oldest message is dropped when the cap is exceeded');
check(($capped[2]['messageId'] ?? '') === 'd', 'newest message is retained');

$tracker = make_dispatch_transport([
    'id.kick.com/oauth/token' => ok_token_response(),
    'events/subscriptions' => function (string $method) {
        if ($method === 'GET') {
            return [
                'httpCode' => 200,
                'body' => [
                    'data' => [[
                        'id' => 'sub-existing',
                        'event' => 'chat.message.sent',
                        'method' => 'webhook',
                        'broadcaster_user_id' => 42,
                    ]],
                ],
                'error' => null,
            ];
        }
        throw new RuntimeException('POST should not run when GET already has the subscription');
    },
]);
$GLOBALS['kick_http_transport'] = $tracker->transport;

$first = kick_ensure_chat_subscription(42);
check($first['ok'] === true, 'ensure subscription succeeds');
check($first['reused'] === true, 'existing GET subscription is reused');
check($first['subscriptionId'] === 'sub-existing', 'reused subscription id is returned');

$second = kick_ensure_chat_subscription(42);
check($second['reused'] === true, 'second ensure hits the cache and still reuses');
$postCalls = count(array_filter(
    $tracker->calls,
    static fn(string $c) => str_starts_with($c, 'POST ') && str_contains($c, 'events/subscriptions'),
));
check($postCalls === 0, 'POST /events/subscriptions is not called when a subscription already exists');

unset($GLOBALS['kick_http_transport']);
$createTracker = make_dispatch_transport([
    'id.kick.com/oauth/token' => ok_token_response(),
    'events/subscriptions' => function (string $method, string $url, array $params) {
        if ($method === 'GET') {
            return ['httpCode' => 200, 'body' => ['data' => []], 'error' => null];
        }
        $json = json_decode((string) ($params['_json'] ?? ''), true);
        if (!is_array($json) || ($json['broadcaster_user_id'] ?? null) !== 99) {
            throw new RuntimeException('POST body missing broadcaster_user_id');
        }
        if (($json['events'][0]['name'] ?? '') !== 'chat.message.sent') {
            throw new RuntimeException('POST body missing chat.message.sent');
        }
        if (($json['method'] ?? '') !== 'webhook') {
            throw new RuntimeException('POST method must be webhook');
        }
        return [
            'httpCode' => 200,
            'body' => ['data' => [['id' => 'sub-new', 'name' => 'chat.message.sent']]],
            'error' => null,
        ];
    },
]);
$GLOBALS['kick_http_transport'] = $createTracker->transport;
kick_cache_delete('kick:app-token');

$created = kick_ensure_chat_subscription(99);
check($created['ok'] === true, 'create subscription succeeds when none exists');
check($created['reused'] === false, 'newly created subscription is not marked reused');
check($created['subscriptionId'] === 'sub-new', 'new subscription id is returned');

// --- Subscription-attempt guards (Kick Events quota protection) ---

// Failure backoff: a failed attempt is recorded, and the next ensure for
// the same broadcaster backs off WITHOUT calling the API again.
unset($GLOBALS['kick_http_transport']);
$failTracker = make_dispatch_transport([
    'id.kick.com/oauth/token' => ok_token_response(),
    'events/subscriptions' => function (string $method) {
        if ($method === 'GET') {
            return ['httpCode' => 200, 'body' => ['data' => []], 'error' => null];
        }
        return ['httpCode' => 500, 'body' => null, 'error' => 'http_500'];
    },
]);
$GLOBALS['kick_http_transport'] = $failTracker->transport;
kick_cache_delete('kick:app-token');

$failed = kick_ensure_chat_subscription(7);
check($failed['ok'] === false, 'a failing broadcaster fails the ensure');
$callsAfterFail = count($failTracker->calls);
$backoff = kick_ensure_chat_subscription(7);
check($backoff['ok'] === false && ($backoff['error'] ?? '') === 'subscription_backoff', 'the retry is served from failure backoff');
check(count($failTracker->calls) === $callsAfterFail, 'backoff makes no further API calls (no retry-storm)');

// A later success (e.g. the upstream hiccup cleared) clears the marker.
kick_cache_delete('kick:chat-sub-fail:7');
unset($GLOBALS['kick_http_transport']);
$recoverTracker = make_dispatch_transport([
    'id.kick.com/oauth/token' => ok_token_response(),
    'events/subscriptions' => function (string $method) {
        if ($method === 'GET') {
            return ['httpCode' => 200, 'body' => ['data' => []], 'error' => null];
        }
        return ['httpCode' => 200, 'body' => ['data' => [['id' => 'sub-7']]], 'error' => null];
    },
]);
$GLOBALS['kick_http_transport'] = $recoverTracker->transport;
kick_cache_delete('kick:app-token');
$recovered = kick_ensure_chat_subscription(7);
check($recovered['ok'] === true, 'ensure works again once the backoff marker expires/is cleared');

// Daily cap: at the cap, ensure refuses BEFORE any upstream call, and the
// caller still gets a non-error signal (the chat buffer is served anyway).
$dailyKey = 'kick:chat-sub-daily:' . gmdate('Y-m-d');
kick_cache_set($dailyKey, ['count' => KICK_CHAT_SUB_DAILY_CAP], 3600);
unset($GLOBALS['kick_http_transport']);
$capTracker = make_dispatch_transport([]);
$GLOBALS['kick_http_transport'] = $capTracker->transport;
$cappedSub = kick_ensure_chat_subscription(1234);
check($cappedSub['ok'] === false && ($cappedSub['error'] ?? '') === 'quota_exceeded', 'at the daily cap, attempts stop');
check(count($capTracker->calls) === 0, 'the daily cap blocks even the token request');
kick_cache_delete($dailyKey);

// Success under the cap still counts as an attempt (attempts, not just
// successes, are what the quota feels).
kick_cache_set($dailyKey, ['count' => KICK_CHAT_SUB_DAILY_CAP - 1], 3600);
unset($GLOBALS['kick_http_transport']);
$GLOBALS['kick_http_transport'] = $recoverTracker->transport;
kick_cache_delete('kick:app-token');
$lastAllowed = kick_ensure_chat_subscription(8);
check($lastAllowed['ok'] === true, 'the final attempt under the cap still goes through');
$nowCapped = kick_ensure_chat_subscription(9);
check($nowCapped['ok'] === false && ($nowCapped['error'] ?? '') === 'quota_exceeded', 'attempt N+1 is refused');
kick_cache_delete($dailyKey);
unset($GLOBALS['kick_http_transport']);

// Per-IP GET throttle (sliding window over the shared cache dir).
check(kick_chat_rate_limited('9.9.9.9') === false, 'chat GET 1 within budget');
check(kick_chat_rate_limited('9.9.9.9') === false, 'chat GET 2 within budget');
check(kick_chat_rate_limited('9.9.9.9') === false, 'chat GET 3 within budget');
check(kick_chat_rate_limited('9.9.9.9') === true, 'chat GET 4 is throttled');
check(kick_chat_rate_limited('8.8.8.8') === false, 'a different IP keeps its own budget');

$reply = kick_chat_normalize_message([
    'message_id' => 'reply-1',
    'content' => 'pong',
    'sender' => ['username' => 'bob'],
    'replies_to' => [
        'message_id' => 'parent-1',
        'content' => 'ping',
        'sender' => ['username' => 'alice'],
    ],
    'created_at' => '2026-08-15T12:00:00Z',
]);
check(is_array($reply), 'reply payload normalizes');
check(($reply['repliesTo']['username'] ?? '') === 'alice', 'reply parent username is kept');
check(($reply['repliesTo']['content'] ?? '') === 'ping', 'reply parent content is kept');

function rm_tree(string $dir): void
{
    if (!is_dir($dir)) return;
    $items = scandir($dir);
    if ($items === false) return;
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') continue;
        $path = $dir . '/' . $item;
        if (is_dir($path)) rm_tree($path);
        else @unlink($path);
    }
    @rmdir($dir);
}
rm_tree($tmpRoot);

fwrite(STDOUT, "{$testCount} checks, " . ($testCount - $failures) . " passed, {$failures} failed\n");
exit($failures === 0 ? 0 : 1);
