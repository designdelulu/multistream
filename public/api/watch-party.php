<?php
/**
 * Live watch-party session store for MultiStream.cc.
 *
 * Synchronizes lineup state only — never video. Each viewer still loads
 * Twitch/Kick/YouTube/TikTok players directly. This endpoint is the
 * shared session: who is in the party, in what order.
 *
 * Contract:
 *   GET  /api/watch-party.php?id=ROOM_ID
 *        → public snapshot (no host token)
 *   POST /api/watch-party.php  JSON body:
 *        { "action": "create", "streams": [ { "platform", "channel" }, ... ] }
 *        { "action": "update", "id", "hostToken", "streams": [...] }
 *        { "action": "end",    "id", "hostToken" }
 *
 * Always JSON. Host token is shown once on create and stored only as a
 * SHA-256 hash on disk. Viewer GETs never receive it.
 *
 * Persistence: one JSON file per room under
 * ~/multistream-secrets/watch-party/ (sibling of the resolver cache,
 * outside the web root). No database. Active rooms expire 7 days after
 * the last host update; ended rooms are kept 24 hours so late joiners
 * see "ended" rather than a 404. If the host tabs away, the room stays
 * until that TTL — it does not vanish the moment they disconnect.
 *
 * Same DreamHost layout as the other resolvers: this file lives at
 * <web-root>/api/watch-party.php, two levels up is the home directory.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

if (!defined('WATCH_PARTY_DIR')) {
    define('WATCH_PARTY_DIR', dirname(__DIR__, 2) . '/multistream-secrets/watch-party');
}
if (!defined('WATCH_PARTY_ACTIVE_TTL')) {
    define('WATCH_PARTY_ACTIVE_TTL', 7 * 24 * 60 * 60);
}
if (!defined('WATCH_PARTY_ENDED_TTL')) {
    define('WATCH_PARTY_ENDED_TTL', 24 * 60 * 60);
}
if (!defined('WATCH_PARTY_MAX_STREAMS')) {
    define('WATCH_PARTY_MAX_STREAMS', 50);
}
if (!defined('WATCH_PARTY_ID_LENGTH')) {
    define('WATCH_PARTY_ID_LENGTH', 10);
}

/**
 * @return array{ok: bool, id?: string, hostToken?: string, session?: array, error?: string, http?: int}
 */
function watch_party_create(array $streams): array
{
    $normalized = watch_party_normalize_streams($streams);
    if ($normalized === null) {
        return ['ok' => false, 'error' => 'invalid_input', 'http' => 400];
    }
    if (!watch_party_ensure_dir()) {
        return ['ok' => false, 'error' => 'storage_unavailable', 'http' => 503];
    }

    $id = watch_party_new_id();
    if ($id === null) {
        return ['ok' => false, 'error' => 'storage_unavailable', 'http' => 503];
    }

    $hostToken = bin2hex(random_bytes(32));
    $now = time();
    $session = [
        'id' => $id,
        'hostTokenHash' => hash('sha256', $hostToken),
        'status' => 'active',
        'streams' => $normalized,
        'updatedAt' => $now,
        'createdAt' => $now,
    ];
    if (!watch_party_write($id, $session)) {
        return ['ok' => false, 'error' => 'storage_unavailable', 'http' => 503];
    }

    return [
        'ok' => true,
        'id' => $id,
        'hostToken' => $hostToken,
        'session' => watch_party_public_view($session),
        'http' => 200,
    ];
}

/**
 * @return array{ok: bool, session?: array, error?: string, http?: int}
 */
function watch_party_get(string $id): array
{
    $session = watch_party_read_fresh($id);
    if ($session === null) {
        return ['ok' => false, 'error' => 'not_found', 'http' => 404];
    }
    return ['ok' => true, 'session' => watch_party_public_view($session), 'http' => 200];
}

/**
 * @return array{ok: bool, session?: array, error?: string, http?: int}
 */
function watch_party_update(string $id, string $hostToken, array $streams): array
{
    $normalized = watch_party_normalize_streams($streams);
    if ($normalized === null) {
        return ['ok' => false, 'error' => 'invalid_input', 'http' => 400];
    }

    $session = watch_party_read_fresh($id);
    if ($session === null) {
        return ['ok' => false, 'error' => 'not_found', 'http' => 404];
    }
    if (!watch_party_token_matches($session, $hostToken)) {
        return ['ok' => false, 'error' => 'forbidden', 'http' => 403];
    }
    if (($session['status'] ?? '') === 'ended') {
        return ['ok' => false, 'error' => 'ended', 'http' => 409];
    }

    $session['streams'] = $normalized;
    $session['updatedAt'] = time();
    if (!watch_party_write($id, $session)) {
        return ['ok' => false, 'error' => 'storage_unavailable', 'http' => 503];
    }
    return ['ok' => true, 'session' => watch_party_public_view($session), 'http' => 200];
}

