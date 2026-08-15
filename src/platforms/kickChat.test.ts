import { describe, expect, it } from 'vitest';
import {
  kickEmoteUrl,
  parseKickChatResponse,
  shouldPollKickChat,
  tokenizeKickContent,
} from './kickChat';

describe('parseKickChatResponse', () => {
  it('keeps well-formed messages and drops entries without a messageId', () => {
    const result = parseKickChatResponse(
      {
        status: 'ok',
        channel: 'deenthegreat',
        subscription: 'active',
        sendSupported: false,
        messages: [
          {
            messageId: 'm1',
            createdAt: '2026-08-15T12:00:00Z',
            content: 'hi',
            sender: { username: 'alice', color: '#FF5733', badges: [{ type: 'moderator', text: 'Moderator' }] },
            emotes: [{ emoteId: '4148074', positions: [{ s: 0, e: 4 }] }],
            repliesTo: null,
          },
          { content: 'no id' },
        ],
      },
      'fallback',
    );
    expect(result.status).toBe('ok');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].sender.username).toBe('alice');
    expect(result.messages[0].sender.color).toBe('#FF5733');
    expect(result.messages[0].sender.badges[0].type).toBe('moderator');
  });

  it('strips unsafe username colors', () => {
    const result = parseKickChatResponse(
      {
        status: 'ok',
        channel: 'x',
        subscription: 'active',
        messages: [
          {
            messageId: 'm1',
            content: 'hi',
            sender: { username: 'bob', color: 'red; background:url(x)' },
          },
        ],
      },
      'x',
    );
    expect(result.messages[0].sender.color).toBeNull();
  });
});

describe('tokenizeKickContent', () => {
  it('splits text around Kick emote placeholders', () => {
    const tokens = tokenizeKickContent('Hello [emote:4148074:HYPERCLAP] world');
    expect(tokens).toEqual([
      { type: 'text', value: 'Hello ' },
      { type: 'emote', id: '4148074', name: 'HYPERCLAP' },
      { type: 'text', value: ' world' },
    ]);
  });
});

describe('kickEmoteUrl', () => {
  it('only accepts numeric emote ids', () => {
    expect(kickEmoteUrl('4148074')).toBe('https://files.kick.com/emotes/4148074/fullsize');
    expect(kickEmoteUrl('../x')).toBeNull();
  });
});

describe('shouldPollKickChat', () => {
  it('polls only while the Kick chat panel is open and the page is visible', () => {
    expect(shouldPollKickChat({ panelVisible: true, selectedPlatform: 'kick', pageVisible: true })).toBe(true);
    expect(shouldPollKickChat({ panelVisible: true, selectedPlatform: 'twitch', pageVisible: true })).toBe(false);
    expect(shouldPollKickChat({ panelVisible: false, selectedPlatform: 'kick', pageVisible: true })).toBe(false);
    expect(shouldPollKickChat({ panelVisible: true, selectedPlatform: 'kick', pageVisible: false })).toBe(false);
  });
});
