<?php
/**
 * Framework-free unit tests for Kick webhook signature + event dispatch.
 *
 * Run: php tests/kick-webhook-unit.test.php
 *
 * Uses a locally generated RSA key so verification is proven against a real
 * openssl_verify round-trip. Kick's production public key is never required.
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

$tmpRoot = sys_get_temp_dir() . '/kick-webhook-test-' . bin2hex(random_bytes(6));
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
define('KICK_WEBHOOK_TESTING', true);

$endpointFile = realpath(__DIR__ . '/../public/api/kick-webhook.php');
if ($endpointFile === false) {
    fwrite(STDERR, "FAIL: could not locate public/api/kick-webhook.php\n");
    exit(1);
}
require $endpointFile;

$key = openssl_pkey_new([
    'private_key_bits' => 2048,
    'private_key_type' => OPENSSL_KEYTYPE_RSA,
]);
if ($key === false) {
    fwrite(STDERR, "FAIL: openssl_pkey_new could not generate a test RSA key\n");
    exit(1);
}
$details = openssl_pkey_get_details($key);
$publicPem = is_array($details) ? (string) $details['key'] : '';
check($publicPem !== '' && str_contains($publicPem, 'BEGIN PUBLIC KEY'), 'test RSA public key exported');

function sign_payload(mixed $key, string $messageId, string $timestamp, string $body): string
{
    $payload = $messageId . '.' . $timestamp . '.' . $body;
    $signature = '';
    openssl_sign($payload, $signature, $key, OPENSSL_ALGO_SHA256);
    return base64_encode($signature);
}

$messageId = '01TESTMESSAGEID000000000000';
$timestamp = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z');
$body = json_encode([
    'message_id' => 'msg-1',
    'broadcaster' => [
        'user_id' => 123,
        'username' => 'deen',
        'channel_slug' => 'deenthegreat',
    ],
    'sender' => [
        'username' => 'viewer1',
        'identity' => [
            'username_color' => '#FF5733',
            'badges' => [['text' => 'Moderator', 'type' => 'moderator']],
        ],
    ],
    'content' => 'Hello [emote:4148074:HYPERCLAP] world',
    'emotes' => [
        ['emote_id' => '4148074', 'positions' => [['s' => 6, 'e' => 30]]],
    ],
    'created_at' => '2026-08-15T12:00:00Z',
], JSON_UNESCAPED_SLASHES);
check(is_string($body), 'fixture body encodes');

$goodSig = sign_payload($key, $messageId, $timestamp, (string) $body);
check(
    kick_verify_webhook_signature($messageId, $timestamp, (string) $body, $goodSig, $publicPem),
    'valid Kick-style signature verifies',
);

$badSig = sign_payload($key, $messageId, $timestamp, (string) $body . 'tampered');
check(
    !kick_verify_webhook_signature($messageId, $timestamp, (string) $body, $badSig, $publicPem),
    'signature over a different body is rejected',
);

check(
    !kick_verify_webhook_signature($messageId, $timestamp, (string) $body, '%%%%not-base64', $publicPem),
    'malformed base64 signature is rejected',
);

check(
    !kick_verify_webhook_signature('', $timestamp, (string) $body, $goodSig, $publicPem),
    'missing message id is rejected',
);

$stale = (new DateTimeImmutable('-20 minutes', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z');
check(!kick_webhook_timestamp_fresh($stale), 'timestamp older than skew window is stale');
check(kick_webhook_timestamp_fresh($timestamp), 'current timestamp is fresh');
check(!kick_webhook_timestamp_fresh('not-a-date'), 'unparseable timestamp is stale');

$decoded = json_decode((string) $body, true);
check(is_array($decoded), 'fixture JSON decodes');
check(
    kick_handle_webhook_event('chat.message.sent', '1', $decoded),
    'chat.message.sent version 1 is accepted',
);

$stored = kick_chat_messages_after('deenthegreat', null);
check(count($stored) === 1, 'accepted chat event is stored in the channel buffer');
check(($stored[0]['messageId'] ?? '') === 'msg-1', 'stored message_id matches');
check(($stored[0]['sender']['username'] ?? '') === 'viewer1', 'stored sender username');
check(($stored[0]['sender']['color'] ?? '') === '#FF5733', 'stored username color when valid');
check(($stored[0]['sender']['badges'][0]['type'] ?? '') === 'moderator', 'stored moderator badge');
check(count($stored[0]['emotes'] ?? []) === 1, 'stored emote metadata');

check(
    kick_handle_webhook_event('chat.message.sent', '1', $decoded),
    'duplicate chat.message.sent is still accepted',
);
$afterDup = kick_chat_messages_after('deenthegreat', null);
check(count($afterDup) === 1, 'duplicate message_id is not stored twice');

check(
    kick_handle_webhook_event('livestream.status.updated', '1', ['broadcaster' => ['channel_slug' => 'x']]),
    'unknown event type is accepted without storing (forward-compatible)',
);
check(
    count(kick_chat_messages_after('deenthegreat', null)) === 1,
    'unknown event type does not pollute the chat buffer',
);

check(
    !kick_handle_webhook_event('chat.message.sent', '99', $decoded),
    'unsupported chat.message.sent version is rejected',
);

$unsafe = $decoded;
$unsafe['sender']['identity']['username_color'] = 'red; background: url(x)';
$unsafe['message_id'] = 'msg-color';
kick_handle_webhook_event('chat.message.sent', '1', $unsafe);
$colorMsg = null;
foreach (kick_chat_messages_after('deenthegreat', null) as $msg) {
    if (($msg['messageId'] ?? '') === 'msg-color') $colorMsg = $msg;
}
check(is_array($colorMsg), 'unsafe-color message still stored');
check(
    array_key_exists('color', $colorMsg['sender']) && $colorMsg['sender']['color'] === null,
    'unsafe username color is dropped',
);

$normalized = kick_chat_normalize_message(['content' => 'no id']);
check($normalized === null, 'payload without message_id is dropped');

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
