import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { StatusBar } from '@capacitor/status-bar';
import { LoaderCircle, X, Play, Pause, Volume2, VolumeX, FastForward, Rewind, Activity } from 'lucide-react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import type { Category, Media } from '../types';
import { useStore } from '../store/useStore';
import { NetworkDiagnostic } from './NetworkDiagnostic';
import {
  NativeVideoPlayer,
  type NativeVideoPlayerEvent,
  type NativeVideoPlayerExitEvent,
  type NativeVideoPlayerResult,
} from '../lib/nativeVideoPlayer';
import { sendPlayerTelemetryReport, type PlayerTelemetryExitReason } from '../lib/playerTelemetry';
import {
  resolvePlaybackProgressUserId,
  syncPlaybackProgressSilently,
} from '../lib/playbackProgressSync';

interface VideoPlayerProps {
  url: string;
  mediaType: string;
  media?: Media | null;
  onClose: () => void;
  onPreviewPlaybackFailed?: (failedUrl: string) => void;
  onPreviewRequestFullscreen?: () => void;
  suppressNativePreviewExitOnUnmount?: boolean;
  nextEpisode?: Media | null;
  onPlayNextEpisode?: () => void;
  isMinimized?: boolean;
  onToggleMinimize?: () => void;
  isPreview?: boolean;
  isBrowseMode?: boolean;
  showChannelSidebar?: boolean;
  channelBrowserCategories?: Category[];
  onPictureInPictureChange?: (isActive: boolean) => void;
  onZap?: (media: Media) => void;
}

export interface VideoPlayerHandle {
  enterPictureInPicture: () => Promise<boolean>;
}

type NativePlayerState = 'opening' | 'ready' | 'error';
const PLAYBACK_PROGRESS_SYNC_INTERVAL_MS = 15000;
const MIN_PROGRESS_DELTA_SECONDS = 3;

function extractStreamHost(targetUrl: string): string {
  try {
    return new URL(targetUrl).host.toLowerCase();
  } catch {
    return '';
  }
}

function readResultNumber(result: NativeVideoPlayerResult | null | undefined): number {
  const rawValue = result?.value;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return rawValue;
  }

  if (typeof rawValue === 'string') {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}

function resolvePlaybackMediaType(typeValue: string): 'movie' | 'series' {
  return typeValue === 'series' || typeValue === 'episode' ? 'series' : 'movie';
}

function buildLivePreviewUrlCandidates(streamUrl: string, isLiveStream: boolean): string[] {
  const trimmed = streamUrl.trim();
  if (!trimmed) {
    return [];
  }

  if (!isLiveStream) {
    return [trimmed];
  }

  try {
    const parsed = new URL(trimmed);
    const addUnique = (acc: string[], value: string) => {
      if (value && !acc.includes(value)) {
        acc.push(value);
      }
    };

    const lower = trimmed.toLowerCase();
    const pathLower = parsed.pathname.toLowerCase();
    const hasTsOutput =
      parsed.searchParams.get('output')?.toLowerCase() === 'ts'
      || parsed.searchParams.get('output')?.toLowerCase() === 'mpegts';
    const isTsLike =
      hasTsOutput ||
      pathLower.endsWith('.ts') ||
      pathLower.endsWith('.mpegts');

    const originalUrl = parsed.toString();
    const forcedHls = new URL(originalUrl);
    forcedHls.searchParams.set('output', 'hls');

    const removeOutput = new URL(originalUrl);
    removeOutput.searchParams.delete('output');

    const m3u8Path = new URL(originalUrl);
    // Se terminar em numero (ex: /715), tentamos /715.m3u8
    if (m3u8Path.pathname.match(/\/\d+$/)) {
      m3u8Path.pathname += '.m3u8';
    } else {
      m3u8Path.pathname = m3u8Path.pathname.replace(/\.(?:ts|mpegts)$/i, '.m3u8');
    }

    const m3u8WithHls = new URL(m3u8Path.toString());
    m3u8WithHls.searchParams.set('output', 'hls');

    const typeM3u8 = new URL(originalUrl);
    typeM3u8.searchParams.set('type', 'm3u8');

    const ordered: string[] = [];
    
    // 1. URL original pura primeiro (mpegts.js a decodifica via MSE)
    addUnique(ordered, originalUrl);
    // 2. Variações HLS como fallback (para hls.js)
    addUnique(ordered, forcedHls.toString());
    addUnique(ordered, typeM3u8.toString());
    addUnique(ordered, m3u8WithHls.toString());
    addUnique(ordered, m3u8Path.toString());
    
    if (!isTsLike) {
      addUnique(ordered, removeOutput.toString());
    }

    return ordered;
  } catch {
    return [trimmed];
  }
}

function isLikelyHlsUrl(streamUrl: string): boolean {
  try {
    const parsed = new URL(streamUrl);
    const pathLower = parsed.pathname.toLowerCase();
    const output = (parsed.searchParams.get('output') || '').toLowerCase();
    if (pathLower.endsWith('.m3u8')) return true;
    if (output === 'hls' || output === 'm3u8') return true;
    return false;
  } catch {
    const lower = streamUrl.toLowerCase();
    return lower.includes('.m3u8') || lower.includes('output=hls') || lower.includes('output=m3u8');
  }
}

/**
 * ProgressBar Component
 * Optimized with direct DOM updates via useRef to prevent re-renders on 'timeupdate'
 */
const ProgressBar = React.memo(({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement | null> }) => {
  const progressInnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateProgress = () => {
      if (progressInnerRef.current && video.duration) {
        const percent = (video.currentTime / video.duration) * 100;
        progressInnerRef.current.style.width = `${percent}%`;
      }
    };

    video.addEventListener('timeupdate', updateProgress);
    return () => video.removeEventListener('timeupdate', updateProgress);
  }, [videoRef]);

  return (
    <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden backdrop-blur-sm shadow-inner group-hover:h-2 transition-all">
      <div 
        ref={progressInnerRef} 
        className="h-full bg-red-600 shadow-[0_0_10px_rgba(220,38,38,0.5)] transition-[width] duration-150 ease-linear" 
        style={{ width: '0%' }} 
      />
    </div>
  );
});

/**
 * TimeDisplay Component
 * Optimized to track video time without triggering parent re-renders
 */
const TimeDisplay = React.memo(({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement | null> }) => {
  const timeTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const format = (s: number) => {
      if (!s || !Number.isFinite(s)) return '0:00';
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      return h > 0 
        ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
        : `${m}:${sec.toString().padStart(2, '0')}`;
    };

    const updateText = () => {
      if (timeTextRef.current) {
        timeTextRef.current.innerText = `${format(video.currentTime)} / ${format(video.duration)}`;
      }
    };

    video.addEventListener('timeupdate', updateText);
    video.addEventListener('loadedmetadata', updateText);
    return () => {
      video.removeEventListener('timeupdate', updateText);
      video.removeEventListener('loadedmetadata', updateText);
    };
  }, [videoRef]);

  return <span ref={timeTextRef} className="text-[11px] font-bold tabular-nums tracking-wider text-white/90 drop-shadow-md" />;
});

/**
 * StaticControls Component
 * Standard control buttons memoized to avoid re-renders
 */
