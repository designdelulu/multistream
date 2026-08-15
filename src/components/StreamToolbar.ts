import { parseStreamInput } from '../platforms';
import { isTikTokShortLink, resolveTikTokShareLink } from '../platforms/tiktok';
import { buildShareCardData, canvasToBlob, renderShareCard } from '../lib/shareCard';
import {
  isKickStatusRefreshInFlight,
  isStreamFocused,
  isTwitchStatusRefreshInFlight,
  refreshAllKickStatuses,
  refreshAllTwitchStatuses,
  refreshKickStatus,
  refreshTwitchStatus,
} from './StreamGrid';
import type { Platform } from '../types';
import type { HeadersStore } from '../state/headers';
import type { StreamStore } from '../state/streams';
import type { ViewModeStore } from '../state/viewMode';

/**
 * Dependencies for the global "Refresh" action — kept separate from
 * store/headersStore since it's backed by main.ts's shared
 * coordinators/schedulers, not toolbar-local state. Recovers loaded
 * players and refreshes Twitch/YouTube/Kick metadata — see
 * main.ts's manualRefreshAll.
 */
export interface GlobalRefreshDeps {
  refresh(): Promise<{ outcome: 'ok' | 'skipped-empty'; twitchAllUnavailable: boolean }>;
  isRefreshInFlight(): boolean;
}

/** Story Card preview open/close — overlay only; never rebuilds the grid. */
export interface StoryPreviewHooks {
  onWillOpen?: () => void;
  onDidOpen?: () => void;
  onWillClose?: () => void;
  onDidClose?: () => void;
}

const PLATFORM_STORAGE_KEY = 'multistream:add-platform';

function loadPreferredPlatform(): Platform {
  try {
    const stored = localStorage.getItem(PLATFORM_STORAGE_KEY);
    if (stored === 'kick' || stored === 'twitch' || stored === 'youtube') {
      return stored;
    }
  } catch {
    // Ignore storage failures.
  }
  return 'twitch';
}

function persistPreferredPlatform(platform: Platform): void {
  try {
    localStorage.setItem(PLATFORM_STORAGE_KEY, platform);
  } catch {
    // Ignore storage failures.
  }
}

function stripAtPrefix(value: string): string {
  return value.trim().replace(/^@+/, '');
}

function isExplicitStreamInput(value: string): boolean {
  return (
    /^(?:t|k|y|yt|twitch|kick|youtube):/i.test(value) ||
    /^https?:\/\//i.test(value) ||
    /(?:^|\.)twitch\.tv\b/i.test(value) ||
    /(?:^|\.)kick\.com\b/i.test(value) ||
    /(?:^|\.)youtube\.com\b/i.test(value) ||
    /(?:^|\.)youtube-nocookie\.com\b/i.test(value) ||
    /(?:^|\.)youtu\.be\b/i.test(value)
  );
}

