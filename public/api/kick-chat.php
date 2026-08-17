<?php
/**
 * Same-origin Kick chat poll endpoint for MultiStream.cc.
 *
 * GET /api/kick-chat.php?channel=slug&after=<message_id>
 *
 * Ensures an app-level chat.message.sent webhook subscription exists for
 * the resolved broadcaster, then returns only messages after `after` from
 * the rolling per-channel buffer. There is no official Kick chat history
 * GET — an empty list on first poll is expected ("waiting for new messages").
 *
 * Abuse guards: GETs are per-IP throttled, and subscription attempts are
 * globally capped per day with per-broadcaster failure backoff (see
 * kick_ensure_chat_subscription). Over-cap requests still get the chat
 * buffer, just with subscription: "unavailable" — never an error.
 *
 * Writing chat (POST /public/v1/chat) is not exposed here: that requires a
 * user or bot OAuth token, not the existing App Access Token.
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

function kick_chat_respond(array $body): void
{
    echo json_encode($body);
    exit;
}

if (!defined('KICK_CHAT_TESTING')) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        http_response_code(405);
        kick_chat_respond(['status' => 'error', 'code' => 'invalid_input', 'message' => 'Only GET is supported.']);
    }

    if (!kick_is_configured()) {
        kick_chat_respond([
            'status' => 'error',
            'code' => 'not_configured',
            'channel' => '',
            'messages' => [],
        ]);
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    if (kick_chat_rate_limited($ip)) {
        http_response_code(429);
        kick_chat_respond([
            'status' => 'error',
            'code' => 'rate_limited',
            'message' => 'Too many requests — try again shortly.',
            'messages' => [],
        ]);
    }

    $channel = isset($_GET['channel']) && is_string($_GET['channel']) ? $_GET['channel'] : '';
    $slug = kick_normalize_slug($channel);
    if ($slug === '' || !kick_is_valid_slug($slug)) {
        http_response_code(400);
        kick_chat_respond(['status' => 'error', 'code' => 'invalid_input', 'messages' => []]);
    }

    $after = isset($_GET['after']) && is_string($_GET['after']) ? trim($_GET['after']) : '';

    $errorCode = null;
    $broadcasterId = kick_chat_resolve_broadcaster_id($slug, $errorCode);
    if ($broadcasterId === null) {
        kick_chat_respond([
            'status' => 'error',
            'code' => $errorCode ?? 'not_found',
            'channel' => $slug,
            'subscription' => 'unavailable',
            'messages' => [],
        ]);
    }

    $sub = kick_ensure_chat_subscription($broadcasterId);
    kick_chat_prune_inactive_buffers();
    $messages = kick_chat_messages_after($slug, $after !== '' ? $after : null);

    kick_chat_respond([
        'status' => 'ok',
        'channel' => $slug,
        'subscription' => $sub['ok'] ? ($sub['reused'] ? 'active' : 'created') : 'unavailable',
        'subscriptionError' => $sub['ok'] ? null : $sub['error'],
        'messages' => $messages,
        'sendSupported' => false,
    ]);
}
