export type Platform = 'twitch' | 'kick' | 'youtube';

/**
 * Landscape is the default for all three current platforms — Twitch/Kick/
 * YouTube live and video embeds are all 16:9 by convention. Portrait exists
 * so the grid/Focus View layout engines (src/lib/gridLayout.ts) have a real
 * signal to weight around; today the only path that ever sets it is a
 * directly-pasted YouTube Shorts URL (detected from the raw input at
 * add-stream time — see state/streams.ts's addStream). This is also the
 * capability boundary a future portrait-native provider (e.g. TikTok, if it
 * ever ships an official LIVE embed — see docs/TIKTOK.md) would plug into
 * without another layout rewrite.
 */
export type StreamOrientation = 'landscape' | 'portrait';

export interface StreamRef {
  id: string;
  platform: Platform;
  channel: string;
  muted: boolean;
  orientation: StreamOrientation;
}

export interface EmbedOptions {
  muted: boolean;
  parent: string;
  autoplay?: boolean;
  /** Full origin (scheme + host), used only by adapters that need it (YouTube). */
  origin?: string;
}

export interface PlatformAdapter {
  id: Platform;
  label: string;
  /**
   * Never returns orientation — that's derived independently in
   * state/streams.ts from the raw input string a caller still has at
   * addStream() time (see StreamOrientation's doc comment above), not from
   * the adapter's parsed platform/channel shape.
   */
  parseInput(input: string): Omit<StreamRef, 'id' | 'muted' | 'orientation'> | null;
  buildEmbedUrl(ref: Pick<StreamRef, 'platform' | 'channel'>, opts: EmbedOptions): string;
  buildChatEmbedUrl?(ref: Pick<StreamRef, 'platform' | 'channel'>, opts: EmbedOptions): string;
  displayName(ref: Pick<StreamRef, 'channel'>): string;
}

export interface StreamState {
  streams: StreamRef[];
  addStream(input: string): boolean;
  removeStream(id: string): void;
  clearStreams(): void;
  reorderStreams(ids: string[]): void;
  subscribe(listener: () => void): () => void;
}
