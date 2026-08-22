import type { ViewMode } from '../state/viewMode';

/** Phone-only layout (stacked streams, no chat). Tablets and desktop keep the grid. */
export const PHONE_MAX_WIDTH = 640;

/**
 * Most streams an iPad may hold via manual adds. Past this the grid tiles
 * shrink below the box Twitch will autoplay in (see
 * TWITCH_MIN_REMOUNT_WIDTH/HEIGHT in StreamGrid.ts) and most cards simply
 * never start — confirmed live at 12. Ten is the portrait ceiling; landscape
 * is comfortable at nine, but the cap is deliberately a single flat number
 * rather than orientation-aware, so it never changes under the user mid-
 * session and no stream can become "over cap" just by turning the device.
 * The landscape guidance is advisory copy instead (see the iPad note in
 * index.html).
 *
 * This bounds the *Add* control only. A shared link or a watch-party lineup
 * always loads in full — trimming one would desync a party viewer from the
 * host — and warns once instead.
 */
export const IPAD_MAX_STREAMS = 10;

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
