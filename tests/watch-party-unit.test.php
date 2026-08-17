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
mkdir($tmpRoot . '-ratelimit', 0700, true);
define('WATCH_PARTY_DIR', $tmpRoot);
define('WATCH_PARTY_RATELIMIT_DIR', $tmpRoot . '-ratelimit');
define('WATCH_PARTY_TESTING', true);
define('WATCH_PARTY_ACTIVE_TTL', 7 * 24 * 60 * 60);
define('WATCH_PARTY_ENDED_TTL', 24 * 60 * 60);
define('WATCH_PARTY_HOST_IDLE_TTL', 30 * 60);
define('WATCH_PARTY_HOST_LIVE_WINDOW', 120);
define('WATCH_PARTY_VIEWER_LIVE_WINDOW', 90);
define('WATCH_PARTY_MAX_VIEWERS', 1000);
// Small injectable budgets so the rate-limit tests don't need hundreds of requests.
define('WATCH_PARTY_RATE_CREATE_MAX', 2);
define('WATCH_PARTY_RATE_CREATE_WINDOW', 3600);
define('WATCH_PARTY_RATE_WRITE_MAX', 3);
define('WATCH_PARTY_RATE_WRITE_WINDOW', 60);
define('WATCH_PARTY_RATE_GET_MAX', 3);
define('WATCH_PARTY_RATE_GET_WINDOW', 60);
define('WATCH_PARTY_MAX_ROOMS', 200);

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

// Per-stream orientation (YouTube Shorts stay portrait for party viewers).
$oriented = watch_party_create([
    ['platform' => 'youtube', 'channel' => 'video:abc123', 'orientation' => 'portrait'],
    ['platform' => 'twitch', 'channel' => 'shroud'],
]);
check($oriented['ok'] === true, 'create with orientation succeeds');
check(
    ($oriented['session']['streams'][0]['orientation'] ?? '') === 'portrait',
    'orientation survives create -> public view'
);
check(
    !isset($oriented['session']['streams'][1]['orientation']),
    'a stream without orientation stays absent (viewer derives from platform)'
);

$badOrientation = watch_party_create([
    ['platform' => 'youtube', 'channel' => 'video:abc123', 'orientation' => 'square'],
]);
check($badOrientation['ok'] === false && ($badOrientation['error'] ?? '') === 'invalid_input', 'an invalid orientation rejects the payload');

$orientedId = $oriented['id'];
$orientedToken = $oriented['hostToken'];
$orientedUpdate = watch_party_update($orientedId, $orientedToken, [
    ['platform' => 'youtube', 'channel' => 'video:abc123', 'orientation' => 'landscape'],
]);
check(
    $orientedUpdate['ok'] === true && ($orientedUpdate['session']['streams'][0]['orientation'] ?? '') === 'landscape',
    'orientation survives update -> public view'
);
$orientedGet = watch_party_get($orientedId);
check(
    ($orientedGet['session']['streams'][0]['orientation'] ?? '') === 'landscape',
    'orientation round-trips through GET'
);

// Host spotlight: view mode + primary stream id shared with viewers.
$spotlight = watch_party_create($streams, ['mode' => 'theater', 'primary' => 'twitch:shroud']);
check($spotlight['ok'] === true, 'create with a view succeeds');
check(
    ($spotlight['session']['view'] ?? null) === ['mode' => 'theater', 'primary' => 'twitch:shroud'],
    'view survives create -> public view'
);
$spotlightId = $spotlight['id'];
$spotlightToken = $spotlight['hostToken'];

$spotlightGet = watch_party_get($spotlightId);
check(
    ($spotlightGet['session']['view']['mode'] ?? '') === 'theater',
    'view round-trips through GET'
);

$spotlightUpdate = watch_party_update($spotlightId, $spotlightToken, $streams, ['mode' => 'focus', 'primary' => 'kick:trainwreckstv']);
check(
    $spotlightUpdate['ok'] === true && ($spotlightUpdate['session']['view']['mode'] ?? '') === 'focus',
    'update replaces the view'
);

