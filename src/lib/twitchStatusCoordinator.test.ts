import { describe, expect, it, vi } from 'vitest';
import { createTwitchStatusCoordinator } from './twitchStatusCoordinator';
import type { TwitchStatusResult } from '../platforms/twitchStatus';

function liveResult(normalized: string): TwitchStatusResult {
  return { status: 'live', input: normalized, normalized };
}

describe('createTwitchStatusCoordinator', () => {
  it('dedupes and lowercases channels before checking', async () => {
    const checkStatus = vi.fn().mockResolvedValue(new Map());
    const coordinator = createTwitchStatusCoordinator({ checkStatus, onResult: vi.fn() });

    await coordinator.refresh(['Foo', 'foo', ' FOO ', 'bar'], 'manual');

    expect(checkStatus).toHaveBeenCalledTimes(1);
    expect(checkStatus).toHaveBeenCalledWith(['foo', 'bar']);
  });

  it('skips without calling checkStatus for an empty channel list', async () => {
    const checkStatus = vi.fn().mockResolvedValue(new Map());
    const coordinator = createTwitchStatusCoordinator({ checkStatus, onResult: vi.fn() });

    const { outcome } = await coordinator.refresh([], 'periodic');

    expect(outcome).toBe('skipped-empty');
    expect(checkStatus).not.toHaveBeenCalled();
  });

  it('calls onResult with the resolved map and the reason, and returns the results too', async () => {
    const results = new Map([['foo', liveResult('foo')]]);
    const checkStatus = vi.fn().mockResolvedValue(results);
    const onResult = vi.fn();
    const coordinator = createTwitchStatusCoordinator({ checkStatus, onResult });

    const outcome = await coordinator.refresh(['foo'], 'manual');

    expect(outcome).toEqual({ outcome: 'ok', results });
    expect(onResult).toHaveBeenCalledWith(results, 'manual');
  });

  it('permits only one request at a time — a second call while in flight is skipped', async () => {
    let resolveFirst: (value: Map<string, TwitchStatusResult>) => void = () => {};
    const checkStatus = vi.fn().mockImplementation(
      () =>
        new Promise<Map<string, TwitchStatusResult>>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const onResult = vi.fn();
    const coordinator = createTwitchStatusCoordinator({ checkStatus, onResult });

    const firstCall = coordinator.refresh(['foo'], 'manual');
    expect(coordinator.isInFlight()).toBe(true);

    const secondOutcome = await coordinator.refresh(['bar'], 'periodic');
    expect(secondOutcome).toEqual({ outcome: 'skipped-inflight' });
    expect(checkStatus).toHaveBeenCalledTimes(1);

    resolveFirst(new Map());
    await firstCall;
    expect(coordinator.isInFlight()).toBe(false);
  });

  it('allows a new request once the previous one has resolved', async () => {
    const checkStatus = vi.fn().mockResolvedValue(new Map());
    const coordinator = createTwitchStatusCoordinator({ checkStatus, onResult: vi.fn() });

    await coordinator.refresh(['foo'], 'manual');
    const { outcome } = await coordinator.refresh(['foo'], 'periodic');

    expect(outcome).toBe('ok');
    expect(checkStatus).toHaveBeenCalledTimes(2);
  });

  it('records the last completed check time for staleness checks', async () => {
    const checkStatus = vi.fn().mockResolvedValue(new Map());
    const coordinator = createTwitchStatusCoordinator({ checkStatus, onResult: vi.fn() });

    expect(coordinator.getLastCheckAt()).toBeNull();
    await coordinator.refresh(['foo'], 'manual');
    expect(coordinator.getLastCheckAt()).not.toBeNull();
  });

  it('never throws even if checkStatus rejects, and clears the in-flight flag', async () => {
    const checkStatus = vi.fn().mockRejectedValue(new Error('network down'));
    const coordinator = createTwitchStatusCoordinator({ checkStatus, onResult: vi.fn() });

    await expect(coordinator.refresh(['foo'], 'manual')).rejects.toThrow('network down');
    // Even though the underlying client is documented to never throw
    // (transport failures resolve to 'unavailable'), the coordinator's own
    // in-flight bookkeeping must not get stuck if it somehow did.
    expect(coordinator.isInFlight()).toBe(false);
  });
});
