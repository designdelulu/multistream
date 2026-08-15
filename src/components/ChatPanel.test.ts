import { describe, expect, it } from 'vitest';
import { renderKickChatMessage } from './ChatPanel';
import type { KickChatMessage } from '../platforms/kickChat';

function message(overrides: Partial<KickChatMessage> = {}): KickChatMessage {
  return {
    messageId: 'm1',
    createdAt: '2026-08-15T12:00:00Z',
    content: 'Hello [emote:4148074:HYPERCLAP] world',
    sender: {
      username: 'viewer1',
      color: '#FF5733',
      profilePicture: null,
      badges: [{ type: 'moderator', text: 'Moderator' }],
    },
    emotes: [{ emoteId: '4148074', positions: [{ s: 6, e: 30 }] }],
    repliesTo: { messageId: 'parent', content: 'hi there', username: 'alice' },
    ...overrides,
  };
}

describe('renderKickChatMessage', () => {
  it('renders username, color, badge, emote, reply, and text without using innerHTML for user content', () => {
    const row = renderKickChatMessage(message());
    expect(row.dataset.messageId).toBe('m1');
    const user = row.querySelector('.chat-panel__kick-user') as HTMLElement;
    expect(user.textContent).toBe('viewer1');
    expect(user.style.color.toLowerCase()).toMatch(/#ff5733|rgb\(255,\s*87,\s*51\)/);
    expect(row.querySelector('.chat-panel__kick-badge')?.textContent).toBe('Moderator');
    expect(row.querySelector('.chat-panel__kick-reply')?.textContent).toContain('alice');
    const emote = row.querySelector<HTMLImageElement>('.chat-panel__kick-emote');
    expect(emote?.alt).toBe('HYPERCLAP');
    expect(emote?.src).toContain('/emotes/4148074/fullsize');
    expect(row.textContent).toContain('Hello');
    expect(row.textContent).toContain('world');
  });
});
