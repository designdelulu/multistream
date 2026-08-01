export type Platform = 'twitch' | 'kick' | 'youtube';

export interface StreamRef {
  id: string;
  platform: Platform;
  channel: string;
  muted: boolean;
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
  parseInput(input: string): Omit<StreamRef, 'id' | 'muted'> | null;
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
