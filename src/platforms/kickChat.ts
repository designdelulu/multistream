/**
 * Client for the same-origin Kick chat poll endpoint (public/api/kick-chat.php).
 *
 * Official Kick chat is push-via-webhook, not a history GET — the first poll
 * after a subscription is established is expected to be empty. Sending a
 * message (POST /public/v1/chat) needs a user or bot OAuth token and is
 * deliberately not wired here; `sendSupported` stays false until that work.
 */

export interface KickChatBadge {
  type: string;
  text: string;
  count?: number;
}

export interface KickChatSender {
  username: string;
  color: string | null;
  profilePicture: string | null;
  badges: KickChatBadge[];
}

export interface KickChatReply {
  messageId: string;
  content: string;
  username: string;
}

export interface KickChatEmote {
  emoteId: string;
  positions: { s: number; e: number }[];
}

export interface KickChatMessage {
  messageId: string;
  createdAt: string;
  content: string;
  sender: KickChatSender;
  emotes: KickChatEmote[];
  repliesTo: KickChatReply | null;
}

export type KickChatSubscriptionState = 'active' | 'created' | 'unavailable';

export interface KickChatPollResult {
  status: 'ok' | 'error';
  channel: string;
  subscription: KickChatSubscriptionState;
  messages: KickChatMessage[];
  sendSupported: boolean;
}

const CHAT_ENDPOINT = '/api/kick-chat.php';
const EMOTE_ID_PATTERN = /^[0-9]+$/;
const COLOR_PATTERN = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const EMOTE_TOKEN = /\[emote:(\d+):([^\]]+)\]/g;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseBadges(value: unknown): KickChatBadge[] {
  if (!Array.isArray(value)) return [];
  const badges: KickChatBadge[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const text = asString((entry as { text?: unknown }).text);
    const type = asString((entry as { type?: unknown }).type);
    if (!text && !type) continue;
    const badge: KickChatBadge = { type, text: text || type };
    const count = (entry as { count?: unknown }).count;
    if (typeof count === 'number' && Number.isFinite(count)) badge.count = count;
    badges.push(badge);
  }
  return badges;
}

function parseEmotes(value: unknown): KickChatEmote[] {
  if (!Array.isArray(value)) return [];
  const emotes: KickChatEmote[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const emoteId = asString((entry as { emoteId?: unknown }).emoteId);
    if (!EMOTE_ID_PATTERN.test(emoteId)) continue;
    const positionsIn = (entry as { positions?: unknown }).positions;
    const positions: { s: number; e: number }[] = [];
    if (Array.isArray(positionsIn)) {
      for (const pos of positionsIn) {
        if (!pos || typeof pos !== 'object') continue;
        positions.push({
          s: Number((pos as { s?: unknown }).s) || 0,
          e: Number((pos as { e?: unknown }).e) || 0,
        });
      }
    }
    emotes.push({ emoteId, positions });
  }
  return emotes;
}

function parseMessage(value: unknown): KickChatMessage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const messageId = asString(raw.messageId);
  if (!messageId) return null;
  const senderRaw = raw.sender && typeof raw.sender === 'object' ? (raw.sender as Record<string, unknown>) : {};
  const colorRaw = asString(senderRaw.color);
  const repliesRaw =
    raw.repliesTo && typeof raw.repliesTo === 'object' ? (raw.repliesTo as Record<string, unknown>) : null;
  return {
    messageId,
    createdAt: asString(raw.createdAt),
    content: asString(raw.content),
    sender: {
      username: asString(senderRaw.username) || 'unknown',
      color: COLOR_PATTERN.test(colorRaw) ? colorRaw : null,
      profilePicture: asString(senderRaw.profilePicture) || null,
      badges: parseBadges(senderRaw.badges),
    },
    emotes: parseEmotes(raw.emotes),
    repliesTo: repliesRaw
      ? {
          messageId: asString(repliesRaw.messageId),
          content: asString(repliesRaw.content),
          username: asString(repliesRaw.username),
        }
      : null,
  };
}

export function parseKickChatResponse(data: unknown, fallbackChannel: string): KickChatPollResult {
  if (!data || typeof data !== 'object') {
    return {
      status: 'error',
      channel: fallbackChannel,
      subscription: 'unavailable',
      messages: [],
      sendSupported: false,
    };
  }
  const raw = data as Record<string, unknown>;
  const messages: KickChatMessage[] = [];
  if (Array.isArray(raw.messages)) {
    for (const entry of raw.messages) {
      const parsed = parseMessage(entry);
      if (parsed) messages.push(parsed);
    }
  }
  const subscription =
    raw.subscription === 'active' || raw.subscription === 'created' || raw.subscription === 'unavailable'
      ? raw.subscription
      : 'unavailable';
  return {
    status: raw.status === 'ok' ? 'ok' : 'error',
    channel: asString(raw.channel) || fallbackChannel,
    subscription,
    messages,
    sendSupported: raw.sendSupported === true,
  };
}

export async function fetchKickChat(
  channel: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<KickChatPollResult> {
  const params = new URLSearchParams({ channel });
  if (after) params.set('after', after);
  try {
    const response = await fetch(`${CHAT_ENDPOINT}?${params.toString()}`, { signal });
    const data: unknown = await response.json();
    return parseKickChatResponse(data, channel);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return {
      status: 'error',
      channel,
      subscription: 'unavailable',
      messages: [],
      sendSupported: false,
    };
  }
}

export function kickEmoteUrl(emoteId: string): string | null {
  if (!EMOTE_ID_PATTERN.test(emoteId)) return null;
  return `https://files.kick.com/emotes/${emoteId}/fullsize`;
}

/**
 * Splits Kick content into text and emote tokens. Uses the `[emote:id:name]`
 * placeholders Kick puts in `content`; the parallel `emotes[]` metadata is
 * kept on the message for later use but is not required to render.
 */
export function tokenizeKickContent(content: string): Array<{ type: 'text'; value: string } | { type: 'emote'; id: string; name: string }> {
  const tokens: Array<{ type: 'text'; value: string } | { type: 'emote'; id: string; name: string }> = [];
  let last = 0;
  EMOTE_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null = EMOTE_TOKEN.exec(content);
  while (match) {
    if (match.index > last) {
      tokens.push({ type: 'text', value: content.slice(last, match.index) });
    }
    tokens.push({ type: 'emote', id: match[1], name: match[2] });
    last = match.index + match[0].length;
    match = EMOTE_TOKEN.exec(content);
  }
  if (last < content.length) {
    tokens.push({ type: 'text', value: content.slice(last) });
  }
  return tokens;
}

export function shouldPollKickChat(options: {
  panelVisible: boolean;
  selectedPlatform: string | null;
  pageVisible: boolean;
}): boolean {
  return options.panelVisible && options.selectedPlatform === 'kick' && options.pageVisible;
}

/** Reserved for a later OAuth/user-token send path. Always false today. */
export const KICK_CHAT_SEND_SUPPORTED = false;
