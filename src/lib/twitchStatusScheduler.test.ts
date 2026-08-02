import { describe, expect, it, vi } from 'vitest';
import { createTwitchStatusScheduler } from './twitchStatusScheduler';
import type { TwitchStatusSchedulerRunOutcome } from './twitchStatusScheduler';

/** Fake setInterval/clearInterval: captures the latest callback per handle so tests can fire ticks manually. */
function createFakeIntervalRegistry() {
  const handlers = new Map<number, () => void>();
  let nextHandle = 1;

  return {
    setInterval: vi.fn((handler: () => void) => {
      const handle = nextHandle++;
      handlers.set(handle, handler);
      return handle;
    }),
    clearInterval: vi.fn((handle: number) => {
      handlers.delete(handle);
    }),
    fireLatest(): void {
      const latest = [...handlers.values()].at(-1);
      latest?.();
    },
    activeCount(): number {
      return handlers.size;
    },
  };
}

function buildScheduler(overrides: {
  hasTwitchCards?: () => boolean;
  isHidden?: () => boolean;
  isOnline?: () => boolean;
  run?: (reason: 'periodic' | 'visibility-resume') => Promise<TwitchStatusSchedulerRunOutcome>;
  registry?: ReturnType<typeof createFakeIntervalRegistry>;
  now?: () => number;
} = {}) {
  const registry = overrides.registry ?? createFakeIntervalRegistry();
  let now = 0;
  const run = vi.fn(overrides.run ?? (async () => 'ok' as const));

  const scheduler = createTwitchStatusScheduler({
    intervalMs: 1000,
    hasTwitchCards: overrides.hasTwitchCards ?? (() => true),
    isHidden: overrides.isHidden ?? (() => false),
    isOnline: overrides.isOnline ?? (() => true),
    run,
    now: overrides.now ?? (() => now),
    setInterval: registry.setInterval,
    clearInterval: registry.clearInterval,
  });

  return { scheduler, registry, run, advance: (ms: number) => (now += ms) };
}

describe('createTwitchStatusScheduler', () => {
  it('does not arm an interval until start() is called', () => {
    const { registry } = buildScheduler();
    expect(registry.activeCount()).toBe(0);
  });

  it('arms exactly one interval on start()', () => {
    const { scheduler, registry } = buildScheduler();
    scheduler.start();
    expect(registry.setInterval).toHaveBeenCalledTimes(1);
    expect(scheduler.isRunning()).toBe(true);
  });

  it('start() is idempotent — calling twice does not arm a second interval', () => {
    const { scheduler, registry } = buildScheduler();
    scheduler.start();
    scheduler.start();
    expect(registry.setInterval).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the interval and is safe to call when not running', () => {
    const { scheduler, registry } = buildScheduler();
    scheduler.start();
    scheduler.stop();
    expect(registry.activeCount()).toBe(0);
    expect(scheduler.isRunning()).toBe(false);
    scheduler.stop();
  });

  it('a tick calls run("periodic") when visible, online, and Twitch cards exist', async () => {
    const { scheduler, registry, run } = buildScheduler();
    scheduler.start();
    registry.fireLatest();
    await Promise.resolve();
    expect(run).toHaveBeenCalledWith('periodic');
  });

  it('a tick is skipped while the tab is hidden', async () => {
    const { scheduler, registry, run } = buildScheduler({ isHidden: () => true });
    scheduler.start();
    registry.fireLatest();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it('a tick is skipped while offline', async () => {
    const { scheduler, registry, run } = buildScheduler({ isOnline: () => false });
    scheduler.start();
    registry.fireLatest();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it('a tick is skipped when no Twitch cards exist', async () => {
    const { scheduler, registry, run } = buildScheduler({ hasTwitchCards: () => false });
    scheduler.start();
    registry.fireLatest();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it('a tick that overlaps an in-flight request just reflects the "skipped-inflight" outcome without erroring', async () => {
    const run = vi.fn().mockResolvedValue('skipped-inflight' as const);
    const { scheduler, registry } = buildScheduler({ run });
    scheduler.start();
    registry.fireLatest();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('notifyManualRefresh resets the interval clock so a tick does not fire immediately after', () => {
    const { scheduler, registry } = buildScheduler();
    scheduler.start();
    expect(registry.setInterval).toHaveBeenCalledTimes(1);

    scheduler.notifyManualRefresh();

    expect(registry.clearInterval).toHaveBeenCalledTimes(1);
    expect(registry.setInterval).toHaveBeenCalledTimes(2);
    expect(registry.activeCount()).toBe(1);
  });

  it('notifyManualRefresh before start() has ever run does not arm an interval', () => {
    const { scheduler, registry } = buildScheduler();
    scheduler.notifyManualRefresh();
    expect(registry.setInterval).not.toHaveBeenCalled();
  });

  it('notifyVisible refreshes once when the previous check is older than the interval', async () => {
    const { scheduler, run, advance } = buildScheduler();
    scheduler.start();
    advance(5000);
    scheduler.notifyVisible();
    await Promise.resolve();
    expect(run).toHaveBeenCalledWith('visibility-resume');
  });

  it('notifyVisible does nothing if the previous check is still fresh', async () => {
    const { scheduler, registry, run, advance } = buildScheduler();
    scheduler.start();
    registry.fireLatest(); // establishes lastRunAt via a normal periodic tick
    await Promise.resolve();
    run.mockClear();

    advance(10); // well under the 1000ms interval
    scheduler.notifyVisible();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it('notifyVisible does nothing while hidden or offline, even if stale', async () => {
    const { scheduler, run, advance } = buildScheduler({ isHidden: () => true });
    scheduler.start();
    advance(5000);
    scheduler.notifyVisible();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it('stopping the scheduler after the last Twitch card is removed leaves no armed interval', () => {
    const { scheduler, registry } = buildScheduler();
    scheduler.start();
    expect(registry.activeCount()).toBe(1);
    scheduler.stop();
    expect(registry.activeCount()).toBe(0);
  });
});
