import { parseStreamInput } from '../platforms';
import { isTikTokShortLink, resolveTikTokShareLink } from '../platforms/tiktok';
import { buildShareCardData, canvasToBlob, renderShareCard } from '../lib/shareCard';
import type { WatchPartyController } from './WatchParty';
import {
  isKickStatusRefreshInFlight,
  isStreamFocused,
  isTwitchStatusRefreshInFlight,
  refreshAllKickStatuses,
  refreshAllTwitchStatuses,
  refreshKickStatus,
  refreshTwitchStatus,
} from './StreamGrid';
import { IPAD_MAX_STREAMS, isIPadDevice } from '../lib/viewport';
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

/**
 * Fired on the hidden<->visible edge (never on every keystroke/re-sync) for
 * any toolbar dropdown that is absolutely positioned over the grid — the
 * add-stream suggestions list and the share/watch-party menu. Twitch's
 * embed pauses itself when a covering overlay like this appears above it;
 * see beginOverlayRecovery in StreamGrid.ts. `rect` is the overlay's own
 * bounding box, measured after it becomes visible (open) or just before it
 * is hidden (close), so recovery can be scoped to only the card(s) actually
 * covered.
 */
export interface OverlayHooks {
  onOverlayOpen?: (rect: DOMRect) => void;
  onOverlayClose?: (rect: DOMRect) => void;
}

/**
 * Share/copy always uses a live `/w/ROOM_ID` link: reuse the current party,
 * or start one. Static lineup URLs stay parseable; they are no longer a
 * share-menu action.
 */
