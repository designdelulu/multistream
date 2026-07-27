/** Twitch interactive embed (player.twitch.tv/js/embed/v1.js). */

export interface TwitchPlayerInstance {
  play(): void;
  pause(): void;
  setMuted(muted: boolean): void;
  getMuted(): boolean;
  setVolume(volume: number): void;
  addEventListener(event: string, callback: () => void): void;
  removeEventListener?(event: string, callback: () => void): void;
}

interface TwitchPlayerOptions {
  width: number | string;
  height: number | string;
  channel: string;
  parent: string[];
  autoplay?: boolean;
  muted?: boolean;
}

interface TwitchNamespace {
  Player: {
    new (elementId: string, options: TwitchPlayerOptions): TwitchPlayerInstance;
    READY: string;
    ONLINE: string;
    PLAYING: string;
    PLAYBACK_BLOCKED: string;
  };
}

declare global {
  interface Window {
    Twitch?: TwitchNamespace;
  }
}

const SCRIPT_SRC = 'https://player.twitch.tv/js/embed/v1.js';
const FOCUS_UNMUTE_VOLUME = 0.5;

let scriptPromise: Promise<void> | null = null;

export function loadTwitchEmbedScript(): Promise<void> {
  if (window.Twitch?.Player) {
    return Promise.resolve();
  }
  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Twitch embed script failed')), {
        once: true,
      });
      if (window.Twitch?.Player) resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Twitch embed script failed to load'));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

function parentDomains(): string[] {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return ['localhost', '127.0.0.1'];
  }
  return [host, '127.0.0.1'];
}

export function hostElementId(streamId: string): string {
  return `twitch-host-${streamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/**
 * Create a Twitch.Player in `host`, then force muted play on READY/ONLINE.
 * Uses laid-out pixel size (Twitch docs: ≥400×300 for reliable autoplay).
 * Never place CSS `transform` on ancestors — Twitch's visibility check fails
 * and live streams stick on click-to-play (offline UI still loads).
 * Returns null if the embed script is unavailable.
 */
export async function createTwitchPlayer(
  host: HTMLElement,
  channel: string,
  muted: boolean,
): Promise<TwitchPlayerInstance | null> {
  await loadTwitchEmbedScript();
  const Twitch = window.Twitch;
  if (!Twitch?.Player) return null;

  host.replaceChildren();

  const rect = host.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width) || 400);
  const height = Math.max(1, Math.floor(rect.height) || 300);

  const player = new Twitch.Player(host.id, {
    width,
    height,
    channel,
    parent: parentDomains(),
    autoplay: true,
    muted,
  });

  const forcePlay = (): void => {
    try {
      player.setMuted(muted);
      if (!muted) {
        player.setVolume(FOCUS_UNMUTE_VOLUME);
      }
      player.play();
    } catch {
      // Player may not accept calls until fully ready.
    }
  };

  player.addEventListener(Twitch.Player.READY, forcePlay);
  player.addEventListener(Twitch.Player.ONLINE, forcePlay);
  if (Twitch.Player.PLAYING) {
    player.addEventListener(Twitch.Player.PLAYING, forcePlay);
  }
  player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
    try {
      player.setMuted(true);
      player.play();
    } catch {
      // Ignore.
    }
  });

  // Cover late bootstrap when READY fired before listeners attached.
  window.setTimeout(forcePlay, 100);
  window.setTimeout(forcePlay, 400);
  window.setTimeout(forcePlay, 1200);
  window.setTimeout(forcePlay, 2500);

  // Twitch.Player builds an iframe — also nudge it the MultistreamGrid way.
  window.setTimeout(() => {
    const iframe = host.querySelector('iframe');
    const win = iframe?.contentWindow;
    if (!win) return;
    for (const payload of [
      { namespace: 'twitch-embed-player-proxy', eventName: 'play', params: {} },
      { eventName: 'playVideo', params: {} },
      { event: 'play' },
    ]) {
      try {
        win.postMessage(JSON.stringify(payload), 'https://player.twitch.tv');
      } catch {
        // Ignore.
      }
    }
  }, 600);

  return player;
}

export function setTwitchPlayerMuted(player: TwitchPlayerInstance, muted: boolean): void {
  try {
    player.setMuted(muted);
    if (!muted) {
      player.setVolume(FOCUS_UNMUTE_VOLUME);
    }
    player.play();
  } catch {
    // Ignore.
  }
}

export function destroyTwitchPlayer(host: HTMLElement): void {
  host.replaceChildren();
}