$chatUpdate = watch_party_update($spotlightId, $spotlightToken, $streams, [
    'mode' => 'focus',
    'primary' => 'kick:trainwreckstv',
    'chatVisible' => false,
]);
check(
    $chatUpdate['ok'] === true && ($chatUpdate['session']['view']['chatVisible'] ?? null) === false,
    'chat visibility survives update -> public view'
);

$viewKept = watch_party_update($spotlightId, $spotlightToken, $streams);
check(
    $viewKept['ok'] === true && ($viewKept['session']['view']['mode'] ?? '') === 'focus',
    'an update without a view keeps the room\'s existing view (older clients do not clobber it)'
);

$badMode = watch_party_create($streams, ['mode' => 'spotlight', 'primary' => null]);
check($badMode['ok'] === false && ($badMode['error'] ?? '') === 'invalid_input', 'an unknown view mode rejects the payload');

$badPrimary = watch_party_create($streams, ['mode' => 'theater', 'primary' => '../../etc']);
check($badPrimary['ok'] === false && ($badPrimary['error'] ?? '') === 'invalid_input', 'a path-like primary rejects the payload');

$badViewUpdate = watch_party_update($spotlightId, $spotlightToken, $streams, 'theater');
check($badViewUpdate['ok'] === false && ($badViewUpdate['error'] ?? '') === 'invalid_input', 'a non-array view rejects the update');

$badChat = watch_party_create($streams, ['mode' => 'grid', 'primary' => null, 'chatVisible' => 'false']);
check($badChat['ok'] === false && ($badChat['error'] ?? '') === 'invalid_input', 'a non-boolean chat visibility rejects the payload');

$gridView = watch_party_create($streams, ['mode' => 'grid', 'primary' => null]);
check(
    $gridView['ok'] === true && ($gridView['session']['view'] ?? null) === ['mode' => 'grid', 'primary' => null],
    'grid with a null primary is valid'
);

$noView = watch_party_create($streams);
check($noView['ok'] === true && !isset($noView['session']['view']), 'create without a view stays viewless (older clients)');

// Host presence: heartbeat + hostLive + idle auto-end.
$presence = watch_party_create($streams);
check($presence['ok'] === true, 'presence: create succeeds');
$presenceId = $presence['id'];
$presenceToken = $presence['hostToken'];
check(($presence['session']['hostLive'] ?? null) === true, 'a freshly created room is host-live');

$beat = watch_party_heartbeat($presenceId, $presenceToken);
check($beat['ok'] === true, 'host heartbeat succeeds');
check(($beat['session']['hostLive'] ?? null) === true, 'heartbeat response is host-live');

$beatForbidden = watch_party_heartbeat($presenceId, 'deadbeef');
check($beatForbidden['ok'] === false && ($beatForbidden['error'] ?? '') === 'forbidden', 'heartbeat with a wrong token is forbidden');

$room = watch_party_read($presenceId);
check(isset($room['hostSeenAt']) && $room['hostSeenAt'] >= time() - 5, 'heartbeat stamps hostSeenAt');

// Host away but inside the idle TTL: hostLive false, room stays active.
$room['hostSeenAt'] = time() - WATCH_PARTY_HOST_LIVE_WINDOW - 10;
watch_party_write($presenceId, $room);
$awayGet = watch_party_get($presenceId);
check($awayGet['ok'] === true && ($awayGet['session']['hostLive'] ?? null) === false, 'GET reports host away past the live window');
check(($awayGet['session']['status'] ?? '') === 'active', 'host away does not end the room');

// Host idle past the idle TTL: the room is rewritten as ended on read.
$room = watch_party_read($presenceId);
$room['hostSeenAt'] = time() - WATCH_PARTY_HOST_IDLE_TTL - 10;
watch_party_write($presenceId, $room);
$idleGet = watch_party_get($presenceId);
check($idleGet['ok'] === true && ($idleGet['session']['status'] ?? '') === 'ended', 'an idle-host room is ended on read');
check(($idleGet['session']['streams'] ?? []) === $streams, 'the idle-ended room keeps its lineup for viewers');
check(is_file(watch_party_file($presenceId)), 'the idle-ended room file is kept (24h ended grace), not deleted');