const PlayerControlButtons = React.memo(({ 
  isPlaying, 
  onTogglePlay, 
  onClose,
  isLive 
}: { 
  isPlaying: boolean; 
  onTogglePlay: () => void; 
  onClose: () => void;
  isLive: boolean;
}) => {
  return (
    <div className="flex items-center gap-6">
      <button 
        type="button" 
        onClick={(e) => { e.stopPropagation(); onTogglePlay(); }}
        className="p-3 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-white/10"
      >
        {isPlaying ? <Pause size={24} fill="white" className="text-white" /> : <Play size={24} fill="white" className="text-white ml-0.5" />}
      </button>
      
      {!isLive && (
        <>
          <button type="button" className="p-2 text-white/60 hover:text-white transition-colors">
            <Rewind size={20} />
          </button>
          <button type="button" className="p-2 text-white/60 hover:text-white transition-colors">
            <FastForward size={20} />
          </button>
        </>
      )}

      <button 
        type="button" 
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="p-3 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-white/10 ml-auto"
      >
        <X size={24} className="text-white" />
      </button>
    </div>
  );
});

export function loadMediaStream(targetUrl: string, expectedType: 'hls' | 'dash' | 'mp4'): string {
  try {
    const parsed = new URL(targetUrl);
    if (expectedType === 'hls' && !parsed.searchParams.has('output')) {
       // Safely coerce output stream to HLS without modifying provider secrets
       if (parsed.pathname.match(/\.(ts|mpegts)$/)) {
         parsed.searchParams.set('output', 'hls');
       }
    }
    return parsed.toString();
  } catch {
    return targetUrl;
  }
}

