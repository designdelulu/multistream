interface ScreenWakeLockSentinel {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void, options?: AddEventListenerOptions): void;
}

interface WakeLockNavigator {
  wakeLock?: {
    request(type: 'screen'): Promise<ScreenWakeLockSentinel>;
  };
}

/**
 * Keeps a screen wake lock aligned with application state. The returned
 * sync function is safe to call after any lineup/device change; visibility
 * changes are handled internally so iPadOS can reacquire after tab return.
 */
export function bindScreenWakeLock(
  shouldHold: () => boolean,
  nav: WakeLockNavigator = navigator as WakeLockNavigator,
  doc: Document = document,
): { sync(): void; destroy(): void } {
  let sentinel: ScreenWakeLockSentinel | null = null;
  let requestGeneration = 0;
  let destroyed = false;

  const eligible = (): boolean =>
    !destroyed && shouldHold() && doc.visibilityState === 'visible' && Boolean(nav.wakeLock);

  const release = (): void => {
    requestGeneration += 1;
    const current = sentinel;
    sentinel = null;
    if (current) void current.release().catch(() => {});
  };

  const sync = (): void => {
    if (!eligible()) {
      release();
      return;
    }
    if (sentinel) return;

    const generation = ++requestGeneration;
    void nav.wakeLock
      ?.request('screen')
      .then((next) => {
        if (generation !== requestGeneration || !eligible()) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
        next.addEventListener(
          'release',
          () => {
            if (sentinel === next) sentinel = null;
          },
          { once: true },
        );
      })
      .catch(() => {
        // Unsupported iPadOS versions and battery-saving policies may reject.
      });
  };

  const onVisibilityChange = (): void => sync();
  doc.addEventListener('visibilitychange', onVisibilityChange);
  sync();

  return {
    sync,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      release();
    },
  };
}
