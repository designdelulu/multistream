/**
 * Ambient declaration for YouTube's IFrame Player API
 * (www.youtube.com/iframe_api). No @types package is depended on here —
 * only what StreamGrid.ts actually uses is declared, matching the existing
 * twitch-embed.d.ts convention for the same reason (no official types
 * package for either embed API).
 * https://developers.google.com/youtube/iframe_api_reference
 */
export {};

declare global {
  namespace YT {
    interface PlayerVars {
      autoplay?: 0 | 1;
      mute?: 0 | 1;
      playsinline?: 0 | 1;
      modestbranding?: 0 | 1;
      rel?: 0 | 1;
      origin?: string;
    }

    interface OnErrorEvent {
      target: Player;
      data: number;
    }

    interface OnStateChangeEvent {
      target: Player;
      data: number;
    }

    interface PlayerEvents {
      onReady?: (event: { target: Player }) => void;
      onError?: (event: OnErrorEvent) => void;
      onStateChange?: (event: OnStateChangeEvent) => void;
    }

    interface PlayerOptions {
      width?: string | number;
      height?: string | number;
      videoId?: string;
      playerVars?: PlayerVars;
      events?: PlayerEvents;
    }

    class Player {
      constructor(elementId: string, options: PlayerOptions);
      playVideo(): void;
      pauseVideo(): void;
      mute(): void;
      unMute(): void;
      isMuted(): boolean;
      destroy(): void;
    }
  }

  interface Window {
    YT?: typeof YT;
    onYouTubeIframeAPIReady?: () => void;
  }
}