/** Plain username candidates for the Twitch/Kick suggestion dropdown. */
export function plainUsernameCandidate(raw: string): string | null {
  const value = stripAtPrefix(raw);
  if (!value || isExplicitStreamInput(value)) return null;
  if (!/^[a-zA-Z0-9_]{1,25}$/.test(value) && !/^[a-zA-Z0-9_-]{1,25}$/.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

/** Explicit prefixes/URLs win; plain usernames use the selected platform. */
export function resolveAddInput(raw: string, platform: Platform): string {
  const value = stripAtPrefix(raw);
  if (!value) return value;

  if (isExplicitStreamInput(value)) {
    return value;
  }

  if (platform === 'kick') return `k:${value}`;
  if (platform === 'youtube') return `y:handle:${value}`;
  // TikTok LIVE explicitly selected: a bare username/@username has no
  // ambiguity to resolve here (unlike the no-selection case, where a bare
  // word stays a Twitch/Kick suggestion candidate) — build the same
  // canonical /@handle/live URL tiktokAdapter.parseInput already accepts, so
  // this reuses that one parser/resolver path rather than adding a second.
  // An invalid handle still surfaces the normal "couldn't add" error, since
  // parseTikTokLiveUrl (tiktok.ts) applies the same handle validation either way.
  if (platform === 'tiktok') return `https://www.tiktok.com/@${value}/live`;
  return value;
}

function iconButtonLabel(button: HTMLButtonElement): HTMLElement | null {
  return button.querySelector<HTMLElement>('.toolbar__icon-btn-label');
}

function setIconButtonLabel(button: HTMLButtonElement, text: string): void {
  const label = iconButtonLabel(button);
  if (label) {
    label.textContent = text;
  }
  button.title = text;
  button.setAttribute('aria-label', text);
}

function tryAddStream(
  store: StreamStore,
  inputEl: HTMLInputElement,
  resolved: string,
): boolean {
  const added = store.addStream(resolved);
  if (!added) {
    inputEl.classList.add('toolbar__input--error');
    const parsed = parseStreamInput(resolved);
    const isDuplicate =
      parsed !== null &&
      store.getStreams().some(
        (stream) =>
          stream.platform === parsed.platform && stream.channel === parsed.channel,
      );
    inputEl.setAttribute('aria-invalid', isDuplicate ? 'duplicate' : 'true');
    return false;
  }

  inputEl.value = '';
  inputEl.classList.remove('toolbar__input--error');
  inputEl.removeAttribute('aria-invalid');
  inputEl.focus();
  return true;
}

/**
 * After a successful add, kick off a single-channel advisory status check.
 * Twitch and Kick both have one; YouTube's equivalent runs from its own mount
 * path and TikTok has no metadata source at all.
 */
function checkTwitchStatusAfterAdd(resolved: string): void {
  const parsed = parseStreamInput(resolved);
  if (!parsed) return;
  const gridEl = document.querySelector<HTMLElement>('#stream-grid');
  if (!gridEl) return;
  if (parsed.platform === 'twitch') {
    refreshTwitchStatus(gridEl, [parsed.channel]);
  } else if (parsed.platform === 'kick') {
    refreshKickStatus(gridEl, [parsed.channel]);
  }
}

export function bindStreamToolbar(
  store: StreamStore,
  headersStore: HeadersStore,
  viewModeStore: ViewModeStore,
  globalRefresh: GlobalRefreshDeps,
  storyPreviewHooks?: StoryPreviewHooks,
): { sync: () => void } {
  const form = document.querySelector<HTMLFormElement>('#add-stream-form');
  const input = document.querySelector<HTMLInputElement>('#stream-input');
  const submitButton = document.querySelector<HTMLButtonElement>('#add-stream-submit');
  const suggestions = document.querySelector<HTMLElement>('#add-stream-suggestions');
  const shareMenuToggle = document.querySelector<HTMLButtonElement>('#share-menu-toggle');
  const shareMenu = document.querySelector<HTMLElement>('#share-menu');
  const clearButton = document.querySelector<HTMLButtonElement>('#clear-streams');
  const headersButton = document.querySelector<HTMLButtonElement>('#headers-toggle');
  const focusViewButton = document.querySelector<HTMLButtonElement>('#focus-view-toggle');
  const refreshButton = document.querySelector<HTMLButtonElement>('#refresh-streams');
  const twitchStatusAnnouncer = document.querySelector<HTMLElement>('#twitch-status-announcer');
  const storyPreview = document.querySelector<HTMLElement>('#story-preview');
  const storyPreviewBackdrop = document.querySelector<HTMLElement>('#story-preview-backdrop');
  const storyPreviewImage = document.querySelector<HTMLImageElement>('#story-preview-image');
  const storyPreviewClose = document.querySelector<HTMLButtonElement>('#story-preview-close');
  const storyPreviewDownload = document.querySelector<HTMLButtonElement>('#story-preview-download');
  const storyPreviewCopy = document.querySelector<HTMLButtonElement>('#story-preview-copy');
  const storyPreviewShare = document.querySelector<HTMLButtonElement>('#story-preview-share');

  if (!form || !input || !suggestions) {
    throw new Error('Stream toolbar elements not found');
  }

  const formEl = form;
  const inputEl = input;
  const suggestionsEl = suggestions;
  // The one, existing provider-selection UI: typing a bare username shows
  // all four as suggestions and the user picks one — there is no separate
  // permanent provider control before the input.
  const suggestionPlatforms: Platform[] = ['twitch', 'kick', 'youtube', 'tiktok'];
  let selectedPlatform = loadPreferredPlatform();
  let activeSuggestionIndex = -1;
  let shareResetTimer = 0;
  let tiktokShareLinkResolveToken = 0;
  let tiktokShareLinkPending = false;

  /**
   * TikTok short-link (vm./vt.tiktok.com) resolution is the one add-stream
   * path with a real network round trip before a card can even be created
   * (see handleTikTokShareLinkSubmit) — every other provider/input shape
   * adds synchronously. Without this, submitting one left the form looking
   * inert for however long that redirect-follow takes, and a second submit
   * mid-flight could fire an overlapping resolver request. Guards both.
   */
  function setTikTokShareLinkPending(pending: boolean): void {
    tiktokShareLinkPending = pending;
    inputEl.disabled = pending;
    if (submitButton) {
      submitButton.disabled = pending;
      submitButton.textContent = pending ? 'Resolving…' : 'Add Stream';
    }
  }

  /**
   * TikTok's app Share sheet copies a vm.tiktok.com/vt.tiktok.com short
   * link — the handle isn't in the URL itself, only reachable by following
   * the redirect server-side (see resolveTikTokShareLink /
   * public/api/tiktok-resolve.php). tryAddStream can never succeed for one
   * synchronously (tiktokAdapter.parseInput rejects those hosts by design —
   * see src/platforms/tiktok.ts), so this is a separate async path rather
   * than something tryAddStream itself could absorb. setTikTokShareLinkPending
   * keeps the form visibly busy (never a red error) for this one; it only
   * turns red if the resolve genuinely fails.
   */
  async function handleTikTokShareLinkSubmit(rawUrl: string): Promise<void> {
    const token = ++tiktokShareLinkResolveToken;
    inputEl.classList.remove('toolbar__input--error');
    inputEl.removeAttribute('aria-invalid');
    setTikTokShareLinkPending(true);

    const result = await resolveTikTokShareLink(rawUrl);
    if (token !== tiktokShareLinkResolveToken) return; // superseded by a later submit — drop this stale result
    setTikTokShareLinkPending(false);

    if (!result.username || result.state === 'invalid_input') {
      inputEl.classList.add('toolbar__input--error');
      inputEl.setAttribute('aria-invalid', 'true');
      return;
    }

    const canonicalUrl = `https://www.tiktok.com/@${result.username}/live`;
    if (tryAddStream(store, inputEl, canonicalUrl)) {
      hideSuggestions();
      checkTwitchStatusAfterAdd(canonicalUrl);
    }
  }

  function hideSuggestions(): void {
    suggestionsEl.hidden = true;
    suggestionsEl.replaceChildren();
    inputEl.setAttribute('aria-expanded', 'false');
    activeSuggestionIndex = -1;
    inputEl.removeAttribute('aria-activedescendant');
  }

  function setActiveSuggestion(index: number): void {
    const options = suggestionsEl.querySelectorAll<HTMLButtonElement>('.toolbar__suggestion');
    activeSuggestionIndex = index;

    options.forEach((option, i) => {
      const isActive = i === index;
      option.classList.toggle('toolbar__suggestion--active', isActive);
      option.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    if (index >= 0 && index < options.length) {
      inputEl.setAttribute('aria-activedescendant', options[index].id);
    } else {
      inputEl.removeAttribute('aria-activedescendant');
    }
  }

  function selectSuggestion(username: string, platform: Platform): void {
    selectedPlatform = platform;
    persistPreferredPlatform(platform);
    const resolved = resolveAddInput(username, platform);
    if (tryAddStream(store, inputEl, resolved)) {
      hideSuggestions();
      checkTwitchStatusAfterAdd(resolved);
    }
  }

  function showSuggestions(username: string): void {
    suggestionsEl.replaceChildren();
    activeSuggestionIndex = -1;
    inputEl.removeAttribute('aria-activedescendant');

    for (const platform of suggestionPlatforms) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'toolbar__suggestion';
      option.role = 'option';
      option.id = `add-stream-suggestion-${platform}`;
      option.dataset.platform = platform;
      option.setAttribute('aria-selected', 'false');

      const label = document.createElement('span');
      label.className = 'toolbar__suggestion-label';
      const strong = document.createElement('strong');
      strong.textContent = username;
      label.append('Add ', strong);

      const badge = document.createElement('span');
      badge.className = `toolbar__suggestion-platform toolbar__suggestion-platform--${platform}`;
      badge.textContent =
        platform === 'twitch'
          ? 'TWITCH'
          : platform === 'kick'
            ? 'KICK'
            : platform === 'youtube'
              ? 'YOUTUBE'
              : 'TIKTOK LIVE · EXPERIMENTAL';

      option.append(label, badge);
      option.addEventListener('mousedown', (event) => {
        // Prevent input blur from racing the click.
        event.preventDefault();
      });
      option.addEventListener('click', () => {
        selectSuggestion(username, platform);
      });
      suggestionsEl.append(option);
    }

    suggestionsEl.hidden = false;
    inputEl.setAttribute('aria-expanded', 'true');
  }

  function syncSuggestions(): void {
    const candidate = plainUsernameCandidate(inputEl.value);
    if (!candidate) {
      hideSuggestions();
      return;
    }
    showSuggestions(candidate);
  }

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    if (tiktokShareLinkPending) return; // a share-link resolve is already in flight
    const value = stripAtPrefix(inputEl.value);
    if (!value) return;

    const candidate = plainUsernameCandidate(inputEl.value);
    if (candidate && !suggestionsEl.hidden) {
      // Plain username — require an explicit Twitch or Kick pick from the dropdown.
      inputEl.classList.add('toolbar__input--error');
      inputEl.setAttribute('aria-invalid', 'platform-required');
      syncSuggestions();
      return;
    }

    const resolved = resolveAddInput(value, selectedPlatform);

    if (isTikTokShortLink(resolved)) {
      // tiktokAdapter.parseInput can never resolve this synchronously (see
      // its module doc comment) — skip straight to the async resolve
      // instead of letting tryAddStream mark the input red first.
      void handleTikTokShareLinkSubmit(resolved);
      return;
    }

    if (tryAddStream(store, inputEl, resolved)) {
      hideSuggestions();
      checkTwitchStatusAfterAdd(resolved);
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.classList.remove('toolbar__input--error');
    inputEl.removeAttribute('aria-invalid');
    syncSuggestions();
  });

  inputEl.addEventListener('focus', () => {
    syncSuggestions();
  });

  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSuggestions();
      return;
    }

    if (suggestionsEl.hidden) return;

    const optionCount = suggestionsEl.querySelectorAll('.toolbar__suggestion').length;
    if (optionCount === 0) return;

    const candidate = plainUsernameCandidate(inputEl.value);
    if (!candidate) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next =
        activeSuggestionIndex < 0
          ? 0
          : Math.min(activeSuggestionIndex + 1, optionCount - 1);
      setActiveSuggestion(next);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (activeSuggestionIndex <= 0) {
        setActiveSuggestion(activeSuggestionIndex < 0 ? -1 : 0);
      } else {
        setActiveSuggestion(activeSuggestionIndex - 1);
      }
      return;
    }

    if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
      event.preventDefault();
      const platform = suggestionPlatforms[activeSuggestionIndex];
      if (platform) {
        selectSuggestion(candidate, platform);
      }
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (formEl.contains(target)) return;
    hideSuggestions();
  });

  function syncActionButtons(): void {
    const hasStreams = store.getStreams().length > 0;
    if (shareMenuToggle) shareMenuToggle.hidden = !hasStreams;
    if (clearButton) clearButton.hidden = !hasStreams;
    if (refreshButton) {
      refreshButton.hidden = !hasStreams;
    }
  }

  /** Visually-hidden aria-live text — never a modal/alert. Re-triggers even for a repeated message. */
  function announceTwitchStatus(message: string): void {
    if (!twitchStatusAnnouncer) return;
    twitchStatusAnnouncer.textContent = '';
    window.requestAnimationFrame(() => {
      twitchStatusAnnouncer.textContent = message;
    });
  }

  function syncHeadersButton(): void {
    if (!headersButton) return;
    const hidden = headersStore.isHidden();
    const focused = isStreamFocused();
    const label = hidden ? 'Show headers' : 'Hide headers';
    setIconButtonLabel(headersButton, label);
    headersButton.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    headersButton.disabled = focused;
    if (focused) {
      headersButton.title = 'Exit focus to show or hide headers';
      headersButton.setAttribute('aria-label', 'Exit focus to show or hide headers');
    }
  }

  /**
   * Theater/Focus are no longer entered from here — the arbitrary "which
   * stream becomes primary" ambiguity that caused was the whole problem (it
   * always grabbed streams[0]). Entry now only happens from an individual
   * stream's own Focus control (StreamGrid.ts's bindFocusViewEntry), where
   * the primary is explicit by construction. This button's only remaining
   * job is a second way back to Grid alongside the primary card's own X
   * (see handleCardCloseClick's "Return to Grid" behavior) — so it's shown
   * for either non-grid mode and hidden entirely in Grid View, where it can
   * never be mistaken for an entry point.
   */
  function syncFocusViewButton(): void {
    if (!focusViewButton) return;
    const inPrimaryMode = viewModeStore.getMode() !== 'grid';
    focusViewButton.hidden = !inPrimaryMode;
    setIconButtonLabel(focusViewButton, 'Grid view');
    focusViewButton.title = 'Return to Grid';
    focusViewButton.setAttribute('aria-label', 'Return to Grid');
    focusViewButton.setAttribute('aria-pressed', 'true');
  }

  /**
   * Copies the watch URL and flashes "Copied!" on the control itself
   * (`feedbackEl`, when provided) before closing. The share-menu path closes
   * the menu after the flash; preview Copy Watch URL stays open (`keepOpen`).
   * The `window.prompt` fallback (clipboard API unavailable/denied) closes
   * right away since there's nothing to flash.
   */
  async function copyWatchUrl(
    feedbackEl?: HTMLButtonElement,
    options?: { keepOpen?: boolean },
  ): Promise<void> {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this link:', url);
      if (!options?.keepOpen) {
        closeShareMenu();
        shareMenuToggle?.focus();
      }
      return;
    }
    if (!feedbackEl) {
      if (!options?.keepOpen) closeShareMenu();
      return;
    }
    const previous = feedbackEl.textContent ?? 'Copy Watch URL';
    feedbackEl.textContent = 'Copied!';
    window.clearTimeout(shareResetTimer);
    shareResetTimer = window.setTimeout(() => {
      feedbackEl.textContent = previous;
      if (!options?.keepOpen) {
        closeShareMenu();
        shareMenuToggle?.focus();
      }
    }, 900);
  }

  /*
   * Share menu (Section 18): a single "Share" button reveals a real in-app
   * dropdown — Copy Watch URL, Preview Story Card, Download Story Card,
   * Share Watch Party — desktop-first, not an immediate OS share sheet. The
   * story card is drawn to an offscreen canvas created on demand (never
   * appended to the DOM) — see lib/shareCard.ts for why it isn't unit
   * tested (no real <canvas> 2D context in jsdom).
   */
  function closeShareMenu(): void {
    if (!shareMenu || !shareMenuToggle) return;
    shareMenu.hidden = true;
    shareMenuToggle.setAttribute('aria-expanded', 'false');
  }

  function openShareMenu(): void {
    if (!shareMenu || !shareMenuToggle) return;
    shareMenu.hidden = false;
    shareMenuToggle.setAttribute('aria-expanded', 'true');
    shareMenu.querySelector<HTMLButtonElement>('.toolbar__share-menu-item')?.focus();
  }

  shareMenuToggle?.addEventListener('click', () => {
    if (!shareMenu) return;
    if (shareMenu.hidden) openShareMenu();
    else closeShareMenu();
  });

  document.addEventListener('click', (event) => {
    if (!shareMenu || shareMenu.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (shareMenu.contains(target) || shareMenuToggle?.contains(target)) return;
    closeShareMenu();
  });

  shareMenu?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeShareMenu();
      shareMenuToggle?.focus();
    }
  });

  async function shareWatchParty(): Promise<void> {
    const url = window.location.href;
    const shareData = {
      title: 'MultiStream.cc Watch Party',
      text: 'Join my live watch party on MultiStream.cc',
      url,
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        // AbortError just means the user dismissed the native share sheet —
        // not a failure worth falling back from.
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    await copyWatchUrl();
  }

  /**
   * Real avatars where they cost nothing extra: Twitch (data-twitch-avatar-url,
   * set by StreamGrid.ts's applyTwitchStatus from the existing status API's
   * own profile_image_url) and YouTube (data-youtube-avatar-url, set by
   * resolveAndMountYouTubeChannel from the same channels.list call that
   * already resolves a handle/username — never present for a direct
   * channelId add) and Kick (data-kick-avatar-url, set by applyKickStatus
   * from the same official metadata response that carries the viewer count —
   * no second request, no scraper, and absent until Kick credentials are
   * installed server-side). TikTok uses the same-origin avatar proxy
   * (`data-tiktok-avatar-url` → `/api/tiktok-avatar.php`) so the canvas
   * never loads a raw cross-origin CDN URL. Read straight
   * off the live cards rather than the store, since avatar URL isn't part
   * of StreamRef. Shared by both the preview and the real download so
   * they always render identically.
   */
  function collectShareCardAvatarUrls(): Map<string, string> {
    const avatarUrls = new Map<string, string>();
    for (const card of document.querySelectorAll<HTMLElement>(
      '.stream-card[data-platform="twitch"][data-twitch-avatar-url], .stream-card[data-platform="youtube"][data-youtube-avatar-url], .stream-card[data-platform="kick"][data-kick-avatar-url], .stream-card[data-platform="tiktok"][data-tiktok-avatar-url]',
    )) {
      const streamId = card.dataset.streamId;
      const avatarUrl =
        card.dataset.twitchAvatarUrl ??
        card.dataset.youtubeAvatarUrl ??
        card.dataset.kickAvatarUrl ??
        card.dataset.tiktokAvatarUrl;
      if (streamId && avatarUrl) avatarUrls.set(streamId, avatarUrl);
    }
    return avatarUrls;
  }

  /** Bounded wait so a stuck lookup can never hang the Share flow. */
  const AVATAR_METADATA_WAIT_MS = 3000;

  /**
   * Lets any Twitch/YouTube avatar-metadata lookup already in flight for the
   * current lineup land before collectShareCardAvatarUrls reads the DOM —
   * otherwise a stream added moments ago (status/resolve request still
   * pending) reads as "no avatar" purely because that request hadn't landed
   * yet, not because one genuinely isn't available. Reuses the exact same
   * paths the rest of the app already uses for this, and only when there is
   * something to wait for:
   *  - Twitch: always asks refreshAllTwitchStatuses to run. If nothing else
   *    is in flight it does the real check itself. If a different refresh
   *    (initial-restore/periodic/another manual call) is *already* in
   *    flight — the exact case a user hitting Share right after adding
   *    streams lands in — the coordinator's inFlight gate makes that call
   *    return 'skipped-inflight' immediately without waiting (see
   *    twitchStatusCoordinator.ts), which used to be silently treated as
   *    "nothing to wait for" here. That was the actual cause of a 5-stream
   *    lineup's Story Card only showing ~1 real avatar: four channels'
   *    results were still in flight under someone else's request when the
   *    DOM got read. So an 'ok'/'skipped-empty' outcome means the check is
   *    genuinely done, but 'skipped-inflight' must fall through to polling
   *    isTwitchStatusRefreshInFlight() until it clears (bounded, same
   *    deadline as the YouTube wait below) before the DOM read happens.
   *  - YouTube: its avatar only ever comes from resolveAndMountYouTubeChannel
   *    (StreamGrid.ts), a one-time per-card resolution with no separate
   *    "refresh" to trigger — this just waits for cards still mid-resolution
   *    (data-youtube-mount-state="pending") to finish on their own.
   */
  async function awaitAvatarMetadataSettled(): Promise<void> {
    const grid = document.querySelector<HTMLElement>('#stream-grid');
    if (!grid) return;

    const deadline = Date.now() + AVATAR_METADATA_WAIT_MS;

    if (grid.querySelector('.stream-card[data-platform="twitch"]')) {
      const outcome = await refreshAllTwitchStatuses(store, 'manual');
      if (outcome.outcome === 'skipped-inflight') {
        while (isTwitchStatusRefreshInFlight() && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
      }
    }

    // Kick's avatar arrives through exactly the same status pipeline, so it
    // needs exactly the same in-flight handling — including the
    // 'skipped-inflight' fall-through that was the original bug here.
    if (grid.querySelector('.stream-card[data-platform="kick"]')) {
      const outcome = await refreshAllKickStatuses(store, 'manual');
      if (outcome.outcome === 'skipped-inflight') {
        while (isKickStatusRefreshInFlight() && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
      }
    }

    while (
      grid.querySelector('.stream-card[data-platform="youtube"][data-youtube-mount-state="pending"]') &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
  }

  /** Draws the same card the download/preview both use — one render path, no drift between what's previewed and what's saved. */
  async function renderShareCardBlob(): Promise<Blob | null> {
    await awaitAvatarMetadataSettled();
    const canvas = document.createElement('canvas');
    const avatarUrls = collectShareCardAvatarUrls();
    const data = buildShareCardData(store.getStreams(), window.location.href, avatarUrls);
    if (!(await renderShareCard(canvas, data))) return null;
    return canvasToBlob(canvas);
  }

  function triggerBlobDownload(blob: Blob): void {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'multistream-watch-party.png';
    // Must be attached for the click to reliably trigger a download in every
    // browser, and the object URL must outlive the click — revoking it
    // synchronously races the browser's own (async) read of the blob and can
    // silently drop the download before any bytes are fetched.
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  }

  /**
   * "Download Story Card" means download, full stop — the menu item below
   * it (share-party) already covers native-share-sheet sharing of the
   * watch URL. Routing this one through navigator.share too (when the
   * platform happens to support file sharing) used to mean the button's
   * actual behavior silently diverged from its label: on desktop browsers
   * that expose the Web Share API for files, clicking "Download" opened an
   * OS share sheet instead of saving anything, which is exactly what looks
   * like "nothing happened, no file appeared" if that sheet gets dismissed.
   */
  async function downloadOrShareStoryCard(): Promise<void> {
    const blob = await renderShareCardBlob();
    if (!blob) return;
    triggerBlobDownload(blob);
  }

  let storyPreviewObjectUrl: string | null = null;

  function closeStoryCardPreview(): void {
    if (!storyPreview || storyPreview.hidden) return;
    storyPreviewHooks?.onWillClose?.();
    storyPreview.hidden = true;
    if (storyPreviewBackdrop) storyPreviewBackdrop.hidden = true;
    if (storyPreviewObjectUrl) {
      URL.revokeObjectURL(storyPreviewObjectUrl);
      storyPreviewObjectUrl = null;
    }
    storyPreviewHooks?.onDidClose?.();
  }

  /** Preview shows the actual final render (the same renderShareCard canvas), not a mockup — see collectShareCardAvatarUrls/renderShareCardBlob's own doc comments. */
  async function openStoryCardPreview(): Promise<void> {
    if (!storyPreview || !storyPreviewImage) return;
    const blob = await renderShareCardBlob();
    if (!blob) return;
    if (storyPreviewObjectUrl) URL.revokeObjectURL(storyPreviewObjectUrl);
    storyPreviewObjectUrl = URL.createObjectURL(blob);
    storyPreviewImage.src = storyPreviewObjectUrl;
    storyPreviewHooks?.onWillOpen?.();
    if (storyPreviewBackdrop) storyPreviewBackdrop.hidden = false;
    storyPreview.hidden = false;
    storyPreviewClose?.focus();
    storyPreviewHooks?.onDidOpen?.();
  }

  storyPreviewClose?.addEventListener('click', closeStoryCardPreview);
  storyPreviewDownload?.addEventListener('click', () => {
    void downloadOrShareStoryCard();
  });
  storyPreviewCopy?.addEventListener('click', () => {
    void copyWatchUrl(storyPreviewCopy, { keepOpen: true });
  });
  storyPreviewShare?.addEventListener('click', () => {
    void shareWatchParty();
  });
  document.addEventListener('click', (event) => {
    if (!storyPreview || storyPreview.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (storyPreview.contains(target)) return;
    closeStoryCardPreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && storyPreview && !storyPreview.hidden) {
      closeStoryCardPreview();
    }
  });

  shareMenu?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const actionButton = target.closest<HTMLButtonElement>('.toolbar__share-menu-item');
    if (!actionButton) return;
    const action = actionButton.dataset.action;

    if (action === 'copy-url') {
      void copyWatchUrl(actionButton);
      return;
    }

    closeShareMenu();
    shareMenuToggle?.focus();

    if (action === 'share-party') {
      void shareWatchParty();
    } else if (action === 'preview-story-card') {
      void openStoryCardPreview();
    } else if (action === 'story-card') {
      void downloadOrShareStoryCard();
    }
  });

  clearButton?.addEventListener('click', () => {
    if (store.getStreams().length === 0) return;
    const ok = window.confirm('Remove all streams from this layout?');
    if (!ok) return;
    store.clearStreams();
  });

  headersButton?.addEventListener('click', () => {
    if (isStreamFocused()) return;
    headersStore.toggle();
  });

  // Exit-only — see syncFocusViewButton's doc comment. The button is hidden
  // in Grid View, so this only ever fires while already in Focus View.
  focusViewButton?.addEventListener('click', () => {
    viewModeStore.setMode('grid');
  });

  /**
   * The global "Refresh" action. Calls the injected refresh (player recovery
   * plus metadata — see GlobalRefreshDeps) and updates this button's own
   * disabled/label state plus the aria-live announcer. The in-flight check
   * up front, together with disabling the button before the request starts,
   * is what prevents a double-click from creating overlapping requests.
   */
  refreshButton?.addEventListener('click', () => {
    if (globalRefresh.isRefreshInFlight()) return;

    const previousLabel = iconButtonLabel(refreshButton)?.textContent ?? 'Refresh';
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
    setIconButtonLabel(refreshButton, 'Refreshing…');

    void globalRefresh.refresh().then((result) => {
      refreshButton.disabled = false;
      refreshButton.removeAttribute('aria-busy');
      setIconButtonLabel(refreshButton, previousLabel);

      if (result.outcome !== 'ok') {
        // 'skipped-empty' means the button should already be hidden —
        // nothing useful to announce.
        return;
      }

      announceTwitchStatus(
        result.twitchAllUnavailable ? 'Twitch status temporarily unavailable' : 'Streams refreshed',
      );
    });
  });

  function sync(): void {
    syncActionButtons();
    syncHeadersButton();
    syncFocusViewButton();
  }

  store.subscribe(syncActionButtons);
  headersStore.subscribe(syncHeadersButton);
  viewModeStore.subscribe(syncFocusViewButton);
  sync();
  hideSuggestions();

  return { sync };
}

export function updateEmptyState(store: StreamStore): void {
  const emptyState = document.querySelector<HTMLElement>('#empty-state');
  if (!emptyState) return;

  const hasStreams = store.getStreams().length > 0;
  emptyState.hidden = hasStreams;
}
