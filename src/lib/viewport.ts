/** Phone-only layout (stacked streams, no chat). Tablets and desktop keep the grid. */
export const PHONE_MAX_WIDTH = 640;

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
