export type Platform = 'twitch' | 'kick';

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
  subscribe(listener: () => void): () => void;
}
