import type { ViewMode } from '../state/viewMode';

/** Phone-only layout (stacked streams, no chat). Tablets and desktop keep the grid. */
export const PHONE_MAX_WIDTH = 640;

type DeviceNavigator = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>;

/** Modern iPadOS may identify itself as Macintosh; touch capability disambiguates it from a Mac. */
export function isIPadDevice(nav: DeviceNavigator = navigator): boolean {
  return /iPad/i.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

export function isPhoneViewport(): boolean {
  return window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`).matches;
}

export function isStackedStreamLayout(): boolean {
  return isPhoneViewport();
}

export function isChatHiddenByViewport(): boolean {
  return isPhoneViewport();
}

export function phoneMediaQuery(): MediaQueryList {
  return window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);
}

/**
 * Maps the persisted view-mode store to the layout the DOM/CSS should use.
 * iPad shows Theater (store `focus`, primary + tray on desktop) as solo
 * primary only (`theater` display) so watch-party Theater sync still stores
 * `focus` but the host sees a full-size primary without a tray.
 */
export function resolveDisplayViewMode(
  storeMode: ViewMode,
  nav: DeviceNavigator = navigator,
): ViewMode {
  if (isIPadDevice(nav) && storeMode === 'focus') {
    return 'theater';
  }
  return storeMode;
}
