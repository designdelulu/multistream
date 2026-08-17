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
 *        { "action": "create",    "streams": [ { "platform", "channel" }, ... ] }
 *        { "action": "update",    "id", "hostToken", "streams": [...] }
 *        { "action": "heartbeat", "id", "hostToken" }
 *        { "action": "end",       "id", "hostToken" }
 *
 * Always JSON. Host token is shown once on create and stored only as a
 * SHA-256 hash on disk. Viewer GETs never receive it.
 *
 * Persistence: one JSON file per room under
 * ~/multistream-secrets/watch-party/ (sibling of the resolver cache,
 * outside the web root). No database. Active rooms expire 7 days after
 * the last host update; ended rooms are kept 24 hours so late joiners
 * see "ended" rather than a 404.
 *
 * Host presence: hosts heartbeat every 30s while their tab is visible;
 * create/update/heartbeat all stamp hostSeenAt. An active room whose
 * hostSeenAt is older than WATCH_PARTY_HOST_IDLE_TTL (30 min) is
 * rewritten as "ended" on read, so a host who closed their laptop
 * doesn't leave viewers staring at a room that looks alive — viewers
 * get the graceful "party has ended, keep watching this lineup" flow.
 * GET exposes hostLive (hostSeenAt within ~2 min) so viewers can see
 * "Host is live" / "Host away".
 *
 * Viewer presence: viewers carry an opaque, self-generated id (&vid=)
 * and ping it at most every 30s (&hb=1, throttled client-side so the
 * 2s poll doesn't write on every request). The viewer count is returned
 * ONLY on host-token-authorized responses (update/heartbeat) — never in
 * the public GET — per the product rule that viewers don't see it.
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
if (!defined('WATCH_PARTY_HOST_IDLE_TTL')) {
    define('WATCH_PARTY_HOST_IDLE_TTL', 30 * 60);
}
if (!defined('WATCH_PARTY_HOST_LIVE_WINDOW')) {
    define('WATCH_PARTY_HOST_LIVE_WINDOW', 120);
}
if (!defined('WATCH_PARTY_VIEWER_LIVE_WINDOW')) {
    define('WATCH_PARTY_VIEWER_LIVE_WINDOW', 90);
}
if (!defined('WATCH_PARTY_MAX_VIEWERS')) {
    define('WATCH_PARTY_MAX_VIEWERS', 1000);
}
if (!defined('WATCH_PARTY_RATELIMIT_DIR')) {
    define('WATCH_PARTY_RATELIMIT_DIR', dirname(__DIR__, 2) . '/multistream-secrets/ratelimit');
}
if (!defined('WATCH_PARTY_RATE_CREATE_MAX')) {
    define('WATCH_PARTY_RATE_CREATE_MAX', 10);
}
if (!defined('WATCH_PARTY_RATE_CREATE_WINDOW')) {
    define('WATCH_PARTY_RATE_CREATE_WINDOW', 3600);
}
if (!defined('WATCH_PARTY_RATE_WRITE_MAX')) {
    define('WATCH_PARTY_RATE_WRITE_MAX', 120);
}
if (!defined('WATCH_PARTY_RATE_WRITE_WINDOW')) {
    define('WATCH_PARTY_RATE_WRITE_WINDOW', 60);
}
if (!defined('WATCH_PARTY_RATE_GET_MAX')) {
    define('WATCH_PARTY_RATE_GET_MAX', 120);
}
if (!defined('WATCH_PARTY_RATE_GET_WINDOW')) {
    define('WATCH_PARTY_RATE_GET_WINDOW', 60);
}
if (!defined('WATCH_PARTY_MAX_ROOMS')) {
    define('WATCH_PARTY_MAX_ROOMS', 200);
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
function watch_party_create(array $streams, mixed $view = null): array
{
    $normalized = watch_party_normalize_streams($streams);
    if ($normalized === null) {
        return ['ok' => false, 'error' => 'invalid_input', 'http' => 400];
    }
    $normalizedView = watch_party_normalize_view($view);
    if ($normalizedView === false) {
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
        'hostSeenAt' => $now,
    ];
    if ($normalizedView !== null) {
        $session['view'] = $normalizedView;
    }
    if (!watch_party_write($id, $session)) {
        return ['ok' => false, 'error' => 'storage_unavailable', 'http' => 503];
    }

    return [
        'ok' => true,
        'id' => $id,
        'hostToken' => $hostToken,
        'viewerCount' => 0,
        'session' => watch_party_public_view($session),
        'http' => 200,
    ];
}

/**
 * @return array{ok: bool, session?: array, error?: string, http?: int}
 */
function watch_party_get(string $id, ?string $viewerId = null): array
{
    $session = watch_party_read_fresh($id);
    if ($session === null) {
        return ['ok' => false, 'error' => 'not_found', 'http' => 404];
    }
    // Viewer presence ping: only an explicit hb=1 (throttled client-side to
    // one per 30s) writes — the plain 2s poll stays read-only. Prune first:
    // it also normalizes a missing/corrupt viewers map to an array.
    if ($viewerId !== null && ($session['status'] ?? '') === 'active') {
        watch_party_prune_viewers($session);
        $session['viewers'][$viewerId] = time();
        watch_party_write($id, $session);
    }
    return ['ok' => true, 'session' => watch_party_public_view($session), 'http' => 200];
}

function watch_party_valid_viewer_id(string $vid): bool
{
    return (bool) preg_match('/^[a-zA-Z0-9-]{8,64}$/', $vid);
}

/**
 * Drop viewers not seen within the live window, and cap the map so a
 * client rotating ids can't bloat the room file.
 *
 * @param array<string, mixed> $session
 */
function watch_party_prune_viewers(array &$session): void
{
    $viewers = isset($session['viewers']) && is_array($session['viewers']) ? $session['viewers'] : [];
    $cutoff = time() - WATCH_PARTY_VIEWER_LIVE_WINDOW;
    foreach ($viewers as $vid => $seenAt) {
        if (!is_int($seenAt) || $seenAt < $cutoff) {
            unset($viewers[$vid]);
        }
    }
    if (count($viewers) > WATCH_PARTY_MAX_VIEWERS) {
        asort($viewers);
        $viewers = array_slice($viewers, -WATCH_PARTY_MAX_VIEWERS, null, true);
    }
    $session['viewers'] = $viewers;
}

/**
 * Host-only audience size. Never included in the public view.
 *
 * @param array<string, mixed> $session
 */
function watch_party_viewer_count(array $session): int
{
    watch_party_prune_viewers($session);
    return count($session['viewers']);
}

/**
 * @return array{ok: bool, session?: array, error?: string, http?: int}
 */
function watch_party_update(string $id, string $hostToken, array $streams, mixed $view = null): array
{
    $normalized = watch_party_normalize_streams($streams);
    if ($normalized === null) {
        return ['ok' => false, 'error' => 'invalid_input', 'http' => 400];
    }
    $normalizedView = watch_party_normalize_view($view);
    if ($normalizedView === false) {
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
    // An omitted view keeps the room's existing one (older clients never
    // clobber what newer hosts set); a validated view replaces it.
    if ($normalizedView !== null) {
        $session['view'] = $normalizedView;
    }
    $session['updatedAt'] = time();
    $session['hostSeenAt'] = time();
    $viewerCount = watch_party_viewer_count($session);
    if (!watch_party_write($id, $session)) {
        return ['ok' => false, 'error' => 'storage_unavailable', 'http' => 503];
    }
    return ['ok' => true, 'viewerCount' => $viewerCount, 'session' => watch_party_public_view($session), 'http' => 200];
}

/**
 * Host presence ping: no lineup/view payload, just proves the host tab is
 * still alive (the client sends it every 30s while visible). Returns the
 * host-only viewer count alongside the public session.
 *
 * @return array{ok: bool, viewerCount?: int, session?: array, error?: string, http?: int}
 */
function watch_party_heartbeat(string $id, string $hostToken): array
{
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

    $session['hostSeenAt'] = time();
    $viewerCount = watch_party_viewer_count($session);
    if (!watch_party_write($id, $session)) {
        return ['ok' => false, 'error' => 'storage_unavailable', 'http' => 503];
    }
    return ['ok' => true, 'viewerCount' => $viewerCount, 'session' => watch_party_public_view($session), 'http' => 200];
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
 * Host spotlight (view mode + primary stream id), so viewers can follow
 * what the host is framed on. Three-state return:
 *   null  — the client didn't send a view (older clients): leave as-is.
 *   false — a view was sent but is malformed: reject the whole payload,
 *           same rule as a malformed stream entry.
 *   array — validated ['mode' => 'grid'|'theater'|'focus', 'primary' => ?string].
 *
 * @return array{mode: string, primary: ?string, chatVisible?: bool}|false|null
 */
function watch_party_normalize_view(mixed $view): array|false|null
{
    if ($view === null) {
        return null;
    }
    if (!is_array($view)) {
        return false;
    }
    $mode = isset($view['mode']) && is_string($view['mode']) ? $view['mode'] : '';
    if (!in_array($mode, ['grid', 'theater', 'focus'], true)) {
        return false;
    }
    $primary = $view['primary'] ?? null;
    if ($primary !== null && $primary !== '') {
        // A stream id is "platform:channel" — the same charset the channel
        // validator already enforces, plus the colon.
        if (!is_string($primary) || strlen($primary) > 256 || !preg_match('/^[a-zA-Z0-9_.:-]+$/', $primary)) {
            return false;
        }
    } else {
        $primary = null;
    }
    $normalized = ['mode' => $mode, 'primary' => $primary];
    if (array_key_exists('chatVisible', $view)) {
        if (!is_bool($view['chatVisible'])) {
            return false;
        }
        $normalized['chatVisible'] = $view['chatVisible'];
    }
    return $normalized;
}

/**
 * Per-stream orientation ('landscape'|'portrait') is optional — absent means
 * the viewer derives it from the platform (see WatchPartyStream's doc
 * comment in src/lib/watchParty.ts). Present-but-invalid rejects the whole
 * payload, same as any other malformed field.
 *
 * @return list<array{platform: string, channel: string, orientation?: string}>|null
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
        $orientation = isset($item['orientation']) && is_string($item['orientation'])
            ? strtolower($item['orientation'])
            : null;
        if ($orientation !== null && !in_array($orientation, ['landscape', 'portrait'], true)) {
            return null;
        }
        $key = $platform . ':' . $channel;
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $entry = ['platform' => $platform, 'channel' => $channel];
        if ($orientation !== null) {
            $entry['orientation'] = $orientation;
        }
        $out[] = $entry;
    }
    return $out;
}

/**
 * @param array<string, mixed> $session
 * @return array<string, mixed>
 */
function watch_party_public_view(array $session): array
{
    $status = $session['status'] ?? 'active';
    $public = [
        'id' => $session['id'] ?? '',
        'status' => $status,
        'streams' => $session['streams'] ?? [],
        'updatedAt' => $session['updatedAt'] ?? 0,
        'createdAt' => $session['createdAt'] ?? 0,
        'hostLive' => watch_party_host_live($session),
    ];
    // Host spotlight is not a secret — viewers are meant to follow it.
    if (isset($session['view']) && is_array($session['view'])) {
        $public['view'] = $session['view'];
    }
    return $public;
}

/**
 * @param array<string, mixed> $session
 */
function watch_party_host_live(array $session): bool
{
    if (($session['status'] ?? 'active') !== 'active') {
        return false;
    }
    $seen = isset($session['hostSeenAt']) && is_int($session['hostSeenAt'])
        ? $session['hostSeenAt']
        : 0;
    return $seen > 0 && (time() - $seen) <= WATCH_PARTY_HOST_LIVE_WINDOW;
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
 * An active room whose host has been idle past WATCH_PARTY_HOST_IDLE_TTL
 * is rewritten as "ended" (keeping the lineup, so viewers keep watching)
 * rather than deleted — they get the graceful ended flow, and the file
 * then lives out the usual 24h ended TTL from the moment it ended.
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
    if (watch_party_is_host_idle($session)) {
        $session['status'] = 'ended';
        $session['updatedAt'] = time();
        watch_party_write($id, $session);
    }
    return $session;
}

/**
 * Idle = active room with no host activity (heartbeat/update) within the
 * idle TTL. Pre-presence room files have no hostSeenAt; their updatedAt
 * (last host push) stands in so they aren't instantly ended on deploy.
 *
 * @param array<string, mixed> $session
 */
function watch_party_is_host_idle(array $session): bool
{
    if (($session['status'] ?? 'active') !== 'active') {
        return false;
    }
    $seen = isset($session['hostSeenAt']) && is_int($session['hostSeenAt'])
        ? $session['hostSeenAt']
        : (isset($session['updatedAt']) && is_int($session['updatedAt']) ? $session['updatedAt'] : 0);
    return $seen <= 0 || (time() - $seen) > WATCH_PARTY_HOST_IDLE_TTL;
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

/**
 * Fixed-window per-IP counter (one file per bucket+IP, same pattern as
 * tiktok-resolve.php). Fails open if the ratelimit dir is unavailable —
 * a storage hiccup must not take the party endpoint down with it.
 */
function watch_party_rate_limited(string $bucket, int $max, int $window): bool
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $dir = WATCH_PARTY_RATELIMIT_DIR;
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        return false;
    }
    $path = rtrim($dir, '/') . '/' . $bucket . '-' . hash('sha256', $ip) . '.json';
    $now = time();
    $raw = @file_get_contents($path);
    $state = $raw !== false ? json_decode($raw, true) : null;
    if (!is_array($state) || !isset($state['windowStart'], $state['count']) || ($now - $state['windowStart']) >= $window) {
        $state = ['windowStart' => $now, 'count' => 0];
    }
    $state['count']++;
    @file_put_contents($path, json_encode($state), LOCK_EX);
    return $state['count'] > $max;
}

/** Active (non-expired) rooms — the hard-cap metric for create. */
function watch_party_active_room_count(): int
{
    $files = glob(rtrim(WATCH_PARTY_DIR, '/') . '/*.json');
    if (!is_array($files)) {
        return 0;
    }
    $count = 0;
    foreach ($files as $file) {
        $base = basename($file, '.json');
        if (!watch_party_valid_id($base)) {
            continue;
        }
        $session = watch_party_read($base);
        if ($session === null) {
            continue;
        }
        if (($session['status'] ?? 'active') === 'active' && !watch_party_is_expired($session)) {
            $count++;
        }
    }
    return $count;
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
        // 2s viewer polls + heartbeating hosts share this budget: 120/min
        // leaves a polling tab (~30/min) four tabs of headroom.
        if (watch_party_rate_limited('get', WATCH_PARTY_RATE_GET_MAX, WATCH_PARTY_RATE_GET_WINDOW)) {
            return ['http' => 429, 'body' => ['ok' => false, 'error' => 'rate_limited']];
        }
        $id = isset($get['id']) && is_string($get['id']) ? strtolower(trim($get['id'])) : '';
        $vid = isset($get['vid']) && is_string($get['vid']) ? trim($get['vid']) : '';
        $wantsPing = ($get['hb'] ?? '') === '1';
        $viewerId = $wantsPing && watch_party_valid_viewer_id($vid) ? $vid : null;
        $result = watch_party_get($id, $viewerId);
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
    $view = $body['view'] ?? null;

    if ($action === 'create') {
        // The largest abuse surface: unauthenticated room creation. Per-IP
        // hourly budget first, then the server-wide active-room cap.
        if (watch_party_rate_limited('create', WATCH_PARTY_RATE_CREATE_MAX, WATCH_PARTY_RATE_CREATE_WINDOW)) {
            return ['http' => 429, 'body' => ['ok' => false, 'error' => 'rate_limited']];
        }
        if (watch_party_active_room_count() >= WATCH_PARTY_MAX_ROOMS) {
            return ['http' => 503, 'body' => ['ok' => false, 'error' => 'busy']];
        }
        return watch_party_result_to_response(watch_party_create(is_array($streams) ? $streams : [], $view));
    }
    if ($action === 'update' || $action === 'heartbeat' || $action === 'end') {
        if (watch_party_rate_limited('write', WATCH_PARTY_RATE_WRITE_MAX, WATCH_PARTY_RATE_WRITE_WINDOW)) {
            return ['http' => 429, 'body' => ['ok' => false, 'error' => 'rate_limited']];
        }
    }
    if ($action === 'update') {
        return watch_party_result_to_response(watch_party_update($id, $token, is_array($streams) ? $streams : [], $view));
    }
    if ($action === 'heartbeat') {
        return watch_party_result_to_response(watch_party_heartbeat($id, $token));
    }
    if ($action === 'end') {
        return watch_party_result_to_response(watch_party_end($id, $token));
    }

    return ['http' => 400, 'body' => ['ok' => false, 'error' => 'invalid_input']];
}

/**
 * @param array{ok: bool, error?: string, http?: int, id?: string, hostToken?: string, viewerCount?: int, session?: array} $result
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
    if (isset($result['viewerCount'])) {
        $body['viewerCount'] = $result['viewerCount'];
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
