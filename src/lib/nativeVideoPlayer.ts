import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface NativeVideoPlayerResult {
  result: boolean;
  method: string;
  value?: unknown;
  message?: string;
}

export interface NativeVideoSubtitle {
  url: string;
  name?: string;
  lang?: string;
}

export interface NativeVideoPlayerOptions {
  url: string;
  subtitles?: NativeVideoSubtitle[];
  preferredLocale?: string;
  subtitleOptions?: {
    foregroundColor?: string;
    backgroundColor?: string;
    fontSize?: number;
  };
  displayMode?: 'all' | 'portrait' | 'landscape';
  componentTag?: string;
  title?: string;
  smallTitle?: string;
  chromecast?: boolean;
  artwork?: string;
  subtitleTrackId?: string;
  subtitleLocale?: string;
  audioTrackId?: string;
  audioLocale?: string;
  startAtSec?: number;
  embedded?: boolean;
  hideControls?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface NativeVideoPlayerEvent {
  currentTime: number;
}

export interface NativeVideoPlayerExitEvent extends NativeVideoPlayerEvent {
  dismiss: boolean;
}

export interface NativeVideoPlayerTrackInfo {
  id: string;
  language: string;
  label: string;
  codecs: string;
  bitrate: number;
  channelCount: number;
  sampleRate: number;
  containerMimeType: string;
  sampleMimeType: string;
}

export interface NativeVideoPlayerTracksChangedEvent {
  fromPlayerId: string;
  audioTrack: NativeVideoPlayerTrackInfo;
  subtitleTrack: NativeVideoPlayerTrackInfo;
}

export interface NativeVideoPlayerPlugin {
  initPlayer(options: NativeVideoPlayerOptions): Promise<NativeVideoPlayerResult>;
  play(): Promise<NativeVideoPlayerResult>;
  pause(): Promise<NativeVideoPlayerResult>;
  getDuration(): Promise<NativeVideoPlayerResult>;
  getCurrentTime(): Promise<NativeVideoPlayerResult>;
  setCurrentTime(options: { seektime: number }): Promise<NativeVideoPlayerResult>;
  exitPlayer(): Promise<NativeVideoPlayerResult>;
  stopAllPlayers(): Promise<NativeVideoPlayerResult>;
  addListener(
    eventName: 'playerReady' | 'playerPlay' | 'playerPause' | 'playerEnded',
    listenerFunc: (event: NativeVideoPlayerEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'playerExit',
    listenerFunc: (event: NativeVideoPlayerExitEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'playerTap',
    listenerFunc: (event: NativeVideoPlayerEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'playerTracksChanged',
    listenerFunc: (event: NativeVideoPlayerTracksChangedEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const NativeVideoPlayer = registerPlugin<NativeVideoPlayerPlugin>(
  'WakoCapacitorVideoPlayer',
);
