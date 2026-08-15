<?php
/**
 * Kick Events webhook receiver for MultiStream.cc.
 *
 * Production URL (enter this in Kick Developer → Enable Webhooks):
 *   https://multistream.cc/api/kick-webhook.php
 *
 * Verifies Kick-Event-Signature against Kick's documented public key
 * (https://docs.kick.com/events/webhook-security), then dispatches
 * chat.message.sent into the per-channel rolling chat buffer. Other event
 * types are accepted (HTTP 200) so Kick does not disable delivery, and can
 * be handled later without changing this endpoint's contract.
 *
 * GET returns a tiny health JSON so the URL can be checked in a browser.
 * Kick itself only POSTs.
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

if (!defined('KICK_STATUS_TESTING')) {
    define('KICK_STATUS_TESTING', true);
}
require_once __DIR__ . '/kick-status.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function kick_webhook_respond(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body);
    exit;
}

if (!defined('KICK_WEBHOOK_TESTING')) {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET') {
        kick_webhook_respond(200, ['status' => 'ok', 'endpoint' => 'kick-webhook']);
    }

    if ($method !== 'POST') {
        kick_webhook_respond(405, ['status' => 'error', 'code' => 'invalid_input', 'message' => 'Only POST is supported.']);
    }

    $raw = file_get_contents('php://input');
    if ($raw === false) {
        kick_webhook_respond(400, ['status' => 'error', 'code' => 'invalid_input']);
    }
    if (strlen($raw) > 256 * 1024) {
        kick_webhook_respond(413, ['status' => 'error', 'code' => 'invalid_input']);
    }

    $messageId = kick_webhook_header('Kick-Event-Message-Id');
    $timestamp = kick_webhook_header('Kick-Event-Message-Timestamp');
    $signature = kick_webhook_header('Kick-Event-Signature');
    $eventType = kick_webhook_header('Kick-Event-Type');
    $eventVersion = kick_webhook_header('Kick-Event-Version');

    if ($messageId === '' || $timestamp === '' || $signature === '' || $eventType === '') {
        kick_webhook_respond(400, ['status' => 'error', 'code' => 'invalid_input']);
    }

    if (!kick_webhook_timestamp_fresh($timestamp)) {
        kick_webhook_respond(401, ['status' => 'error', 'code' => 'stale_timestamp']);
    }

    $publicKey = kick_get_webhook_public_key();
    if (!kick_verify_webhook_signature($messageId, $timestamp, $raw, $signature, $publicKey)) {
        error_log('kick-webhook: signature verification failed for event ' . $eventType);
        kick_webhook_respond(401, ['status' => 'error', 'code' => 'invalid_signature']);
    }

    $dedupeKey = 'kick:webhook-msg:' . $messageId;
    if (kick_cache_get($dedupeKey) !== null) {
        kick_webhook_respond(200, ['status' => 'ok', 'duplicate' => true]);
    }
    kick_cache_set($dedupeKey, 1, 24 * 60 * 60);

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        kick_webhook_respond(400, ['status' => 'error', 'code' => 'invalid_input']);
    }

    $ok = kick_handle_webhook_event($eventType, $eventVersion, $decoded);
    if (!$ok) {
        kick_webhook_respond(400, ['status' => 'error', 'code' => 'unsupported_event']);
    }

    kick_webhook_respond(200, ['status' => 'ok']);
}