/**
 * @return array{ok: bool, session?: array, error?: string, http?: int}
 */
function watch_party_end(string $id, string $hostToken): array
{
    $session = watch_party_read_fresh($id);
    if ($session === null) {
        return ['ok' => false, 'error' => 'not_found', 'http' => 404];
    }
    if (!watch_party_token_matches($session, $hostToken)) {
        return ['ok' => false, 'error' => 'forbidden', 'http' => 403];
    }

    $session['status'] = 'ended';
    $session['updatedAt'] = time();
    if (!watch_party_write($id, $session)) {
        return ['ok' => false, 'error' => 'storage_unavailable', 'http' => 503];
    }
    return ['ok' => true, 'session' => watch_party_public_view($session), 'http' => 200];
}

function watch_party_valid_id(string $id): bool
{
    $len = defined('WATCH_PARTY_ID_LENGTH') ? WATCH_PARTY_ID_LENGTH : 10;
    return (bool) preg_match('/^[a-z0-9]{' . $len . '}$/', $id);
}

/**
 * @return list<array{platform: string, channel: string}>|null
 */
function watch_party_normalize_streams(mixed $streams): ?array
{
    if (!is_array($streams)) {
        return null;
    }
    if (count($streams) > WATCH_PARTY_MAX_STREAMS) {
        return null;
    }
    $out = [];
    $seen = [];
    foreach ($streams as $item) {
        if (!is_array($item)) {
            return null;
        }
        $platform = isset($item['platform']) && is_string($item['platform'])
            ? strtolower($item['platform'])
            : '';
        $channel = isset($item['channel']) && is_string($item['channel'])
            ? $item['channel']
            : '';
        if (!in_array($platform, ['twitch', 'kick', 'youtube', 'tiktok'], true)) {
            return null;
        }
        if ($channel === '' || strlen($channel) > 128 || !preg_match('/^[a-zA-Z0-9_.:-]+$/', $channel)) {
            return null;
        }
        $key = $platform . ':' . $channel;
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $out[] = ['platform' => $platform, 'channel' => $channel];
    }
    return $out;
}

/**
 * @param array<string, mixed> $session
 * @return array<string, mixed>
 */
function watch_party_public_view(array $session): array
{
    return [
        'id' => $session['id'] ?? '',
        'status' => $session['status'] ?? 'active',
        'streams' => $session['streams'] ?? [],
        'updatedAt' => $session['updatedAt'] ?? 0,
        'createdAt' => $session['createdAt'] ?? 0,
    ];
}

/**
 * @param array<string, mixed> $session
 */
function watch_party_token_matches(array $session, string $hostToken): bool
{
    $hash = $session['hostTokenHash'] ?? '';
    if (!is_string($hash) || $hash === '' || $hostToken === '') {
        return false;
    }
    return hash_equals($hash, hash('sha256', $hostToken));
}

function watch_party_ensure_dir(): bool
{
    $dir = WATCH_PARTY_DIR;
    if (is_dir($dir)) {
        return is_writable($dir);
    }
    return @mkdir($dir, 0700, true) && is_dir($dir);
}

function watch_party_file(string $id): string
{
    return rtrim(WATCH_PARTY_DIR, '/') . '/' . $id . '.json';
}

/**
 * @return array<string, mixed>|null
 */
