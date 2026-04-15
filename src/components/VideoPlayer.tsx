import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { StatusBar } from '@capacitor/status-bar';
import { LoaderCircle, X, Play, Pause, Volume2, VolumeX, FastForward, Rewind } from 'lucide-react';
import Hls from 'hls.js';
import type { Category, Media } from '../types';
import { useStore } from '../store/useStore';
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
    const isTsLike =
      lower.includes('output=ts') ||
      lower.includes('output=mpegts') ||
      pathLower.endsWith('.ts') ||
      pathLower.endsWith('.mpegts');

    const originalUrl = parsed.toString();
    const forcedHls = new URL(originalUrl);
    forcedHls.searchParams.set('output', 'hls');

    const removeOutput = new URL(originalUrl);
    removeOutput.searchParams.delete('output');

    const m3u8Path = new URL(originalUrl);
    m3u8Path.pathname = m3u8Path.pathname.replace(/\.(?:ts|mpegts)$/i, '.m3u8');

    const m3u8WithHls = new URL(m3u8Path.toString());
    m3u8WithHls.searchParams.set('output', 'hls');

    const ordered: string[] = [];
    if (isTsLike) {
      addUnique(ordered, m3u8WithHls.toString());
      addUnique(ordered, m3u8Path.toString());
      addUnique(ordered, forcedHls.toString());
      addUnique(ordered, originalUrl);
      addUnique(ordered, removeOutput.toString());
    } else {
      addUnique(ordered, originalUrl);
      addUnique(ordered, forcedHls.toString());
      addUnique(ordered, m3u8Path.toString());
      addUnique(ordered, removeOutput.toString());
    }

    return ordered;
  } catch {
    return [trimmed];
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
      onPreviewRequestFullscreen,
      suppressNativePreviewExitOnUnmount = false,
      isMinimized = false,
      onToggleMinimize,
      isBrowseMode = false,
      isPreview = false,
      channelBrowserCategories,
      onPictureInPictureChange,
      onZap,
    },
    ref,
  ) => {
    const isNativePlatform = Capacitor.isNativePlatform();
    const isLiveStream = (media?.type || mediaType) === 'live';
    const savePlaybackProgress = useStore((state) => state.savePlaybackProgress);

    const [playerState, setPlayerState] = useState<NativePlayerState>(
      isNativePlatform ? 'opening' : 'error',
    );
    const [error, setError] = useState<string | null>(
      isNativePlatform ? null : 'O player nativo esta disponivel apenas no app Android/Capacitor.',
    );

    const listenerHandlesRef = useRef<PluginListenerHandle[]>([]);
    const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const openedPlayerRef = useRef(false);
    const handledExitRef = useRef(false);
    const lastKnownTimeRef = useRef(0);
    const durationRef = useRef(0);
    const hlsRef = useRef<Hls | null>(null);
    const sessionStartedAtRef = useRef(Date.now());
    const sessionUserIdRef = useRef<string | null>(null);
    const lastProgressSyncAtRef = useRef(0);
    const lastProgressSyncedTimeRef = useRef(0);
    const sessionResumePositionRef = useRef(0);

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
      if (!isNativePlatform) {
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
    }, [isNativePlatform, onPictureInPictureChange]);

    const prepareSystemUi = useCallback(async () => {
      if (!isNativePlatform) {
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
    }, [isNativePlatform, onPictureInPictureChange]);

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

    const [isPlaying, setIsPlaying] = useState(true);

    const togglePlayPause = useCallback(async () => {
      const isNative = isNativePlatform && !isPreview;
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
        } catch (e) {}
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
    }, [isNativePlatform, isPreview, isPlaying, showControls]);

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
      if (isPreview || !isNativePlatform) return;

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
    }, [isPreview, isNativePlatform, showControls, togglePlayPause, handleZap, closeNativePlayer]);

    useEffect(() => {
      if (!isNativePlatform || isPreview) {
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
      isNativePlatform,
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
      // Android native preview: render ExoPlayer inside a bounded native overlay.
      if (!isNativePlatform || !isPreview) {
        return;
      }

      let disposed = false;
      let rafId: number | null = null;

      const bootstrapInlineNativePreview = async (attempt = 0): Promise<void> => {
        if (disposed) return;

        const host = previewHostRef.current;
        const rect = host?.getBoundingClientRect();
        if (!rect || rect.width < 24 || rect.height < 24) {
          if (attempt < 30) {
            rafId = window.requestAnimationFrame(() => {
              void bootstrapInlineNativePreview(attempt + 1);
            });
          } else {
            setPlayerState('error');
            setError('Nao foi possivel calcular a area da previa nativa.');
          }
          return;
        }

        openedPlayerRef.current = false;
        handledExitRef.current = false;
        setPlayerState('opening');
        setError(null);

        try {
          console.log('[NativePreview] init rect:', {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            url,
          });

          removeListeners();
          listenerHandlesRef.current = [
            await NativeVideoPlayer.addListener('playerReady', () => {
              setPlayerState('ready');
            }),
            await NativeVideoPlayer.addListener('playerPlay', () => {
              setPlayerState('ready');
            }),
            await NativeVideoPlayer.addListener('playerTap', () => {
              onPreviewRequestFullscreen?.();
            }),
          ];

          const previewStartAt =
            !isLiveStream && lastKnownTimeRef.current > 5
              ? Math.floor(lastKnownTimeRef.current)
              : !isLiveStream && sessionResumePositionRef.current > 5
                ? Math.floor(sessionResumePositionRef.current)
                : 0;

          const secureStreamUrl = loadMediaStream(url, 'hls');

          const result = await NativeVideoPlayer.initPlayer({
            url: secureStreamUrl,
            title: media?.title || 'Xandeflix',
            smallTitle: media?.category || '',
            artwork: media?.thumbnail || media?.backdrop || '',
            chromecast: false,
            displayMode: 'all',
            embedded: true,
            hideControls: true,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            startAtSec: previewStartAt,
          });

          if (disposed) {
            // Se o componente desmontou enquanto aguardava a ponte nativa, encerramos orfãos ativos
            if (result.result) {
              void NativeVideoPlayer.exitPlayer().catch(() => {});
            }
            return;
          }

          if (!result.result) {
            throw new Error(result.message || 'Falha ao iniciar previa nativa.');
          }

          openedPlayerRef.current = true;
          setPlayerState('ready');
        } catch (previewError) {
          if (disposed) {
            void NativeVideoPlayer.exitPlayer().catch(() => {});
            return;
          }
          console.error('[NativePreview] Falha ao iniciar previa nativa:', previewError);
          setPlayerState('error');
          setError(normalizeErrorMessage(previewError, 'Falha ao iniciar previa nativa.'));
        }
      };

      void bootstrapInlineNativePreview();

      return () => {
        disposed = true;
        if (rafId) {
          window.cancelAnimationFrame(rafId);
        }
        removeListeners();
        const switchingToAnotherPreview =
          latestPreviewUrlRef.current !== url && latestPreviewUrlRef.current.trim() !== '';
        const skipExit = suppressNativePreviewExitOnUnmountRef.current;
        if (openedPlayerRef.current && !switchingToAnotherPreview && !skipExit) {
          openedPlayerRef.current = false;
          void NativeVideoPlayer.exitPlayer().catch(() => {});
        }
      };
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
      // Web preview/web player fallback only (no web playback on Android native app).
      if (isNativePlatform) return;

      const video = previewVideoRef.current;
      if (!video) return;

      const secureWebUrl = loadMediaStream(url, 'hls');
      const candidates = buildLivePreviewUrlCandidates(secureWebUrl, isLiveStream);
      if (candidates.length === 0) return;

      let candidateIndex = 0;
      let disposed = false;
      let startupTimeoutId: ReturnType<typeof setTimeout> | null = null;
      let loadedMetadataHandler: (() => void) | null = null;
      let nativeErrorHandler: (() => void) | null = null;
      let timeUpdateHandler: (() => void) | null = null;
      let endedHandler: (() => void) | null = null;
      let hlsManifestParsedHandler: (() => void) | null = null;
      let hlsErrorHandler: ((event: string, data: any) => void) | null = null;

      const clearStartupTimeout = () => {
        if (startupTimeoutId) {
          clearTimeout(startupTimeoutId);
          startupTimeoutId = null;
        }
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

      const removeVideoEventListeners = () => {
        if (loadedMetadataHandler) {
          video.removeEventListener('loadedmetadata', loadedMetadataHandler);
          loadedMetadataHandler = null;
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
        removeVideoEventListeners();
        destroyHlsInstance();
        releaseHtml5Video();
      };

      const playCurrentSource = () => {
        if (disposed) return;

        teardownCurrentSource();
        const currentUrl = candidates[candidateIndex];

        clearStartupTimeout();
        startupTimeoutId = setTimeout(() => {
          if (disposed) return;
          if (candidateIndex + 1 < candidates.length) {
            candidateIndex += 1;
            playCurrentSource();
          } else {
            console.error('[Preview] Timeout para iniciar stream:', currentUrl);
          }
        }, 12000);

        const canUseNativeHlsTag = video.canPlayType('application/vnd.apple.mpegurl') !== '';

        if (Hls.isSupported()) {
          const hls = new Hls({
            startLevel: -1,
            debug: false,
            enableWorker: false,
            // Passthrough streaming logic: strictly limit buffer to RAM (30-60s)
            maxBufferLength: 30, // Limit forward buffer to 30 seconds
            maxMaxBufferLength: 60, // Absolute maximum buffer
            maxBufferSize: 30 * 1024 * 1024, // Hard limit 30MB of RAM chunks
            liveSyncDurationCount: 3, // Prevent edge drifting
            liveMaxLatencyDurationCount: 10,
          });
          
          hlsRef.current = hls;

          hls.loadSource(currentUrl);
          hls.attachMedia(video);

          hlsManifestParsedHandler = () => {
            clearStartupTimeout();
            void video.play().catch((playError) => {
              console.error('[Preview] Erro ao iniciar play:', playError);
            });
          };
          hls.on(Hls.Events.MANIFEST_PARSED, hlsManifestParsedHandler);

          hlsErrorHandler = (_event, data) => {
            if (disposed || !data.fatal) return;

            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.warn('[HLS] Falha de rede irrecuperável, tentando recarregar fonte...', data);
                hls.startLoad();
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
                }
                break;
            }
          };
          hls.on(Hls.Events.ERROR, hlsErrorHandler);

          return;
        }

        if (canUseNativeHlsTag) {
          video.src = currentUrl;

          loadedMetadataHandler = () => {
            clearStartupTimeout();
            void video.play().catch((playError) => {
              console.error('[Preview] Erro no play nativo HLS:', playError);
            });
          };
          nativeErrorHandler = () => {
            if (candidateIndex + 1 < candidates.length) {
              candidateIndex += 1;
              playCurrentSource();
            } else {
              clearStartupTimeout();
              console.error('[Preview] Erro nativo de video sem fallback:', currentUrl);
            }
          };
          timeUpdateHandler = () => {
            lastKnownTimeRef.current = Math.max(0, Math.floor(video.currentTime || 0));
          };
          endedHandler = () => {
            clearStartupTimeout();
          };

          video.addEventListener('loadedmetadata', loadedMetadataHandler);
          video.addEventListener('error', nativeErrorHandler);
          video.addEventListener('timeupdate', timeUpdateHandler);
          video.addEventListener('ended', endedHandler);
          return;
        }

        clearStartupTimeout();
      };

      playCurrentSource();

      return () => {
        disposed = true;
        clearStartupTimeout();
        removeVideoEventListeners();
        destroyHlsInstance();
        releaseHtml5Video();
      };
    }, [url, isNativePlatform, isLiveStream]);

    if (isNativePlatform && !isPreview) {
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
                  onClick={() => {
                    onClose();
                  }}
                  className="inline-flex min-h-11 flex-1 items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 text-sm font-bold text-white transition hover:bg-white/10"
                >
                  <X className="mr-2 h-4 w-4" />
                  Fechar
                </button>
              </div>
            </div>
          </div>
        );
      }

      if (isBrowseMode) {
        return (
          <div className="flex h-full w-full items-center justify-between gap-4 bg-black px-4 text-white">
            <div className="min-w-0">
              <div className="text-[10px] font-black uppercase tracking-[0.28em] text-red-500">
                Android Native Player
              </div>
              <div className="mt-1 truncate text-lg font-bold">
                {media?.title || 'Abrindo reprodução...'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void closeNativePlayer();
              }}
              className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 text-sm font-bold text-white transition hover:bg-white/10"
            >
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              Fechar
            </button>
          </div>
        );
      }

      return null;
    }

    const fallbackPoster = media?.backdrop || media?.thumbnail || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

    return (
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
        {isNativePlatform ? (
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
              className="h-full w-full object-cover"
              autoPlay
              muted={isPreview}
              playsInline
              poster={fallbackPoster}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
            
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
                  </div>
                </div>
              </div>
            )}
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
    );
  },
);

VideoPlayer.displayName = 'VideoPlayer';
