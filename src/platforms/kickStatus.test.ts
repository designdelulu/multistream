import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkKickStatus } from './kickStatus';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkKickStatus', () => {
  it('sends one batched POST for the whole channel list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ platform: 'kick', results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await checkKickStatus(['a', 'b', 'c']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/kick-status.php');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ platform: 'kick', channels: ['a', 'b', 'c'] });
  });

  it('makes no request at all for an empty list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkKickStatus([]);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keys results by normalized slug and preserves the live metadata fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          platform: 'kick',
          results: [
            {
              input: 'DeenTheGreat',
              normalized: 'deenthegreat',
              status: 'live',
              displayName: 'deenthegreat',
              viewerCount: 8200,
              startedAt: '2026-08-14T05:12:00Z',
              category: 'Just Chatting',
              avatarUrl: 'https://files.kick.com/deen.webp',
            },
          ],
        }),
      ),
    );

    const result = await checkKickStatus(['DeenTheGreat']);
    const entry = result.get('deenthegreat');

    expect(entry?.status).toBe('live');
    expect(entry).toMatchObject({
      viewerCount: 8200,
      startedAt: '2026-08-14T05:12:00Z',
      avatarUrl: 'https://files.kick.com/deen.webp',
    });
  });

  it('passes not_configured straight through as its own distinct status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          platform: 'kick',
          results: [{ input: 'a', normalized: 'a', status: 'not_configured' }],
        }),
      ),
    );

    const result = await checkKickStatus(['a']);

    expect(result.get('a')?.status).toBe('not_configured');
  });

  it('maps a network error to unavailable for every requested channel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const result = await checkKickStatus(['a', 'b']);

    expect([...result.values()].map((entry) => entry.status)).toEqual(['unavailable', 'unavailable']);
  });

  it('maps a non-OK response to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false)));

    const result = await checkKickStatus(['a']);

    expect(result.get('a')?.status).toBe('unavailable');
  });

  it('maps a wrong-platform payload to unavailable rather than trusting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ platform: 'twitch', results: [] })),
    );

    const result = await checkKickStatus(['a']);

    expect(result.get('a')?.status).toBe('unavailable');
  });

  it('drops malformed result entries instead of surfacing them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          platform: 'kick',
          results: [
            { input: 'a', normalized: 'a', status: 'nonsense' },
            { input: 'b', normalized: 'b', status: 'offline' },
          ],
        }),
      ),
    );

    const result = await checkKickStatus(['a', 'b']);

    expect(result.has('a')).toBe(false);
    expect(result.get('b')?.status).toBe('offline');
  });

  it('rethrows an abort so callers can distinguish cancellation from failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    );

    await expect(checkKickStatus(['a'])).rejects.toThrow('aborted');
  });
});