function watch_party_read(string $id): ?array
{
    if (!watch_party_valid_id($id)) {
        return null;
    }
    $path = watch_party_file($id);
    if (!is_file($path)) {
        return null;
    }
    $fh = @fopen($path, 'rb');
    if ($fh === false) {
        return null;
    }
    flock($fh, LOCK_SH);
    $raw = stream_get_contents($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    if (!is_string($raw) || $raw === '') {
        return null;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

/**
 * Read, dropping expired rooms so GET does not resurrect a stale file.
 *
 * @return array<string, mixed>|null
 */
function watch_party_read_fresh(string $id): ?array
{
    $session = watch_party_read($id);
    if ($session === null) {
        return null;
    }
    if (watch_party_is_expired($session)) {
        watch_party_delete($id);
        return null;
    }
    return $session;
}

/**
 * @param array<string, mixed> $session
 */
function watch_party_write(string $id, array $session): bool
{
    if (!watch_party_valid_id($id) || !watch_party_ensure_dir()) {
        return false;
    }
    $path = watch_party_file($id);
    $json = json_encode($session, JSON_UNESCAPED_SLASHES);
    if (!is_string($json)) {
        return false;
    }
    $fh = @fopen($path, 'c+b');
    if ($fh === false) {
        return false;
    }
    flock($fh, LOCK_EX);
    ftruncate($fh, 0);
    rewind($fh);
    $ok = fwrite($fh, $json) !== false;
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    return $ok;
}

function watch_party_delete(string $id): void
{
    if (!watch_party_valid_id($id)) {
        return;
    }
    $path = watch_party_file($id);
    if (is_file($path)) {
        @unlink($path);
    }
}

/**
 * @param array<string, mixed> $session
 */
function watch_party_is_expired(array $session): bool
{
    $updated = isset($session['updatedAt']) && is_int($session['updatedAt'])
        ? $session['updatedAt']
        : 0;
    $status = $session['status'] ?? 'active';
    $ttl = $status === 'ended' ? WATCH_PARTY_ENDED_TTL : WATCH_PARTY_ACTIVE_TTL;
    return $updated <= 0 || (time() - $updated) > $ttl;
}

function watch_party_new_id(): ?string
{
    for ($i = 0; $i < 8; $i++) {
        $id = substr(bin2hex(random_bytes(8)), 0, WATCH_PARTY_ID_LENGTH);
        if (!is_file(watch_party_file($id))) {
            return $id;
        }
    }
    return null;
}

function watch_party_prune(int $limit = 20): void
{
    if (!is_dir(WATCH_PARTY_DIR)) {
        return;
    }
    $files = glob(WATCH_PARTY_DIR . '/*.json');
    if (!is_array($files)) {
        return;
    }
    $checked = 0;
    foreach ($files as $file) {
        if ($checked >= $limit) {
            break;
        }
        $checked++;
        $base = basename($file, '.json');
        if (!watch_party_valid_id($base)) {
            continue;
        }
        $session = watch_party_read($base);
        if ($session === null || watch_party_is_expired($session)) {
            watch_party_delete($base);
        }
    }
}

/**
 * @param array<string, mixed> $get
 * @param array<string, mixed>|null $body
 * @return array{http: int, body: array<string, mixed>}
 */
function watch_party_handle(string $method, array $get, ?array $body): array
{
    watch_party_prune();
    $method = strtoupper($method);

    if ($method === 'GET') {
        $id = isset($get['id']) && is_string($get['id']) ? strtolower(trim($get['id'])) : '';
        $result = watch_party_get($id);
        return watch_party_result_to_response($result);
    }

    if ($method !== 'POST') {
        return ['http' => 405, 'body' => ['ok' => false, 'error' => 'method_not_allowed']];
    }

    if (!is_array($body)) {
        return ['http' => 400, 'body' => ['ok' => false, 'error' => 'invalid_input']];
    }

    $action = isset($body['action']) && is_string($body['action']) ? $body['action'] : '';
    $id = isset($body['id']) && is_string($body['id']) ? strtolower(trim($body['id'])) : '';
    $token = isset($body['hostToken']) && is_string($body['hostToken']) ? $body['hostToken'] : '';
    $streams = $body['streams'] ?? [];

    if ($action === 'create') {
        return watch_party_result_to_response(watch_party_create(is_array($streams) ? $streams : []));
    }
    if ($action === 'update') {
        return watch_party_result_to_response(watch_party_update($id, $token, is_array($streams) ? $streams : []));
    }
    if ($action === 'end') {
        return watch_party_result_to_response(watch_party_end($id, $token));
    }

    return ['http' => 400, 'body' => ['ok' => false, 'error' => 'invalid_input']];
}

/**
 * @param array{ok: bool, error?: string, http?: int, id?: string, hostToken?: string, session?: array} $result
 * @return array{http: int, body: array<string, mixed>}
 */
function watch_party_result_to_response(array $result): array
{
    $http = $result['http'] ?? ($result['ok'] ? 200 : 400);
    $body = ['ok' => $result['ok']];
    if (isset($result['error'])) {
        $body['error'] = $result['error'];
    }
    if (isset($result['id'])) {
        $body['id'] = $result['id'];
    }
    if (isset($result['hostToken'])) {
        $body['hostToken'] = $result['hostToken'];
    }
    if (isset($result['session'])) {
        $body['session'] = $result['session'];
    }
    return ['http' => $http, 'body' => $body];
}

if (!defined('WATCH_PARTY_TESTING')) {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $body = null;
    if (strtoupper((string) $method) === 'POST') {
        $raw = file_get_contents('php://input');
        $decoded = is_string($raw) ? json_decode($raw, true) : null;
        $body = is_array($decoded) ? $decoded : null;
    }
    $response = watch_party_handle((string) $method, $_GET, $body);
    http_response_code($response['http']);
    echo json_encode($response['body']);
    exit;
}
