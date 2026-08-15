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
