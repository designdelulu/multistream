/**
 * Ambient declaration for Twitch's JS Embed API (player.twitch.tv/js/embed/v1.js).
 * No @types package exists for it — only what StreamGrid.ts actually uses is declared.
 * https://dev.twitch.tv/docs/embed/video-and-clips/
 */
export {};

declare global {
  namespace Twitch {
    interface PlayerOptions {
      width: string | number;
      height: string | number;
      channel?: string;
      video?: string;
      collection?: string;
      parent?: string[];
      muted?: boolean;
      autoplay?: boolean;
    }

    /** Shape per dev.twitch.tv/docs/embed/video-and-clips — not all fields documented as guaranteed present. */
    interface PlaybackStats {
      backendVersion?: string;
      bufferSize?: number;
      codecs?: string;
      fps?: number;
      hlsLatencyBroadcaster?: number;
      playbackRate?: number;
      skippedFrames?: number;
      videoResolution?: string;
    }

    class Player {
      constructor(elementId: string, options: PlayerOptions);
      play(): void;
      pause(): void;
      isPaused(): boolean;
      setMuted(muted: boolean): void;
      getMuted(): boolean;
      setVolume(volume: number): void;
      getVolume(): number;
      setChannel(channel: string): void;
      getCurrentTime(): number;
      getPlaybackStats(): PlaybackStats;
      addEventListener(event: string, callback: () => void): void;
      removeEventListener(event: string, callback: () => void): void;
      destroy(): void;

      /**
       * PLAY fires when the player unpauses and will either start playback or
       * start buffering; PLAYING fires only once playback has actually begun.
       * PLAYING is therefore the positive confirmation to trust, and it is an
       * EDGE event — it never repeats during continuous playback, so it may
       * only ever be latched into a state, never used as "time since".
       */
      static readonly READY: string;
      static readonly PLAY: string;
      static readonly PLAYING: string;
      static readonly PAUSE: string;
      static readonly ENDED: string;
      static readonly PLAYBACK_BLOCKED: string;
      static readonly OFFLINE: string;
      static readonly ONLINE: string;
    }
  }

  interface Window {
    Twitch?: typeof Twitch;
  }
}