export const VideoPlayer = React.forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  (
    {
      url,
      mediaType,
      media = null,
      onClose,
      onPreviewPlaybackFailed,
      onPreviewRequestFullscreen,
      suppressNativePreviewExitOnUnmount = false,
      isMinimized = false,
      onToggleMinimize,
      isBrowseMode = false,
      isPreview = false,
      showChannelSidebar = false,
      channelBrowserCategories,
      onPictureInPictureChange,
      onZap,
    },
    ref,
  ) => {
    const isNativePlatform = Capacitor.isNativePlatform();
    const isLiveStream = (media?.type || mediaType) === 'live';
    const shouldUseNativePlayer = isNativePlatform && !isPreview && !showChannelSidebar;
    const savePlaybackProgress = useStore((state) => state.savePlaybackProgress);
    const [isChannelBrowserOpen, setIsChannelBrowserOpen] = useState(false);
    const [channelGroupId, setChannelGroupId] = useState<string | null>(null);
    const [channelSearchQuery, setChannelSearchQuery] = useState('');
    const channelListContainerRef = useRef<HTMLDivElement | null>(null);

    const liveBrowserCategories = useMemo(() => {
      const source = Array.isArray(channelBrowserCategories) ? channelBrowserCategories : [];
      return source
        .map((category) => ({
          ...category,
          items: category.items.filter((item) => item.type === 'live' && Boolean(item.videoUrl)),
        }))
        .filter((category) => category.items.length > 0);
    }, [channelBrowserCategories]);

    useEffect(() => {
      if (!channelGroupId && liveBrowserCategories.length > 0) {
        setChannelGroupId(liveBrowserCategories[0].id);
      }
    }, [channelGroupId, liveBrowserCategories]);

    useEffect(() => {
      if (!isLiveStream || liveBrowserCategories.length === 0) {
        return;
      }

      const activeChannelKey = media?.id || url;
      if (!activeChannelKey) {
        return;
      }

      const matchingCategory = liveBrowserCategories.find((category) =>
        category.items.some((item) => item.id === media?.id || item.videoUrl === url),
      );

      if (matchingCategory && matchingCategory.id !== channelGroupId) {
        setChannelGroupId(matchingCategory.id);
      }
    }, [channelGroupId, isLiveStream, liveBrowserCategories, media?.id, url]);

    const activeBrowserCategory = useMemo(
      () => liveBrowserCategories.find((category) => category.id === channelGroupId) || liveBrowserCategories[0] || null,
      [channelGroupId, liveBrowserCategories],
    );

    const browserChannels = useMemo(() => {
      const items = activeBrowserCategory?.items || [];
      const query = channelSearchQuery.trim().toLowerCase();
      if (!query) return items;
      return items.filter((item) => item.title.toLowerCase().includes(query));
    }, [activeBrowserCategory, channelSearchQuery]);

    const canShowChannelBrowser =
      showChannelSidebar && isLiveStream && !isPreview && typeof onZap === 'function' && liveBrowserCategories.length > 0;

    useEffect(() => {
      if (!isChannelBrowserOpen || !canShowChannelBrowser) {
        return;
      }

      const container = channelListContainerRef.current;
      if (!container) {
        return;
      }

      const rafId = requestAnimationFrame(() => {
        const selectedNode = container.querySelector<HTMLButtonElement>('button[data-channel-selected="true"]');
        if (selectedNode) {
          selectedNode.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        }
      });

      return () => cancelAnimationFrame(rafId);
    }, [browserChannels.length, canShowChannelBrowser, channelGroupId, isChannelBrowserOpen, media?.id, url]);

    const [showDiagnostic, setShowDiagnostic] = useState(false);
    const [playerState, setPlayerState] = useState<NativePlayerState>(
      shouldUseNativePlayer ? 'opening' : 'error',
    );
    const [error, setError] = useState<string | null>(
      shouldUseNativePlayer ? null : 'O player nativo esta disponivel apenas no app Android/Capacitor.',
    );
    const [inlineError, setInlineError] = useState<string | null>(null);

    const listenerHandlesRef = useRef<PluginListenerHandle[]>([]);
    const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const openedPlayerRef = useRef(false);
    const handledExitRef = useRef(false);
    const lastKnownTimeRef = useRef(0);
    const durationRef = useRef(0);
    const hlsRef = useRef<Hls | null>(null);
    const mpegtsPlayerRef = useRef<mpegts.Player | null>(null);
    const previewFailureHandlerRef = useRef<((failedUrl: string) => void) | undefined>(undefined);
    const sessionStartedAtRef = useRef(Date.now());
    const sessionUserIdRef = useRef<string | null>(null);
    const lastProgressSyncAtRef = useRef(0);
    const lastProgressSyncedTimeRef = useRef(0);
    const sessionResumePositionRef = useRef(0);

    useEffect(() => {
      previewFailureHandlerRef.current = onPreviewPlaybackFailed;
    }, [onPreviewPlaybackFailed]);

    useEffect(() => {
      if (isLiveStream) {
        sessionResumePositionRef.current = 0;
        return;
      }

      const state = useStore.getState();
      const fromMediaEntry = media?.id ? state.playbackProgress[media.id]?.currentTime : undefined;
      const fromUrlEntry = state.playbackProgress[url]?.currentTime;
      const fromHistory = state.watchHistory[url];
      sessionResumePositionRef.current = Math.max(
        0,
        Math.floor(fromMediaEntry ?? fromHistory ?? fromUrlEntry ?? 0),
      );
    }, [isLiveStream, media?.id, url]);

    useEffect(() => {
      if (isLiveStream) {
        sessionUserIdRef.current = null;
        return;
      }

      let cancelled = false;
      void resolvePlaybackProgressUserId()
        .then((userId) => {
          if (!cancelled) {
            sessionUserIdRef.current = userId;
          }
        })
        .catch((syncError) => {
          if (!cancelled) {
            console.warn('[PlaybackProgress] Falha ao resolver usuario da sessao:', syncError);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [isLiveStream, media?.id, url]);

    const clearProgressPolling = useCallback(() => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    }, []);

    const removeListeners = useCallback(() => {
      const handles = listenerHandlesRef.current.splice(0);
      handles.forEach((handle) => {
        void handle.remove();
      });
    }, []);

    const syncProgressToSupabase = useCallback(
      (currentTime: number, options?: { force?: boolean }) => {
        if (isLiveStream) {
          return;
        }

        const safeCurrentTime = Math.max(0, Math.floor(currentTime));
        const now = Date.now();
        const forceSync = options?.force === true;
        const hasIntervalElapsed =
          now - lastProgressSyncAtRef.current >= PLAYBACK_PROGRESS_SYNC_INTERVAL_MS;
        const hasMeaningfulDelta =
          Math.abs(safeCurrentTime - lastProgressSyncedTimeRef.current) >=
          MIN_PROGRESS_DELTA_SECONDS;

        if (!forceSync && (!hasIntervalElapsed || !hasMeaningfulDelta)) {
          return;
        }

        lastProgressSyncAtRef.current = now;
        lastProgressSyncedTimeRef.current = safeCurrentTime;

        const emitSync = (userId: string) => {
          syncPlaybackProgressSilently({
            user_id: userId,
            media_id: media?.id || url,
            media_title: media?.title || 'Unknown',
            media_type: resolvePlaybackMediaType(media?.type || mediaType),
            current_time: safeCurrentTime,
            duration: durationRef.current,
          }, forceSync);
        };

        const userId = sessionUserIdRef.current;
        if (userId) {
          emitSync(userId);
          return;
        }

        void resolvePlaybackProgressUserId()
          .then((resolvedUserId) => {
            if (!resolvedUserId) {
              return;
            }

            sessionUserIdRef.current = resolvedUserId;
            emitSync(resolvedUserId);
          })
          .catch((syncError) => {
            console.warn('[PlaybackProgress] Falha ao resolver usuario para sincronizacao:', syncError);
          });
      },
      [isLiveStream, media?.id, media?.type, mediaType, url],
    );

    const persistProgress = useCallback(
      (currentTime: number, duration?: number) => {
        if (isLiveStream) {
          return;
        }

        const safeCurrentTime = Math.max(0, Math.floor(currentTime));
        const safeDuration =
          typeof duration === 'number' && duration > 0
            ? Math.floor(duration)
            : Math.max(0, Math.floor(durationRef.current));

        lastKnownTimeRef.current = safeCurrentTime;
        durationRef.current = safeDuration;

        savePlaybackProgress({
          mediaId: media?.id,
          url,
          currentTime: safeCurrentTime,
          duration: safeDuration,
        });
        syncProgressToSupabase(safeCurrentTime);
      },
      [isLiveStream, media?.id, savePlaybackProgress, syncProgressToSupabase, url],
    );

    const syncProgressFromNativePlayer = useCallback(async () => {
      if (!openedPlayerRef.current || isLiveStream) {
        return;
      }

      try {
        const [currentTimeResult, durationResult] = await Promise.all([
          NativeVideoPlayer.getCurrentTime(),
          NativeVideoPlayer.getDuration(),
        ]);

        persistProgress(
          readResultNumber(currentTimeResult),
          readResultNumber(durationResult),
        );
      } catch (syncError) {
        console.warn('[NativePlayer] Falha ao sincronizar o progresso:', syncError);
      }
    }, [isLiveStream, persistProgress]);

    const restoreSystemUi = useCallback(async () => {
      if (!shouldUseNativePlayer) {
        return;
      }

      try {
        await ScreenOrientation.unlock();
      } catch (orientationError) {
        console.warn('[NativePlayer] Falha ao liberar orientacao:', orientationError);
      }

      try {
        await StatusBar.hide();
      } catch (statusBarError) {
        console.warn('[NativePlayer] Falha ao manter a status bar oculta:', statusBarError);
      }

      onPictureInPictureChange?.(false);
    }, [onPictureInPictureChange, shouldUseNativePlayer]);

    const prepareSystemUi = useCallback(async () => {
      if (!shouldUseNativePlayer) {
        return;
      }

      try {
        await ScreenOrientation.lock({ orientation: 'landscape' });
      } catch (orientationError) {
        console.warn('[NativePlayer] Falha ao travar orientacao:', orientationError);
      }

      try {
        await StatusBar.hide();
      } catch (statusBarError) {
        console.warn('[NativePlayer] Falha ao ocultar a status bar:', statusBarError);
      }

      onPictureInPictureChange?.(false);
    }, [onPictureInPictureChange, shouldUseNativePlayer]);

    const flushTelemetry = useCallback(
      (exitReason: PlayerTelemetryExitReason, currentTime = lastKnownTimeRef.current) => {
        const sessionSeconds = Math.max(
          1,
          Math.round((Date.now() - sessionStartedAtRef.current) / 1000),
        );

        sendPlayerTelemetryReport({
          mediaId: media?.id || url,
          mediaTitle: media?.title || 'Midia sem titulo',
          mediaCategory: media?.category || '',
          mediaType: media?.type || mediaType,
          streamHost: extractStreamHost(url),
          strategy: 'native-player',
          sessionSeconds,
          watchSeconds: isLiveStream ? sessionSeconds : Math.max(0, Math.round(currentTime)),
          bufferSeconds: 0,
          bufferEventCount: 0,
          stallRecoveryCount: 0,
          errorRecoveryCount: 0,
          endedRecoveryCount: exitReason === 'unmount' ? 0 : 0,
          manualRetryCount: 0,
          qualityFallbackCount: 0,
          fatalErrorCount: exitReason === 'fatal_error' ? 1 : 0,
          sampled: true,
          exitReason,
        });
      },
      [isLiveStream, media?.category, media?.id, media?.title, media?.type, mediaType, url],
    );

    const handlePlayerEvent = useCallback(
      (event: NativeVideoPlayerEvent) => {
        setPlayerState('ready');

        if (!isLiveStream) {
          persistProgress(event.currentTime);
        }
      },
      [isLiveStream, persistProgress],
    );

    const handlePlayerExit = useCallback(
      async (event: NativeVideoPlayerExitEvent) => {
        // Evita fechar o fullscreen por eventos residuais de saida da previa embutida.
        if (!openedPlayerRef.current) {
          return;
        }

        if (handledExitRef.current) {
          return;
        }

        handledExitRef.current = true;
        openedPlayerRef.current = false;
        clearProgressPolling();
        removeListeners();

        persistProgress(event.currentTime, durationRef.current);
        syncProgressToSupabase(event.currentTime, { force: true });
        flushTelemetry(event.dismiss ? 'close' : 'unmount', event.currentTime);
        await restoreSystemUi();
        onClose();
      },
      [
        clearProgressPolling,
        flushTelemetry,
        onClose,
        persistProgress,
        removeListeners,
        restoreSystemUi,
        syncProgressToSupabase,
      ],
    );

    const closeNativePlayer = useCallback(async () => {
      if (!openedPlayerRef.current) {
        syncProgressToSupabase(lastKnownTimeRef.current, { force: true });
        onClose();
        return;
      }

      try {
        await NativeVideoPlayer.exitPlayer();
      } catch (closeError) {
        console.warn('[NativePlayer] Falha ao fechar o player nativo:', closeError);
        handledExitRef.current = true;
        openedPlayerRef.current = false;
        clearProgressPolling();
        removeListeners();
        await syncProgressFromNativePlayer();
        syncProgressToSupabase(lastKnownTimeRef.current, { force: true });
        flushTelemetry('close');
        await restoreSystemUi();
        onClose();
      }
    }, [
      clearProgressPolling,
      flushTelemetry,
      onClose,
      removeListeners,
      restoreSystemUi,
      syncProgressFromNativePlayer,
      syncProgressToSupabase,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        enterPictureInPicture: async () => false,
      }),
      [],
    );

    const [isControlsVisible, setIsControlsVisible] = useState(true);
    const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showControls = useCallback(() => {
      setIsControlsVisible(true);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = setTimeout(() => setIsControlsVisible(false), 3000);
    }, []);

    useEffect(() => {
      return () => {
        if (controlsTimerRef.current) {
          clearTimeout(controlsTimerRef.current);
          controlsTimerRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      if (isPreview || isMinimized) {
        return;
      }
      // Start auto-hide countdown as soon as fullscreen opens/changes media.
      showControls();
    }, [isMinimized, isPreview, showControls, url]);

    useEffect(() => {
      if (!canShowChannelBrowser) {
        return;
      }

      if (isChannelBrowserOpen) {
        setIsControlsVisible(true);
        if (controlsTimerRef.current) {
          clearTimeout(controlsTimerRef.current);
          controlsTimerRef.current = null;
        }
        return;
      }

      showControls();
    }, [canShowChannelBrowser, isChannelBrowserOpen, showControls]);

    const [isPlaying, setIsPlaying] = useState(true);

    const togglePlayPause = useCallback(async () => {
      const isNative = shouldUseNativePlayer;
      if (isNative) {
        if (!openedPlayerRef.current) return;
        try {
          if (isPlaying) {
             await NativeVideoPlayer.pause();
             syncProgressToSupabase(lastKnownTimeRef.current, { force: true });
          } else {
             await NativeVideoPlayer.play();
          }
          setIsPlaying(!isPlaying);
        } catch (error) {
          console.warn('[VideoPlayer] Falha ao alternar play/pause no player nativo:', error);
        }
      } else {
        const video = previewVideoRef.current;
        if (video) {
          if (video.paused) {
            void video.play();
            setIsPlaying(true);
          } else {
            video.pause();
            syncProgressToSupabase(video.currentTime, { force: true });
            setIsPlaying(false);
          }
        }
      }
      showControls();
    }, [isPlaying, shouldUseNativePlayer, showControls]);

    const handleZap = useCallback((direction: 'next' | 'prev') => {
      if (!isLiveStream || isPreview) return;

      const sourceCategories =
        channelBrowserCategories && channelBrowserCategories.length > 0
          ? channelBrowserCategories
          : [
              {
                id: 'visible-live',
                title: 'Visible',
                type: 'live',
                items: useStore.getState().visibleItems,
              } as Category,
            ];

      const seen = new Set<string>();
      const allLiveChannels = sourceCategories
        .filter((category) =>
          category.type === 'live' || category.items.some((item) => item.type === 'live'),
        )
        .flatMap((category) => category.items)
        .filter((item) => item.type === 'live' && Boolean(item.videoUrl))
        .filter((item) => {
          const key = `${item.id}::${item.videoUrl}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      
      const currentIndex = allLiveChannels.findIndex(i => i.id === media?.id || i.videoUrl === url);
      if (currentIndex === -1) return;

      let nextIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
      if (nextIndex >= allLiveChannels.length) nextIndex = 0;
      if (nextIndex < 0) nextIndex = allLiveChannels.length - 1;

      const nextMedia = allLiveChannels[nextIndex];
      if (nextMedia && nextMedia.videoUrl) {
         if (onZap) {
           onZap(nextMedia);
         } else {
           onClose();
         }
      }
    }, [channelBrowserCategories, isLiveStream, isPreview, media?.id, onClose, onZap, url]);

    // Internal TV key listener
    useEffect(() => {
      if (isPreview || !shouldUseNativePlayer) return;

      const handleTvKey = (e: KeyboardEvent) => {
        const key = e.key;
        const keyCode = (e as any).keyCode;
        
        showControls();

        if (key === 'Enter' || key === 'OK' || keyCode === 23) {
          void togglePlayPause();
        } else if (key === 'ArrowUp' || keyCode === 19) {
          handleZap('prev');
          e.preventDefault();
        } else if (key === 'ArrowDown' || keyCode === 20) {
          handleZap('next');
          e.preventDefault();
        } else if (key === 'Escape' || key === 'Back' || keyCode === 4 || keyCode === 27) {
          void closeNativePlayer();
          e.preventDefault();
        }
      };

      window.addEventListener('keydown', handleTvKey);
      return () => window.removeEventListener('keydown', handleTvKey);
    }, [closeNativePlayer, handleZap, isPreview, shouldUseNativePlayer, showControls, togglePlayPause]);

    // Web fullscreen live: abrir navegador de canais com seta esquerda (Android TV)
    useEffect(() => {
      if (isPreview || shouldUseNativePlayer || !canShowChannelBrowser) {
        return;
      }

      const handleWebLiveKey = (event: KeyboardEvent) => {
        const key = event.key;
        const keyCode = (event as any).keyCode;
        const target = event.target as HTMLElement | null;
        const isTypingTarget =
          target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;

        if (isTypingTarget) {
          return;
        }

        if (key === 'ArrowLeft' || keyCode === 21) {
          setIsChannelBrowserOpen(true);
          showControls();
          event.preventDefault();
          return;
        }

        if (key === 'ArrowRight' || keyCode === 22) {
          if (isChannelBrowserOpen) {
            setIsChannelBrowserOpen(false);
            showControls();
            event.preventDefault();
          }
        }
      };

      window.addEventListener('keydown', handleWebLiveKey);
      return () => window.removeEventListener('keydown', handleWebLiveKey);
    }, [canShowChannelBrowser, isChannelBrowserOpen, isPreview, shouldUseNativePlayer, showControls]);

    useEffect(() => {
      if (!shouldUseNativePlayer) {
        return;
      }

      let cancelled = false;

      const setupNativePlayer = async () => {
        const sessionResumePosition = sessionResumePositionRef.current;
        handledExitRef.current = false;
        openedPlayerRef.current = false;
        sessionStartedAtRef.current = Date.now();
        lastKnownTimeRef.current = sessionResumePosition;
        durationRef.current = 0;
        lastProgressSyncAtRef.current = 0;
        lastProgressSyncedTimeRef.current = sessionResumePosition;
        setError(null);
        setPlayerState('opening');

        try {
          listenerHandlesRef.current = [
            await NativeVideoPlayer.addListener('playerReady', handlePlayerEvent),
            await NativeVideoPlayer.addListener('playerPlay', handlePlayerEvent),
            await NativeVideoPlayer.addListener('playerPause', handlePlayerEvent),
            await NativeVideoPlayer.addListener('playerEnded', handlePlayerEvent),
            await NativeVideoPlayer.addListener('playerExit', (event) => {
              void handlePlayerExit(event);
            }),
          ];

          await prepareSystemUi();

          // Ensure no other player is lingering before starting
          try {
            await NativeVideoPlayer.stopAllPlayers().catch(() => {});
          } catch (error) {
            console.warn('[VideoPlayer] Falha ao garantir stopAllPlayers antes de init:', error);
          }

          const secureStreamUrl = loadMediaStream(url, media?.type === 'series' ? 'mp4' : 'hls');

          const result = await NativeVideoPlayer.initPlayer({
            url: secureStreamUrl,
            title: media?.title || 'Xandeflix',
            smallTitle: media?.category || '',
            artwork: media?.thumbnail || media?.backdrop || '',
            chromecast: false,
            displayMode: 'landscape',
            startAtSec: !isLiveStream && sessionResumePosition > 5 ? sessionResumePosition : 0,
          });

          if (cancelled) {
            // Se foi cancelado durante o await, o unmount já rodou sem fechar o player, então fechamos aqui.
            if (result.result) {
              void NativeVideoPlayer.exitPlayer().catch(() => {});
            }
            return;
          }

          if (!result.result) {
            throw new Error(result.message || 'Falha ao abrir o player nativo.');
          }

          openedPlayerRef.current = true;
          setPlayerState('ready');

          if (!isLiveStream) {
            progressIntervalRef.current = setInterval(() => {
              void syncProgressFromNativePlayer();
            }, 5000);
          }
        } catch (playerError) {
          if (cancelled) {
            void NativeVideoPlayer.exitPlayer().catch(() => {});
            return;
          }

          console.error('[NativePlayer] Falha ao iniciar o player nativo:', playerError);
          removeListeners();
          clearProgressPolling();
          await restoreSystemUi();
          setPlayerState('error');
          setError(normalizeErrorMessage(playerError, 'Falha ao abrir o player nativo.'));
          flushTelemetry('fatal_error');
        }
      };

      void setupNativePlayer();

      return () => {
        cancelled = true;
        clearProgressPolling();
        removeListeners();

        if (!openedPlayerRef.current || handledExitRef.current) {
          return;
        }

        handledExitRef.current = true;
        openedPlayerRef.current = false;

        void syncProgressFromNativePlayer()
          .catch(() => {})
          .finally(() => {
            syncProgressToSupabase(lastKnownTimeRef.current, { force: true });
            flushTelemetry('unmount');
            void restoreSystemUi();
            void NativeVideoPlayer.exitPlayer().catch(() => {});
          });
      };
    }, [
      clearProgressPolling,
      flushTelemetry,
      handlePlayerEvent,
      handlePlayerExit,
      isLiveStream,
      shouldUseNativePlayer,
      media?.backdrop,
      media?.category,
      media?.thumbnail,
      media?.title,
      prepareSystemUi,
      removeListeners,
      restoreSystemUi,
      syncProgressFromNativePlayer,
      syncProgressToSupabase,
      url,
    ]);

    const previewHostRef = useRef<HTMLDivElement>(null);
    const previewVideoRef = useRef<HTMLVideoElement>(null);
    const latestPreviewUrlRef = useRef(url);
    const suppressNativePreviewExitOnUnmountRef = useRef(suppressNativePreviewExitOnUnmount);
    latestPreviewUrlRef.current = url;
    suppressNativePreviewExitOnUnmountRef.current = suppressNativePreviewExitOnUnmount;

    useEffect(() => {
      // O plugin wako-capacitor-video-player não suporta "embedded: true" de verdade no Android.
      // Ele abre forçadamente uma Activity em tela cheia. Para previews inline, NÃO podemos usá-lo.
      return;
    }, [
      isNativePlatform,
      isPreview,
      media?.backdrop,
      media?.category,
      media?.thumbnail,
      media?.title,
      onPreviewRequestFullscreen,
      removeListeners,
      url,
    ]);

    useEffect(() => {
      // Web preview/web player: Usar sempre em navegadores, mas no Android Nativo usar APENAS para os Previews Inline.
      // O player full screen no Android Nativo continua usando o NativeVideoPlayer.
      if (shouldUseNativePlayer) return;

      const video = previewVideoRef.current;
      if (!video) return;

      const secureWebUrl = loadMediaStream(url, 'hls');
      const candidates = buildLivePreviewUrlCandidates(secureWebUrl, isLiveStream);
      if (candidates.length === 0) return;

      let candidateIndex = 0;
      let disposed = false;
      let failureNotified = false;
      let startupTimeoutId: ReturnType<typeof setTimeout> | null = null;
      let loadedMetadataHandler: (() => void) | null = null;
      let canPlayHandler: (() => void) | null = null;
      let playingHandler: (() => void) | null = null;
      let nativeErrorHandler: (() => void) | null = null;
      let timeUpdateHandler: (() => void) | null = null;
      let endedHandler: (() => void) | null = null;
      let hlsManifestParsedHandler: (() => void) | null = null;
      let hlsErrorHandler: ((event: string, data: any) => void) | null = null;
      let stallWatchdogId: ReturnType<typeof setInterval> | null = null;
      let lastLiveProgressAt = Date.now();
      let lastObservedLiveTime = 0;
      let liveRecoveryAttempts = 0;

      const clearStartupTimeout = () => {
        if (startupTimeoutId) {
          clearTimeout(startupTimeoutId);
          startupTimeoutId = null;
        }
      };

      const clearStallWatchdog = () => {
        if (stallWatchdogId) {
          clearInterval(stallWatchdogId);
          stallWatchdogId = null;
        }
      };

      const notifyPreviewFailure = (failedUrl: string) => {
        console.error(`[VideoPlayer-Preview] FALHA CRITICA na URL: ${failedUrl}`);
        if (failureNotified || !isPreview) return;
        failureNotified = true;
        previewFailureHandlerRef.current?.(failedUrl);
      };

      const destroyHlsInstance = () => {
        const hls = hlsRef.current;
        if (!hls) {
          return;
        }

        if (hlsManifestParsedHandler) {
          hls.off(Hls.Events.MANIFEST_PARSED, hlsManifestParsedHandler);
          hlsManifestParsedHandler = null;
        }

        if (hlsErrorHandler) {
          hls.off(Hls.Events.ERROR, hlsErrorHandler);
          hlsErrorHandler = null;
        }

        // STRICT ORDER: stopLoad -> detachMedia -> destroy (Passthrough flush)
        hls.stopLoad();
        hls.detachMedia();
        if (hls.media) {
          hls.media.pause();
          hls.media.removeAttribute('src');
          hls.media.load();
        }
        hls.destroy();
        hlsRef.current = null;
      };

      const destroyMpegtsInstance = () => {
        const player = mpegtsPlayerRef.current;
        if (!player) return;
        try {
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch (e) {
          console.warn('[mpegts] Erro ao destruir instancia:', e);
        }
        mpegtsPlayerRef.current = null;
      };

      const removeVideoEventListeners = () => {
        if (loadedMetadataHandler) {
          video.removeEventListener('loadedmetadata', loadedMetadataHandler);
          loadedMetadataHandler = null;
        }

        if (canPlayHandler) {
          video.removeEventListener('canplay', canPlayHandler);
          canPlayHandler = null;
        }

        if (playingHandler) {
          video.removeEventListener('playing', playingHandler);
          playingHandler = null;
        }

        if (nativeErrorHandler) {
          video.removeEventListener('error', nativeErrorHandler);
          nativeErrorHandler = null;
        }

        if (timeUpdateHandler) {
          video.removeEventListener('timeupdate', timeUpdateHandler);
          timeUpdateHandler = null;
        }

        if (endedHandler) {
          video.removeEventListener('ended', endedHandler);
          endedHandler = null;
        }
      };

      const releaseHtml5Video = () => {
        // STRICT HTML5 CLEANUP: pause -> remove src -> flush internal buffers -> load
        video.pause();
        video.removeAttribute('src');
        video.srcObject = null;
        video.load();
      };

      const teardownCurrentSource = () => {
        clearStartupTimeout();
        clearStallWatchdog();
        removeVideoEventListeners();
        destroyMpegtsInstance();
        destroyHlsInstance();
        releaseHtml5Video();
      };

      const startLiveStallWatchdog = () => {
        clearStallWatchdog();
        if (!isLiveStream) {
          return;
        }

        lastLiveProgressAt = Date.now();
        lastObservedLiveTime = video.currentTime || 0;

        stallWatchdogId = setInterval(() => {
          if (disposed || video.paused || video.ended) {
            return;
          }

          const currentTime = video.currentTime || 0;
          const readyState = video.readyState;
          const hasTimeAdvanced = currentTime > lastObservedLiveTime + 0.01;

          if (hasTimeAdvanced || readyState >= 3) {
            lastObservedLiveTime = currentTime;
            lastLiveProgressAt = Date.now();
            liveRecoveryAttempts = 0;
            return;
          }

          if (Date.now() - lastLiveProgressAt < 12000) {
            return;
          }

          if (liveRecoveryAttempts >= 3) {
            console.error('[Live-Stall] Tentativas maximas de recuperacao atingidas para este canal.');
            setInlineError('Sinal instavel: aguardando reconexao...');
            lastLiveProgressAt = Date.now();
            return;
          }

          liveRecoveryAttempts += 1;
          console.warn(`[Live-Stall] Stream congelada. Reiniciando canal (tentativa ${liveRecoveryAttempts})...`);
          setInlineError('Reconectando canal...');
          playCurrentSource();
        }, 2000);
      };

      const playCurrentSource = () => {
        if (disposed) return;
        setInlineError(null);

        teardownCurrentSource();
        const currentUrl = candidates[candidateIndex];
        console.log(`[VideoPlayer-Preview] Tentando carregar candidato [${candidateIndex}]: ${currentUrl}`);
        startupTimeoutId = setTimeout(() => {
          if (disposed) return;
          if (candidateIndex + 1 < candidates.length) {
            candidateIndex += 1;
            playCurrentSource();
          } else {
            console.error('[Preview] Timeout para iniciar stream:', currentUrl);
            setInlineError('Timeout de Conexão');
            notifyPreviewFailure(currentUrl);
          }
        }, isPreview ? 15000 : 20000); // Aumentado de 4s para 15s para dar tempo ao IPTV bufferizar

        const canUseNativeHlsTag = video.canPlayType('application/vnd.apple.mpegurl') !== '';
        const shouldUseHls = isLikelyHlsUrl(currentUrl);
        
        const isSportsChannel = isLiveStream && (
          media?.category?.toLowerCase().includes('esporte') ||
          media?.category?.toLowerCase().includes('sport') ||
          media?.category?.toLowerCase().includes('futebol') ||
          media?.title?.toLowerCase().includes('esporte') ||
          media?.title?.toLowerCase().includes('sport') ||
          media?.title?.toLowerCase().includes('premiere') ||
          media?.title?.toLowerCase().includes('espn') ||
          media?.title?.toLowerCase().includes('combate')
        );

        if (shouldUseHls && Hls.isSupported()) {
          const hls = new Hls({
            startLevel: -1,
            debug: false,
            enableWorker: true,
            lowLatencyMode: false, // Desativado para priorizar estabilidade sobre latência
            backBufferLength: 30, // Manter 30s no buffer traseiro para replays rápidos
            maxBufferLength: isSportsChannel ? 120 : (isLiveStream ? 30 : 60), // 120s para Esportes, 30s para Live normal, 60s para VOD
            maxMaxBufferLength: isSportsChannel ? 240 : (isLiveStream ? 60 : 180), // Limite máximo tolerado
            maxBufferSize: isSportsChannel ? 200 * 1024 * 1024 : (isLiveStream ? 60 * 1024 * 1024 : 150 * 1024 * 1024), // 200MB para esportes
            manifestLoadingTimeOut: 15000,
            levelLoadingTimeOut: 15000,
            fragLoadingTimeOut: 15000,
          });
          
          hlsRef.current = hls;

          hls.loadSource(currentUrl);
          hls.attachMedia(video);

          hlsManifestParsedHandler = () => {
            clearStartupTimeout();
            void video.play().catch((playError) => {
              console.error('[Preview] Erro ao iniciar play:', playError);
            });
            startLiveStallWatchdog();
          };
          hls.on(Hls.Events.MANIFEST_PARSED, hlsManifestParsedHandler);

          hlsErrorHandler = (_event, data) => {
            if (disposed || !data.fatal) return;

            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.warn('[HLS] Falha de rede irrecuperável, tentando proxima fonte...', data);
                if (candidateIndex + 1 < candidates.length) {
                  candidateIndex += 1;
                  playCurrentSource();
                } else {
                  hls.startLoad();
                }
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.warn('[HLS] Erro de mídia fatal detectado, tentando recuperar buffers...', data);
                hls.recoverMediaError();
                break;
              default:
                console.error('[HLS] Erro fatal desconhecido, falhando para o próximo candidato.', data);
                if (candidateIndex + 1 < candidates.length) {
                  candidateIndex += 1;
                  playCurrentSource();
                } else {
                  clearStartupTimeout();
                  console.error('[HLS] Nenhum fallback disponível para:', currentUrl, data);
                  setInlineError(`Erro no HLS (${data.type})`);
                  notifyPreviewFailure(currentUrl);
                }
                break;
            }
          };
          hls.on(Hls.Events.ERROR, hlsErrorHandler);

          return;
        }

        // MPEGTS.JS: Para streams MPEG-TS puros (URLs sem .m3u8, sem output=hls)
        // Isso resolve o MediaError 4 no Android WebView
        const isRawTsStream = !shouldUseHls && isLiveStream && mpegts.isSupported();
        if (isRawTsStream) {
          console.log(`[mpegts.js] Tentando decodificar stream TS puro: ${currentUrl}`);
          try {
            const player = mpegts.createPlayer({
              type: 'mpegts',
              isLive: isLiveStream,
              url: currentUrl,
            }, {
              enableWorker: true,
              liveBufferLatencyChasing: false, // Desativado: evita pulos (stuttering) para alcançar o "ao vivo"
              liveBufferLatencyMaxLatency: isSportsChannel ? 30 : 15, // Tolera até 30s de atraso em esportes antes de pular
              liveBufferLatencyMinRemain: 5.0, // Mantém no mínimo 5s de buffer seguro para esportes
              lazyLoad: false,
              lazyLoadMaxDuration: isSportsChannel ? 120 : (isLiveStream ? 30 : 120), // Cache de 120s para Esportes
              lazyLoadRecoverDuration: isSportsChannel ? 60 : (isLiveStream ? 15 : 60),
            });

            mpegtsPlayerRef.current = player;
            player.attachMediaElement(video);
            player.load();

            player.on(mpegts.Events.ERROR, (errorType: string, errorDetail: string, errorInfo: any) => {
              console.error(`[mpegts.js] Erro: type=${errorType}, detail=${errorDetail}`, errorInfo);
              if (candidateIndex + 1 < candidates.length) {
                candidateIndex += 1;
                playCurrentSource();
              } else {
                clearStartupTimeout();
                setInlineError('Sinal Incompatível com Preview');
                notifyPreviewFailure(currentUrl);
              }
            });

            // Quando o MediaSource receber dados, tentar play
            loadedMetadataHandler = () => {
              clearStartupTimeout();
              void video.play().catch((e) => console.warn('[mpegts] play() rejeitado:', e));
            };
            playingHandler = () => {
              clearStartupTimeout();
              startLiveStallWatchdog();
            };
            timeUpdateHandler = () => {
              lastKnownTimeRef.current = Math.max(0, Math.floor(video.currentTime || 0));
              lastObservedLiveTime = video.currentTime || 0;
              lastLiveProgressAt = Date.now();
            };

            video.addEventListener('loadedmetadata', loadedMetadataHandler);
            video.addEventListener('playing', playingHandler);
            video.addEventListener('timeupdate', timeUpdateHandler);

            void video.play().catch(() => {});
            return;
          } catch (mpegtsError) {
            console.warn('[mpegts.js] Falha ao inicializar, tentando fallback nativo:', mpegtsError);
            destroyMpegtsInstance();
          }
        }

        if (shouldUseHls && !canUseNativeHlsTag) {
          console.warn('[Preview] WebView sem suporte nativo HLS, tentando source direta:', currentUrl);
        }

        video.src = currentUrl;

        const tryStartPlayback = (eventName: string) => {
          clearStartupTimeout();
          void video.play().catch((playError) => {
            console.error(`[Preview] Erro ao iniciar play (${eventName}):`, playError);
          });
        };

        loadedMetadataHandler = () => {
          tryStartPlayback('loadedmetadata');
        };
        canPlayHandler = () => {
          tryStartPlayback('canplay');
        };
        playingHandler = () => {
          clearStartupTimeout();
          startLiveStallWatchdog();
        };
        nativeErrorHandler = () => {
          const err = video.error;
          console.error(`[Preview] MediaError nativo: code=${err?.code}, msg=${err?.message} url=${currentUrl}`);
          if (candidateIndex + 1 < candidates.length) {
            candidateIndex += 1;
            playCurrentSource();
          } else {
            clearStartupTimeout();
            console.error('[Preview] Erro nativo de video sem fallback:', currentUrl);
            
            let errorMsg = `Sinal Incompatível (Err: ${err?.code || 'Desconhecido'})`;
            if (err?.code === 4) {
              errorMsg = "Sinal Incompatível com Preview";
            }
            
            setInlineError(errorMsg);
            notifyPreviewFailure(currentUrl);
          }
        };
        timeUpdateHandler = () => {
          lastKnownTimeRef.current = Math.max(0, Math.floor(video.currentTime || 0));
          lastObservedLiveTime = video.currentTime || 0;
          lastLiveProgressAt = Date.now();
        };
        endedHandler = () => {
          clearStartupTimeout();
          clearStallWatchdog();
        };

        video.addEventListener('loadedmetadata', loadedMetadataHandler);
        video.addEventListener('canplay', canPlayHandler);
        video.addEventListener('playing', playingHandler);
        video.addEventListener('error', nativeErrorHandler);
        video.addEventListener('timeupdate', timeUpdateHandler);
        video.addEventListener('ended', endedHandler);
      };

      playCurrentSource();

      return () => {
        disposed = true;
        clearStartupTimeout();
        clearStallWatchdog();
        removeVideoEventListeners();
        destroyMpegtsInstance();
        destroyHlsInstance();
        releaseHtml5Video();
      };
    }, [isLiveStream, shouldUseNativePlayer, url]);

    if (shouldUseNativePlayer) {
      if (error) {
        return (
          <div className="fixed inset-0 z-[1600] flex items-center justify-center bg-black/90 px-6 text-white">
            <div className="w-full max-w-md rounded-3xl border border-white/10 bg-neutral-950 p-6 shadow-2xl">
              <div className="mb-3 text-xs font-black uppercase tracking-[0.3em] text-red-500">
                Player Nativo
              </div>
              <h2 className="text-2xl font-black tracking-tight">
                {media?.title || 'Falha na reprodução'}
              </h2>
              <p className="mt-3 text-sm text-white/70">{error}</p>
              <div className="mt-6 flex gap-3">
                <button
                  type="button"
                  onClick={() => onClose()}
                  className="inline-flex min-h-11 flex-1 items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 text-sm font-bold text-white transition hover:bg-white/10"
                >
                  <X className="mr-2 h-4 w-4" />
                  Fechar
                </button>
                <button
                  type="button"
                  onClick={() => setShowDiagnostic(true)}
                  className="inline-flex min-h-11 flex-1 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10 px-4 text-sm font-bold text-red-400 transition hover:bg-red-500/20"
                >
                  <Activity className="mr-2 h-4 w-4" />
                  Diagnóstico
                </button>
              </div>
            </div>
          </div>
        );
      }

      if (isBrowseMode) {
        return (
          <div className="fixed inset-0 z-[1700] flex pointer-events-none">
            <div className="absolute left-4 top-4 pointer-events-auto rounded-2xl border border-white/10 bg-black/70 px-4 py-3 text-white backdrop-blur-xl">
              <div className="text-[10px] font-black uppercase tracking-[0.28em] text-red-500">
                Fullscreen Live
              </div>
              <div className="mt-1 truncate text-lg font-bold">{media?.title || 'Reproduzindo canal'}</div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsChannelBrowserOpen((prev) => !prev)}
                  className="pointer-events-auto inline-flex min-h-9 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/15 px-3 text-xs font-black uppercase tracking-wider text-red-200"
                >
                  {isChannelBrowserOpen ? 'Ocultar Canais' : 'Abrir Canais'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void closeNativePlayer();
                  }}
                  className="pointer-events-auto inline-flex min-h-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-black uppercase tracking-wider text-white"
                >
                  Fechar
                </button>
              </div>
            </div>

            {canShowChannelBrowser && isChannelBrowserOpen && (
              <div className="pointer-events-auto h-full w-[460px] border-r border-white/10 bg-black/86 backdrop-blur-xl">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-4">
                  <div className="text-sm font-black uppercase tracking-[0.2em] text-red-500">Canais</div>
                  <button
                    type="button"
                    onClick={() => setIsChannelBrowserOpen(false)}
                    className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs font-bold text-white/85"
                  >
                    Fechar
                  </button>
                </div>
                <div className="grid h-[calc(100%-64px)] grid-cols-[170px_1fr]">
                  <div className="overflow-y-auto border-r border-white/10 p-2">
                    {liveBrowserCategories.map((category) => {
                      const selected = (activeBrowserCategory?.id || '') === category.id;
                      return (
                        <button
                          key={`native-live-cat-${category.id}`}
                          type="button"
                          onClick={() => {
                            setChannelGroupId(category.id);
                            setChannelSearchQuery('');
                          }}
                          className="mb-2 w-full rounded-lg px-2 py-2 text-left text-[11px] font-bold uppercase tracking-wide"
                          style={{
                            color: selected ? '#fff' : 'rgba(255,255,255,0.72)',
                            background: selected ? 'rgba(229,9,20,0.22)' : 'transparent',
                            border: selected ? '1px solid rgba(229,9,20,0.45)' : '1px solid transparent',
                          }}
                        >
                          {category.title}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex h-full min-h-0 flex-col p-2">
                    <input
                      value={channelSearchQuery}
                      onChange={(event) => setChannelSearchQuery(event.target.value)}
                      placeholder="Buscar canal"
                      className="mb-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-white outline-none"
                    />
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      {browserChannels.map((channel) => {
                        const selected = channel.id === media?.id || channel.videoUrl === url;
                        return (
                          <button
                            key={`native-live-channel-${channel.id}`}
                            type="button"
                            onClick={() => {
                              onZap?.(channel);
                              setIsChannelBrowserOpen(false);
                            }}
                            className="mb-2 w-full rounded-lg px-3 py-2 text-left"
                            style={{
                              background: selected ? 'rgba(229,9,20,0.18)' : 'rgba(255,255,255,0.04)',
                              border: selected ? '1px solid rgba(229,9,20,0.5)' : '1px solid rgba(255,255,255,0.1)',
                            }}
                          >
                            <div className="truncate text-sm font-bold text-white">{channel.title}</div>
                            <div className="truncate text-[11px] font-semibold text-white/50">{channel.category}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      }

      return null;
    }

    const fallbackPoster = media?.backdrop || media?.thumbnail || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

    return (
      <>
      <div
        ref={previewHostRef}
        onClick={() => {
          if (isPreview) {
            onPreviewRequestFullscreen?.();
          } else {
            showControls();
          }
        }}
        onMouseMove={showControls}
        className={`h-screen w-full bg-black relative flex overflow-hidden ${
          isPreview ? 'items-start justify-start' : 'items-center justify-center'
        } ${isMinimized ? 'rounded-[14px]' : ''}`}
      >
        {shouldUseNativePlayer ? (
          <>
            {playerState !== 'ready' && (
              <img
                src={fallbackPoster}
                alt={media?.title || 'Preview'}
                className="h-full w-full object-cover opacity-65"
              />
            )}
            {playerState !== 'ready' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/35 px-3 text-center text-[11px] font-semibold tracking-wide text-white/90">
                {error ? `Previa indisponivel: ${error}` : 'Carregando previa...'}
              </div>
            )}
          </>
        ) : (
          <>
            <video
              ref={previewVideoRef}
              className={`h-full w-full ${
                isPreview || isLiveStream ? 'object-contain bg-black' : 'object-cover'
              }`}
              autoPlay
              muted={false}
              playsInline
              poster={fallbackPoster}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />

            {inlineError && isPreview && (
               <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/80 px-4 text-center">
                 <div className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500 mb-1">Sem Sinal</div>
                 <div className="text-[10px] font-bold text-white/70 uppercase tracking-widest">{inlineError}</div>
                 <div className="text-[9px] text-white/40 mt-3 uppercase max-w-[200px]">O player nativo pode suportar este canal. Clique em tela cheia.</div>
               </div>
            )}
            
            {/* Cinematic Controls Overlay (Z-50) */}
            {!isPreview && (
              <div 
                className={`
                  absolute inset-0 z-50 flex flex-col justify-between p-8 bg-gradient-to-t from-black/80 via-transparent to-black/60
                  transition-opacity duration-500 ease-in-out
                  ${isControlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
                `}
              >
                {/* Top Bar: Back & Title */}
                <div className="flex items-center gap-6">
                   <button 
                     onClick={(e) => { e.stopPropagation(); onClose(); }}
                     className="p-3 rounded-full bg-white/5 hover:bg-white/10 transition-all border border-white/10 backdrop-blur-md"
                   >
                     <X size={28} className="text-white" />
                   </button>
                   {canShowChannelBrowser && (
                     <button
                       type="button"
                       onClick={(event) => {
                         event.stopPropagation();
                         setIsChannelBrowserOpen((prev) => !prev);
                         showControls();
                       }}
                       className="rounded-2xl border border-red-500/30 bg-black/65 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-red-200 backdrop-blur-xl"
                     >
                       {isChannelBrowserOpen ? 'Ocultar Canais' : 'Canais'}
                     </button>
                   )}
                   <div>
                     <span className="text-[10px] font-black uppercase tracking-[0.3em] text-red-600 block mb-0.5">
                       {isLiveStream ? 'Ao Vivo' : 'Streaming'}
                     </span>
                     <h2 className="text-2xl font-black text-white drop-shadow-xl">
                       {media?.title || 'Xandeflix Player'}
                     </h2>
                   </div>
                </div>

                {/* Bottom Bar: Progress & Media Controls */}
                <div className="flex flex-col gap-6">
                  {!isLiveStream && (
                    <div className="flex flex-col gap-2">
                       <ProgressBar videoRef={previewVideoRef} />
                       <div className="flex justify-between">
                         <TimeDisplay videoRef={previewVideoRef} />
                       </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-8">
                       <button 
                         onClick={(e) => { e.stopPropagation(); togglePlayPause(); }}
                         className="p-4 rounded-full bg-white text-black hover:scale-110 transition-transform shadow-2xl"
                       >
                         {isPlaying ? <Pause size={30} fill="black" /> : <Play size={30} fill="black" className="ml-1" />}
                       </button>

                       <button 
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            if (previewVideoRef.current) {
                              previewVideoRef.current.muted = !previewVideoRef.current.muted;
                              setIsPlaying(isPlaying ? true : false); // Force re-render if needed
                            }
                          }}
                          className="p-2 text-white/80 hover:text-white transition-colors"
                        >
                          <Volume2 size={24} />
                        </button>
                    </div>

                    {!canShowChannelBrowser && (
                      <div className="flex items-center gap-4">
                         <button 
                           onClick={(e) => {
                             e.stopPropagation();
                             const host = previewHostRef.current;
                             if (host) {
                               if (!document.fullscreenElement) {
                                 host.requestFullscreen().catch(() => {});
                               } else {
                                 document.exitFullscreen().catch(() => {});
                               }
                             }
                           }}
                           className="p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-all border border-white/10"
                         >
                           <FastForward size={22} className="text-white rotate-90" />
                         </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        {canShowChannelBrowser && isChannelBrowserOpen && (
          <>
            <div
              className="absolute left-0 top-0 z-[70] h-full w-[520px] max-w-[76vw] overflow-hidden border-r border-white/10 bg-black/55 backdrop-blur-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-white/10 bg-black/50 px-4 py-4">
                <div className="text-sm font-black uppercase tracking-[0.2em] text-red-500">Grupos e Canais</div>
                <button
                  type="button"
                  onClick={() => setIsChannelBrowserOpen(false)}
                  className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs font-bold text-white/85"
                >
                  Fechar
                </button>
              </div>

              <div className="grid h-[calc(100%-64px)] min-h-0 grid-cols-[190px_1fr] overflow-hidden">
                <div className="min-h-0 overflow-y-auto border-r border-white/10 bg-black/40 p-2">
                  {liveBrowserCategories.map((category) => {
                    const selected = (activeBrowserCategory?.id || '') === category.id;
                    return (
                      <button
                        key={`live-cat-${category.id}`}
                        type="button"
                        onClick={() => {
                          setChannelGroupId(category.id);
                          setChannelSearchQuery('');
                        }}
                        className="mb-2 w-full rounded-lg px-2 py-2 text-left text-[11px] font-bold uppercase tracking-wide"
                        style={{
                          color: selected ? '#fff' : 'rgba(255,255,255,0.72)',
                          background: selected ? 'rgba(229,9,20,0.22)' : 'transparent',
                          border: selected ? '1px solid rgba(229,9,20,0.45)' : '1px solid transparent',
                        }}
                      >
                        {category.title}
                      </button>
                    );
                  })}
                </div>

                <div className="flex h-full min-h-0 flex-col overflow-hidden bg-black/35 p-2">
                  <input
                    value={channelSearchQuery}
                    onChange={(event) => setChannelSearchQuery(event.target.value)}
                    placeholder="Buscar canal"
                    className="mb-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-white outline-none"
                  />
                  <div ref={channelListContainerRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
                    {browserChannels.map((channel) => {
                      const selected = channel.id === media?.id || channel.videoUrl === url;
                      return (
                        <button
                          key={`live-channel-${channel.id}`}
                          data-channel-selected={selected ? 'true' : undefined}
                          type="button"
                          onClick={() => {
                            onZap?.(channel);
                            setIsChannelBrowserOpen(false);
                          }}
                          className="mb-2 w-full rounded-lg px-3 py-2 text-left"
                          style={{
                            background: selected ? 'rgba(229,9,20,0.18)' : 'rgba(255,255,255,0.04)',
                            border: selected ? '1px solid rgba(229,9,20,0.5)' : '1px solid rgba(255,255,255,0.1)',
                          }}
                        >
                          <div className="truncate text-sm font-bold text-white">{channel.title}</div>
                          <div className="truncate text-[11px] font-semibold text-white/50">{channel.category}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
        {isMinimized && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleMinimize?.();
              onPreviewRequestFullscreen?.();
            }}
            className="absolute left-2 top-2 z-20 rounded-md bg-black/70 px-2 py-1 text-[10px] font-black tracking-wide text-white/90"
          >
            TOQUE PARA AMPLIAR
          </button>
        )}
      </div>
      {showDiagnostic && (
          <NetworkDiagnostic onClose={() => setShowDiagnostic(false)} testUrl={url} />
      )}
    </>
    );
  },
);

VideoPlayer.displayName = 'VideoPlayer';