$beatAfterEnd = watch_party_heartbeat($presenceId, $presenceToken);
check($beatAfterEnd['ok'] === false && ($beatAfterEnd['error'] ?? '') === 'ended', 'heartbeat after idle auto-end is ended');

// Pre-presence room file (no hostSeenAt): updatedAt stands in, so such a
// room is not instantly ended by the new idle check.
$legacy = watch_party_create($streams);
$legacyRoom = watch_party_read($legacy['id']);
unset($legacyRoom['hostSeenAt']);
watch_party_write($legacy['id'], $legacyRoom);
$legacyGet = watch_party_get($legacy['id']);
check($legacyGet['ok'] === true && ($legacyGet['session']['status'] ?? '') === 'active', 'a pre-presence room with a recent update is not idle-ended');
check(($legacyGet['session']['hostLive'] ?? null) === false, 'a pre-presence room is not host-live (no heartbeat ever seen)');

// Viewer presence: hb=1 upserts the viewer; the count is host-only.
$audience = watch_party_create($streams);
$audienceId = $audience['id'];
$audienceToken = $audience['hostToken'];
check(($audience['viewerCount'] ?? null) === 0, 'create returns viewerCount 0 to the host');

$plainPoll = watch_party_get($audienceId);
check(!isset($plainPoll['session']['viewerCount']), 'public GET never exposes viewerCount');
$roomAfterPlain = watch_party_read($audienceId);
check(empty($roomAfterPlain['viewers']), 'a poll without hb=1 does not write presence');

$pingA = watch_party_get($audienceId, 'viewer-aaaa');
check($pingA['ok'] === true, 'viewer presence ping succeeds');
$pingB = watch_party_get($audienceId, 'viewer-bbbb');
$roomAfterPings = watch_party_read($audienceId);
check(count($roomAfterPings['viewers'] ?? []) === 2, 'two viewer pings are recorded');

$beatWithCount = watch_party_heartbeat($audienceId, $audienceToken);
check(($beatWithCount['viewerCount'] ?? null) === 2, 'heartbeat returns the host-only viewer count');

$updateWithCount = watch_party_update($audienceId, $audienceToken, $streams);
check(($updateWithCount['viewerCount'] ?? null) === 2, 'update returns the host-only viewer count');

$getStillClean = watch_party_get($audienceId);
check(!isset($getStillClean['session']['viewerCount']), 'GET still never exposes viewerCount after pings');

// A stale viewer (past the live window) is pruned out of the count.
$roomPrune = watch_party_read($audienceId);
$roomPrune['viewers']['viewer-aaaa'] = time() - WATCH_PARTY_VIEWER_LIVE_WINDOW - 10;
watch_party_write($audienceId, $roomPrune);
$beatPruned = watch_party_heartbeat($audienceId, $audienceToken);
check(($beatPruned['viewerCount'] ?? null) === 1, 'stale viewers are pruned out of the count');

// hb=1 with a malformed vid is ignored (no write, no error).
$badVid = watch_party_handle('GET', ['id' => $audienceId, 'vid' => '../../x', 'hb' => '1'], null);
check($badVid['http'] === 200, 'a malformed vid does not error the GET');
$roomAfterBadVid = watch_party_read($audienceId);
check(!isset($roomAfterBadVid['viewers']['../../x']), 'a malformed vid is not recorded');

// Rate limits (per-IP fixed windows; budgets injected small above).
// NOTE: direct watch_party_*() calls bypass the limiter by design — only
// the HTTP boundary (watch_party_handle) enforces it.
$_SERVER['REMOTE_ADDR'] = '10.9.9.1';
$getAllowed = 0;
for ($i = 0; $i < WATCH_PARTY_RATE_GET_MAX; $i++) {
    $r = watch_party_handle('GET', ['id' => $audienceId], null);
    if ($r['http'] === 200) $getAllowed++;
}
check($getAllowed === WATCH_PARTY_RATE_GET_MAX, 'GETs within budget succeed');
$getLimited = watch_party_handle('GET', ['id' => $audienceId], null);
check($getLimited['http'] === 429 && ($getLimited['body']['error'] ?? '') === 'rate_limited', 'GET past budget is 429 rate_limited');

