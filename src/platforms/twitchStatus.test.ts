import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkTwitchStatus } from './twitchStatus';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkTwitchStatus — request shape', () => {
  it('returns an empty map without making a request for an empty channel list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkTwitchStatus([]);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a single batched request for the whole channel list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ platform: 'twitch', results: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await checkTwitchStatus(['a', 'b', 'c']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/twitch-status.php');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ platform: 'twitch', channels: ['a', 'b', 'c'] });
  });
});

describe('checkTwitchStatus — response parsing', () => {
  it('maps mixed-status results by normalized login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          platform: 'twitch',
          results: [
            { input: 'ChannelOne', normalized: 'channelone', status: 'live', title: 'Ranked', category: 'Valorant' },
            { input: 'channeltwo', normalized: 'channeltwo', status: 'offline', displayName: 'ChannelTwo' },
            { input: 'nope', normalized: 'nope', status: 'not_found' },
          ],
        }),
      ),
    );

    const result = await checkTwitchStatus(['ChannelOne', 'channeltwo', 'nope']);

    expect(result.get('channelone')).toMatchObject({ status: 'live', title: 'Ranked', category: 'Valorant' });
    expect(result.get('channeltwo')).toMatchObject({ status: 'offline', displayName: 'ChannelTwo' });
    expect(result.get('nope')).toMatchObject({ status: 'not_found' });
  });

  it('drops malformed individual entries but keeps the well-formed ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          platform: 'twitch',
          results: [
            { input: 'good', normalized: 'good', status: 'offline' },
            { input: 'bad', normalized: 'bad', status: 'not-a-real-status' },
            { notEvenTheRightShape: true },
          ],
        }),
      ),
    );

    const result = await checkTwitchStatus(['good', 'bad']);

    expect(result.get('good')).toMatchObject({ status: 'offline' });
    expect(result.has('bad')).toBe(false);
    expect(result.size).toBe(1);
  });
});

describe('checkTwitchStatus — failure modes never throw', () => {
  it('synthesizes an unavailable result for every channel on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    const result = await checkTwitchStatus(['a', 'b']);

    expect(result.get('a')).toEqual({ status: 'unavailable', input: 'a', normalized: 'a' });
    expect(result.get('b')).toEqual({ status: 'unavailable', input: 'b', normalized: 'b' });
  });

  it('synthesizes unavailable on a non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 500)));

    const result = await checkTwitchStatus(['a']);

    expect(result.get('a')).toMatchObject({ status: 'unavailable' });
  });

  it('synthesizes unavailable on malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      } as unknown as Response),
    );

    const result = await checkTwitchStatus(['a']);

    expect(result.get('a')).toMatchObject({ status: 'unavailable' });
  });

  it('synthesizes unavailable on a response missing the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ platform: 'twitch' })));

    const result = await checkTwitchStatus(['a']);

    expect(result.get('a')).toMatchObject({ status: 'unavailable' });
  });

  it('rethrows on deliberate abort instead of synthesizing a result', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    await expect(checkTwitchStatus(['a'], new AbortController().signal)).rejects.toThrow(
      'aborted',
    );
  });
});
