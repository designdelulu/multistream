// jsdom (the vitest test environment) doesn't implement CSS.escape — every
// real browser does. Several DOM lookups in this codebase (cardForStream,
// header click-to-focus, etc.) rely on it to build attribute selectors from
// stream ids, so tests that actually mount/click cards need it available.
if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
  (globalThis as unknown as { CSS: { escape: (value: string) => string } }).CSS = {
    escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`),
  };
}