// A different IP has its own window.
$_SERVER['REMOTE_ADDR'] = '10.9.9.2';
$otherIp = watch_party_handle('GET', ['id' => $audienceId], null);
check($otherIp['http'] === 200, 'a different IP is unaffected by the first IP\'s limit');

// The window resets: simulate an expired window by backdating the file.
$rateFile = WATCH_PARTY_RATELIMIT_DIR . '/get-' . hash('sha256', '10.9.9.1') . '.json';
file_put_contents($rateFile, json_encode(['windowStart' => time() - WATCH_PARTY_RATE_GET_WINDOW - 5, 'count' => 99]));
$_SERVER['REMOTE_ADDR'] = '10.9.9.1';
$afterReset = watch_party_handle('GET', ['id' => $audienceId], null);
check($afterReset['http'] === 200, 'the GET budget resets after the window');

// Write budget (update/heartbeat/end share it).
$_SERVER['REMOTE_ADDR'] = '10.9.9.3';
$writeBody = ['action' => 'heartbeat', 'id' => $audienceId, 'hostToken' => $audienceToken];
$writeAllowed = 0;
for ($i = 0; $i < WATCH_PARTY_RATE_WRITE_MAX; $i++) {
    $r = watch_party_handle('POST', [], $writeBody);
    if ($r['http'] === 200) $writeAllowed++;
}
check($writeAllowed === WATCH_PARTY_RATE_WRITE_MAX, 'heartbeats within budget succeed');
$writeLimited = watch_party_handle('POST', [], $writeBody);
check($writeLimited['http'] === 429 && ($writeLimited['body']['error'] ?? '') === 'rate_limited', 'heartbeat past budget is 429 rate_limited');

// Create budget: 10/IP/hour in prod (2 here).
$_SERVER['REMOTE_ADDR'] = '10.9.9.4';
$createBody = ['action' => 'create', 'streams' => $streams];
$createAllowed = 0;
for ($i = 0; $i < WATCH_PARTY_RATE_CREATE_MAX; $i++) {
    $r = watch_party_handle('POST', [], $createBody);
    if ($r['http'] === 200) $createAllowed++;
}
check($createAllowed === WATCH_PARTY_RATE_CREATE_MAX, 'creates within budget succeed');
$createLimited = watch_party_handle('POST', [], $createBody);
check($createLimited['http'] === 429 && ($createLimited['body']['error'] ?? '') === 'rate_limited', 'create past budget is 429 rate_limited');

// Room cap: fill the dir to WATCH_PARTY_MAX_ROOMS with direct creates
// (which bypass the HTTP boundary's limiter by design), then a fresh IP
// with an intact create budget gets busy rather than a new room.
$activeBefore = watch_party_active_room_count();
check($activeBefore > 0 && $activeBefore < WATCH_PARTY_MAX_ROOMS, 'active room count reflects created rooms');
while (watch_party_active_room_count() < WATCH_PARTY_MAX_ROOMS) {
    watch_party_create([['platform' => 'twitch', 'channel' => 'filler']]);
}
$_SERVER['REMOTE_ADDR'] = '10.9.9.9';
$capped = watch_party_handle('POST', [], ['action' => 'create', 'streams' => $streams]);
check($capped['http'] === 503 && ($capped['body']['error'] ?? '') === 'busy', 'create at the room cap is 503 busy');

// Ended rooms do not count toward the cap: ending one frees a slot.
$oneFiller = watch_party_create([['platform' => 'twitch', 'channel' => 'capfree']]);
// (Direct create bypasses the cap, so this room exists beyond the cap;
// ending it must still drop the active count by exactly one.)
$countBeforeEnd = watch_party_active_room_count();
watch_party_end($oneFiller['id'], $oneFiller['hostToken']);
check(watch_party_active_room_count() === $countBeforeEnd - 1, 'an ended room frees a cap slot');

fwrite(STDOUT, "{$testCount} checks, " . ($testCount - $failures) . " passed, {$failures} failed\n");
exit($failures === 0 ? 0 : 1);