export async function resolveLivePartyShareUrl(
  watchParty: Pick<WatchPartyController, 'getViewerUrl' | 'start'>,
): Promise<{ ok: true; url: string } | { ok: false; error?: string }> {
  const existing = watchParty.getViewerUrl();
  if (existing) return { ok: true, url: existing };
  const result = await watchParty.start();
  if (result.ok && result.url) return { ok: true, url: result.url };
  return { ok: false, error: result.error };
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

export function usernameCandidatePlatforms(value: string): Platform[] {
  const platforms: Platform[] = [];
  if (/^[a-zA-Z0-9_]{1,25}$/.test(value)) platforms.push('twitch');
  if (/^[a-zA-Z0-9_-]{1,25}$/.test(value)) platforms.push('kick');
  if (/^[a-zA-Z0-9._-]{1,100}$/.test(value)) platforms.push('youtube');
  if (/^[a-zA-Z0-9_.]{1,64}$/.test(value)) platforms.push('tiktok');
  return platforms;
}

/** Plain username candidates for the provider suggestion dropdown. */
export function plainUsernameCandidate(raw: string): string | null {
  const value = stripAtPrefix(raw);
  if (!value || isExplicitStreamInput(value)) return null;
  if (usernameCandidatePlatforms(value).length === 0) return null;
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

/**
 * Real imagery for the Story Card where it costs nothing extra: Twitch
 * (data-twitch-avatar-url, set by StreamGrid.ts's applyTwitchStatus from the
 * existing status API's own profile_image_url) and YouTube
 * (data-youtube-avatar-url, set by resolveAndMountYouTubeChannel from the
 * same channels.list call that already resolves a handle/username — never
 * present for a direct channelId add) and Kick (data-kick-avatar-url, set by
 * applyKickStatus from the same official metadata response that carries the
 * viewer count — no second request, no scraper, and absent until Kick
 * credentials are installed server-side). TikTok uses the same-origin
 * avatar proxy (`data-tiktok-avatar-url` → `/api/tiktok-avatar.php`) so the
 * canvas never loads a raw cross-origin CDN URL.
 *
 * A live Twitch thumbnail (data-twitch-thumbnail-url — the status API's
 * 320×180 preview, retained on the card only while live, so it can never
 * be a stale capture) is the fallback when no avatar resolved, so those
 * cards still get real imagery instead of initials.
 *
 * Read straight off the live cards rather than the store, since avatar URL
 * isn't part of StreamRef. Shared by both the preview and the real download
 * so they always render identically. Module-level + exported (with an
 * injectable root) so the preference order is unit-testable — see
 * StreamToolbar.test.ts.
 */
export function collectShareCardAvatarUrls(root: ParentNode = document): Map<string, string> {
  const avatarUrls = new Map<string, string>();
  for (const card of root.querySelectorAll<HTMLElement>(
    '.stream-card[data-platform="twitch"][data-twitch-avatar-url], .stream-card[data-platform="youtube"][data-youtube-avatar-url], .stream-card[data-platform="kick"][data-kick-avatar-url], .stream-card[data-platform="tiktok"][data-tiktok-avatar-url], .stream-card[data-platform="twitch"][data-twitch-thumbnail-url]',
  )) {
    const streamId = card.dataset.streamId;
    const avatarUrl =
      card.dataset.twitchAvatarUrl ??
      card.dataset.youtubeAvatarUrl ??
      card.dataset.kickAvatarUrl ??
      card.dataset.tiktokAvatarUrl ??
      card.dataset.twitchThumbnailUrl;
    if (streamId && avatarUrl) avatarUrls.set(streamId, avatarUrl);
  }
  return avatarUrls;
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
  watchParty?: WatchPartyController,
  overlayHooks?: OverlayHooks,
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
  const startLivePartyButton = document.querySelector<HTMLButtonElement>(
    '[data-action="start-live-party"]',
  );
  const copyLivePartyButton = document.querySelector<HTMLButtonElement>(
    '[data-action="copy-live-party"]',
  );
  const endLivePartyButton = document.querySelector<HTMLButtonElement>(
    '[data-action="end-live-party"]',
  );
  const partyStatus = document.querySelector<HTMLElement>('#watch-party-status');
  const partyStatusText = document.querySelector<HTMLElement>('#watch-party-status-text');
  const ipadNote = document.querySelector<HTMLElement>('#ipad-stream-note');

  if (!form || !input || !suggestions) {
    throw new Error('Stream toolbar elements not found');
  }

  const formEl = form;
  const inputEl = input;
  const suggestionsEl = suggestions;
  // The one existing provider-selection UI filters to providers whose
  // username grammar accepts the typed value.
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
    if (!suggestionsEl.hidden) {
      // Measure before hiding — after hidden the rect collapses to 0x0.
      overlayHooks?.onOverlayClose?.(suggestionsEl.getBoundingClientRect());
    }
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

    for (const platform of usernameCandidatePlatforms(username)) {
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

    const wasHidden = suggestionsEl.hidden;
    suggestionsEl.hidden = false;
    inputEl.setAttribute('aria-expanded', 'true');
    // Only the hidden->visible edge — showSuggestions re-renders on every
    // keystroke while the dropdown stays open, and that must not restart
    // recovery on every keypress.
    if (wasHidden) {
      overlayHooks?.onOverlayOpen?.(suggestionsEl.getBoundingClientRect());
    }
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
    if (watchParty?.getRole() === 'viewer') return;
    if (tiktokShareLinkPending) return; // a share-link resolve is already in flight
    const value = stripAtPrefix(inputEl.value);
    if (!value) return;

    // Checked before parsing/resolving so a TikTok short link — the one input
    // shape that would otherwise fire a network round trip first — is turned
    // away at the same point as everything else.
    if (atIPadStreamLimit()) {
      inputEl.classList.add('toolbar__input--error');
      inputEl.setAttribute('aria-invalid', 'stream-limit');
      syncIpadNote();
      return;
    }

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
      const option = suggestionsEl.querySelectorAll<HTMLButtonElement>('.toolbar__suggestion')[
        activeSuggestionIndex
      ];
      const platform = option?.dataset.platform as Platform | undefined;
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
    const viewerLocked = watchParty?.getRole() === 'viewer';
    if (shareMenuToggle) shareMenuToggle.hidden = !hasStreams;
    if (clearButton) clearButton.hidden = !hasStreams || viewerLocked;
    if (refreshButton) {
      refreshButton.hidden = !hasStreams;
    }
    // Disabled rather than hidden at the iPad cap: a control that vanishes
    // reads as a bug, where a greyed one plus the note underneath explains
    // itself. The submit handler still checks independently — this is the
    // affordance, not the enforcement.
    if (submitButton) {
      submitButton.disabled = atIPadStreamLimit();
    }
    syncPartyMenu();
  }

  function syncPartyMenu(): void {
    const role = watchParty?.getRole() ?? 'none';
    if (startLivePartyButton) startLivePartyButton.hidden = role !== 'none';
    if (copyLivePartyButton) copyLivePartyButton.hidden = role === 'none';
    if (endLivePartyButton) endLivePartyButton.hidden = role !== 'host';
    const text = watchParty?.getStatusText() ?? '';
    if (partyStatusText) partyStatusText.textContent = text;
    if (partyStatus) partyStatus.hidden = !text;
  }

  /** Visually-hidden aria-live text — never a modal/alert. Re-triggers even for a repeated message. */
  function announceTwitchStatus(message: string): void {
    if (!twitchStatusAnnouncer) return;
    twitchStatusAnnouncer.textContent = '';
    window.requestAnimationFrame(() => {
      twitchStatusAnnouncer.textContent = message;
    });
  }

  /**
   * iPad's manual-add ceiling (IPAD_MAX_STREAMS). Only ever consulted for
   * adds the user types — a restored link or a party lineup loads in full and
   * is reported by syncIpadNote instead, never trimmed.
   */
  function atIPadStreamLimit(): boolean {
    return isIPadDevice() && store.getStreams().length >= IPAD_MAX_STREAMS;
  }

  /**
   * The single iPad line under the toolbar, carrying whichever of three
   * states is true. Kept as one element rather than a toast because the
   * over-capacity condition *persists* — those streams stay loaded — so a
   * notice that auto-hides after 8s would state a fact the user can still see
   * contradicted on screen. Hidden entirely off-iPad by CSS.
   */
  function syncIpadNote(): void {
    if (!ipadNote) return;
    const count = store.getStreams().length;
    if (count > IPAD_MAX_STREAMS) {
      ipadNote.textContent = `${count} streams loaded — iPad plays best with ${IPAD_MAX_STREAMS} or fewer.`;
      return;
    }
    if (count === IPAD_MAX_STREAMS) {
      ipadNote.textContent = `iPad holds ${IPAD_MAX_STREAMS} streams. Remove one to add another.`;
      return;
    }
    ipadNote.textContent = `Up to ${IPAD_MAX_STREAMS} streams on iPad. Nine or fewer plays best in landscape.`;
  }

  function syncHeadersButton(): void {
    if (!headersButton) return;
    // Phones keep this control (it replaces Refresh there); iPad has its own
    // always-headerless CSS, so the toggle would be a no-op.
    if (isIPadDevice()) {
      headersButton.hidden = true;
      return;
    }
    headersButton.hidden = false;
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
   * Copies the live watch-party URL (starting a party if needed) and flashes
   * "Copied!" on the control itself (`feedbackEl`, when provided). The
   * share-menu path closes the menu after the flash; preview Copy stays open
   * (`keepOpen`). The `window.prompt` fallback (clipboard API
   * unavailable/denied) closes right away since there's nothing to flash.
   */
  async function ensureLivePartyUrl(): Promise<string | null> {
    if (!watchParty) return null;
    const result = await resolveLivePartyShareUrl(watchParty);
    syncPartyMenu();
    if (result.ok) return result.url;
    if (result.error) window.alert(result.error);
    return null;
  }

  async function copyLivePartyUrl(
    feedbackEl?: HTMLButtonElement,
    options?: { keepOpen?: boolean },
  ): Promise<void> {
    const url = await ensureLivePartyUrl();
    if (!url) {
      if (!options?.keepOpen) {
        closeShareMenu();
        shareMenuToggle?.focus();
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this live watch party link:', url);
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
    const previous = feedbackEl.innerHTML || 'Share Watch Party';
    feedbackEl.textContent = 'Copied!';
    window.clearTimeout(shareResetTimer);
    shareResetTimer = window.setTimeout(() => {
      feedbackEl.innerHTML = previous;
      if (!options?.keepOpen) {
        closeShareMenu();
        shareMenuToggle?.focus();
      }
    }, 900);
  }

  /*
   * Share menu (Section 18): a single "Share" button reveals a real in-app
   * dropdown — Start / Share / End a live watch party, Preview Story Card,
   * Download Story Card — desktop-first, not an immediate OS share sheet.
   * Share copies the live `/w/ROOM_ID` link and starts a party if none is
   * running. The story card is drawn to an offscreen canvas created on
   * demand (never appended to the DOM) — see lib/shareCard.ts for why it
   * isn't unit tested (no real <canvas> 2D context in jsdom).
   */
  function closeShareMenu(): void {
    if (!shareMenu || !shareMenuToggle) return;
    if (!shareMenu.hidden) {
      // Measure before hiding — after hidden the rect collapses to 0x0.
      overlayHooks?.onOverlayClose?.(shareMenu.getBoundingClientRect());
    }
    shareMenu.hidden = true;
    shareMenuToggle.setAttribute('aria-expanded', 'false');
  }

  function openShareMenu(): void {
    if (!shareMenu || !shareMenuToggle) return;
    shareMenu.hidden = false;
    shareMenuToggle.setAttribute('aria-expanded', 'true');
    shareMenu.querySelector<HTMLButtonElement>('.toolbar__share-menu-item')?.focus();
    overlayHooks?.onOverlayOpen?.(shareMenu.getBoundingClientRect());
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
   * "Download Story Card" means download, full stop. Routing this through
   * navigator.share (when the platform happens to support file sharing)
   * used to mean the button's actual behavior silently diverged from its
   * label: on desktop browsers that expose the Web Share API for files,
   * clicking "Download" opened an OS share sheet instead of saving
   * anything, which is exactly what looks like "nothing happened, no file
   * appeared" if that sheet gets dismissed.
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
    void copyLivePartyUrl(storyPreviewCopy, { keepOpen: true });
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

    if (action === 'copy-live-party') {
      void copyLivePartyUrl(actionButton);
      return;
    }

    if (action === 'start-live-party') {
      closeShareMenu();
      shareMenuToggle?.focus();
      void (async () => {
        const result = await watchParty?.start();
        if (result?.ok && result.url) {
          try {
            await navigator.clipboard.writeText(result.url);
          } catch {
            window.prompt('Copy this live watch party link:', result.url);
          }
        } else if (result && !result.ok && result.error) {
          window.alert(result.error);
        }
        syncPartyMenu();
      })();
      return;
    }

    if (action === 'end-live-party') {
      closeShareMenu();
      shareMenuToggle?.focus();
      const ok = window.confirm('End this live watch party? Viewers will keep the last lineup.');
      if (!ok) return;
      void (async () => {
        const result = await watchParty?.end();
        if (result && !result.ok && result.error) {
          window.alert(result.error);
        }
        syncPartyMenu();
      })();
      return;
    }

    closeShareMenu();
    shareMenuToggle?.focus();

    if (action === 'preview-story-card') {
      void openStoryCardPreview();
    } else if (action === 'story-card') {
      void downloadOrShareStoryCard();
    }
  });

  clearButton?.addEventListener('click', () => {
    if (watchParty?.getRole() === 'viewer') return;
    if (store.getStreams().length === 0) return;
    const ok = window.confirm('Remove all streams from this layout?');
    if (!ok) return;
    store.clearStreams();
  });

  headersButton?.addEventListener('click', () => {
    if (isStreamFocused()) return;
    if (isIPadDevice()) return;
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
    syncIpadNote();
  }

  store.subscribe(syncIpadNote);
  store.subscribe(syncActionButtons);
  headersStore.subscribe(syncHeadersButton);
  viewModeStore.subscribe(syncFocusViewButton);
  watchParty?.subscribe(syncActionButtons);
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
