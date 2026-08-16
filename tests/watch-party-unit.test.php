<?php
/**
 * Framework-free unit tests for public/api/watch-party.php.
 *
 * Run: php tests/watch-party-unit.test.php
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

$tmpRoot = sys_get_temp_dir() . '/watch-party-test-' . bin2hex(random_bytes(6));
mkdir($tmpRoot, 0700, true);
define('WATCH_PARTY_DIR', $tmpRoot);
define('WATCH_PARTY_TESTING', true);
define('WATCH_PARTY_ACTIVE_TTL', 7 * 24 * 60 * 60);
define('WATCH_PARTY_ENDED_TTL', 24 * 60 * 60);

$endpointFile = realpath(__DIR__ . '/../public/api/watch-party.php');
if ($endpointFile === false) {
    fwrite(STDERR, "FAIL: could not locate public/api/watch-party.php\n");
    exit(1);
}

require $endpointFile;

$streams = [
    ['platform' => 'twitch', 'channel' => 'shroud'],
    ['platform' => 'kick', 'channel' => 'trainwreckstv'],
];

$created = watch_party_create($streams);
check($created['ok'] === true, 'create succeeds');
check(isset($created['id']) && watch_party_valid_id($created['id']), 'create returns a valid room id');
check(isset($created['hostToken']) && strlen($created['hostToken']) === 64, 'create returns a 32-byte hex host token');
check(($created['session']['status'] ?? '') === 'active', 'new session is active');
check(($created['session']['streams'] ?? []) === $streams, 'create stores the lineup in order');
check(!isset($created['session']['hostTokenHash']), 'public view does not include the host token hash');

$id = $created['id'];
$token = $created['hostToken'];

$got = watch_party_get($id);
check($got['ok'] === true, 'GET finds the room');
check(($got['session']['streams'][0]['channel'] ?? '') === 'shroud', 'GET returns current streams');
check(!isset($got['session']['hostToken']), 'GET does not leak the host token');

$forbidden = watch_party_update($id, 'deadbeef', $streams);
check($forbidden['ok'] === false && ($forbidden['error'] ?? '') === 'forbidden', 'update with a wrong token is forbidden');

$reordered = [
    ['platform' => 'kick', 'channel' => 'trainwreckstv'],
    ['platform' => 'twitch', 'channel' => 'shroud'],
    ['platform' => 'youtube', 'channel' => 'handle:pewdiepie'],
];
$updated = watch_party_update($id, $token, $reordered);
check($updated['ok'] === true, 'host update succeeds');
check(($updated['session']['streams'] ?? []) === $reordered, 'update replaces and reorders the lineup');

$lateJoin = watch_party_get($id);
check(($lateJoin['session']['streams'] ?? []) === $reordered, 'a later GET sees the updated lineup');

$badPlatform = watch_party_create([['platform' => 'vimeo', 'channel' => 'x']]);
check($badPlatform['ok'] === false, 'rejects an unknown platform');

$traversal = watch_party_create([['platform' => 'twitch', 'channel' => '../etc/passwd']]);
check($traversal['ok'] === false, 'rejects a path-like channel');

$missing = watch_party_get('zzzzzzzzzz');
check($missing['ok'] === false && ($missing['error'] ?? '') === 'not_found', 'unknown id is not_found');

$endedForbidden = watch_party_end($id, 'nope');
check($endedForbidden['ok'] === false && ($endedForbidden['error'] ?? '') === 'forbidden', 'end with a wrong token is forbidden');

$ended = watch_party_end($id, $token);
check($ended['ok'] === true && ($ended['session']['status'] ?? '') === 'ended', 'host can end the party');

$afterEnd = watch_party_update($id, $token, $streams);
check($afterEnd['ok'] === false && ($afterEnd['error'] ?? '') === 'ended', 'updates after end are rejected');

$getEnded = watch_party_get($id);
check($getEnded['ok'] === true && ($getEnded['session']['status'] ?? '') === 'ended', 'GET still returns an ended session within TTL');

$handleGet = watch_party_handle('GET', ['id' => $id], null);
check($handleGet['http'] === 200 && ($handleGet['body']['session']['status'] ?? '') === 'ended', 'HTTP GET wrapper returns the ended session');

$handleForbidden = watch_party_handle('POST', [], [
    'action' => 'update',
    'id' => $id,
    'hostToken' => 'nope',
    'streams' => $streams,
]);
check($handleForbidden['http'] === 403, 'HTTP update with a wrong token is 403');

$handleCreate = watch_party_handle('POST', [], [
    'action' => 'create',
    'streams' => [['platform' => 'tiktok', 'channel' => 'creator']],
]);
check($handleCreate['http'] === 200 && isset($handleCreate['body']['hostToken']), 'HTTP create returns a host token');
check(($handleCreate['body']['session']['streams'][0]['platform'] ?? '') === 'tiktok', 'HTTP create stores TikTok');

$handleMethod = watch_party_handle('PUT', [], null);
check($handleMethod['http'] === 405, 'non GET/POST is 405');

$expiredId = $handleCreate['body']['id'];
$session = watch_party_read($expiredId);
$session['updatedAt'] = time() - WATCH_PARTY_ACTIVE_TTL - 10;
watch_party_write($expiredId, $session);
$expiredGet = watch_party_get($expiredId);
check($expiredGet['ok'] === false, 'an inactive room past TTL is treated as gone');
check(!is_file(watch_party_file($expiredId)), 'expired room file is deleted on read');

fwrite(STDOUT, "{$testCount} checks, " . ($testCount - $failures) . " passed, {$failures} failed\n");
exit($failures === 0 ? 0 : 1);
