import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { StatusBar } from '@capacitor/status-bar';
import { Menu, X } from 'lucide-react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import type { Category, EPGProgram, Media } from '../types';
import { useStore } from '../store/useStore';
import {
  NativeVideoPlayer,
  type NativeVideoPlayerEvent,
  type NativeVideoPlayerErrorEvent,
  type NativeVideoPlayerExitEvent,
  type NativeVideoPlayerResult,
} from '../lib/nativeVideoPlayer';
import { sendPlayerTelemetryReport, type PlayerTelemetryExitReason } from '../lib/playerTelemetry';
import {
  resolvePlaybackProgressUserId,
  syncPlaybackProgressSilently,
} from '../lib/playbackProgressSync';

import { useTvNavigation } from '../hooks/useTvNavigation';

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
type PlaybackDiagnostic = {
  stage: 'preview' | 'native';
  reason: string;
  code?: string;
  detail?: string;
  url?: string;
  timestamp: number;
  httpStatus?: string;
};

function isLikelyConnectionFailure(input: {
  code?: string;
  reason?: string;
  detail?: string;
  httpStatus?: string;
}): boolean {
  const code = String(input.code || '').toUpperCase();
  const reason = String(input.reason || '').toLowerCase();
  const detail = String(input.detail || '').toLowerCase();
  const httpStatus = String(input.httpStatus || '').trim();

  const networkCodeHints = [
    'NETWORK',
    'TIMEOUT',
    'STALL',
    'CONNECTION',
    'DNS',
    'OFFLINE',
    'UNREACHABLE',
    'SOCKET',
    'ABORT',
  ];
  if (networkCodeHints.some((hint) => code.includes(hint))) {
    return true;
  }

  if (/^HTTP[_-]?(408|429|5\d\d)$/.test(code)) {
    return true;
  }

  const statusNumber = Number.parseInt(httpStatus, 10);
  if (Number.isFinite(statusNumber)) {
    if (statusNumber === 408 || statusNumber === 429 || statusNumber >= 500) {
      return true;
    }
  }

  const networkTextHints = [
    'timeout',
    'timed out',
    'network',
    'conexao',
    'conexão',
    'internet',
    'dns',
    'offline',
    'socket',
    'stall',
    'no response',
    'host unreachable',
    'connection',
    'cannot reach',
  ];
  const mergedText = `${reason} ${detail}`;
  return networkTextHints.some((hint) => mergedText.includes(hint));
}

function isLikelyRecoverableMediaFailure(input: {
  code?: string;
  reason?: string;
  detail?: string;
}): boolean {
  const code = String(input.code || '').toUpperCase();
  const reason = String(input.reason || '').toLowerCase();
  const detail = String(input.detail || '').toLowerCase();
  const mergedText = `${reason} ${detail}`;

  const mediaCodeHints = [
    'MEDIAERROR',
    'MSE',
    'DEMUX',
    'DECODER',
    'CODEC',
    'PARSER',
    'SOURCEBUFFER',
    'MPEGTS',
    'HLS_MEDIA_ERROR',
    'FRAG_PARSING_ERROR',
    'BUFFER_APPEND',
  ];
  if (mediaCodeHints.some((hint) => code.includes(hint))) {
    return true;
  }

  const mediaTextHints = [
    'mediaerror',
    'mse',
    'codec',
    'decoder',
    'demux',
    'parser',
    'append',
    'sourcebuffer',
    'unsupported',
    'cannot play',
    'no supported source',
  ];

  return mediaTextHints.some((hint) => mergedText.includes(hint));
}

function normalizeChannelLookupKey(value: string | null | undefined): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(canal|channel|tv|hd|fhd|h265|h264|sd|4k|uhd)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

type StreamSourceResolution = {
  originalUrl: string;
  playbackUrl: string;
  headers: Record<string, string>;
  hasHeaderHints: boolean;
};
const PLAYBACK_PROGRESS_SYNC_INTERVAL_MS = 15000;
const MIN_PROGRESS_DELTA_SECONDS = 3;
const LIVE_CONTROLS_AUTO_HIDE_MS = 3000;
const VOD_CONTROLS_AUTO_HIDE_MS = 8000;
const REMOTE_OK_KEYCODES = new Set([13, 23, 66]);
const DEFAULT_NATIVE_USER_AGENT = 'VLC/3.0.21 LibVLC/3.0.21';
const NATIVE_SESSION_HANDOFF_WINDOW_MS = 6000;

type NativeSessionHandoffState = {
  url: string;
  embedded: boolean;
  capturedAt: number;
};

let nativeSessionHandoff: NativeSessionHandoffState | null = null;

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

function maskSensitiveUrl(rawUrl: string): string {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';

  const pipeIndex = trimmed.indexOf('|');
  const baseUrl = pipeIndex >= 0 ? trimmed.slice(0, pipeIndex) : trimmed;

  try {
    const parsed = new URL(baseUrl);

    if (parsed.username) {
      parsed.username = '***';
    }
    if (parsed.password) {
      parsed.password = '***';
    }

    const sensitiveParams = [
      'password',
      'pass',
      'token',
      'auth',
      'authorization',
      'apikey',
      'api_key',
      'signature',
      'sig',
      'key',
    ];

    sensitiveParams.forEach((param) => {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '***');
      }
    });

    const normalized = parsed.toString();
    return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
  } catch {
    return baseUrl.length > 220 ? `${baseUrl.slice(0, 217)}...` : baseUrl;
  }
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

    const pathLower = parsed.pathname.toLowerCase();
    const isNumericXtreamPath = /\/\d+$/.test(parsed.pathname);
    const hasTsOutput =
      parsed.searchParams.get('output')?.toLowerCase() === 'ts'
      || parsed.searchParams.get('output')?.toLowerCase() === 'mpegts';
    const isTsLike =
      hasTsOutput ||
      pathLower.endsWith('.ts') ||
      pathLower.endsWith('.mpegts');

    const originalUrl = parsed.toString();
    const forcedTs = new URL(originalUrl);
    forcedTs.searchParams.set('output', 'ts');

    const forcedMpegts = new URL(originalUrl);
    forcedMpegts.searchParams.set('output', 'mpegts');

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

    if (isTsLike) {
      // TS-like: insistir em TS/MPEGTS e evitar derivações HLS agressivas
      // (muitos provedores retornam TS puro mesmo com output=hls).
      addUnique(ordered, forcedTs.toString());
      addUnique(ordered, forcedMpegts.toString());
      addUnique(ordered, removeOutput.toString());
      addUnique(ordered, forcedHls.toString());
      if (!isNumericXtreamPath) {
        addUnique(ordered, typeM3u8.toString());
        addUnique(ordered, m3u8WithHls.toString());
        addUnique(ordered, m3u8Path.toString());
      }
    } else {
      // Nao-TS: tentar HLS primeiro, mas manter variantes TS como fallback extra.
      addUnique(ordered, forcedHls.toString());
      addUnique(ordered, typeM3u8.toString());
      addUnique(ordered, m3u8WithHls.toString());
      addUnique(ordered, m3u8Path.toString());
      addUnique(ordered, forcedTs.toString());
      addUnique(ordered, forcedMpegts.toString());
    }
    
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

function shouldPreferTsPipeline(streamUrl: string): boolean {
  try {
    const parsed = new URL(streamUrl);
    const output = String(parsed.searchParams.get('output') || '').toLowerCase();
    if (output === 'ts' || output === 'mpegts') return true;
    return false;
  } catch {
    const lower = String(streamUrl || '').toLowerCase();
    if (lower.includes('output=ts') || lower.includes('output=mpegts')) return true;
    return false;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeHeaderName(rawName: string): string {
  const key = rawName
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/_/g, '-')
    .toLowerCase();

  if (!key) return '';
  if (key === 'user-agent' || key === 'http-user-agent') return 'User-Agent';
  if (key === 'referer' || key === 'referrer' || key === 'http-referer' || key === 'http-referrer') return 'Referer';
  if (key === 'origin' || key === 'http-origin') return 'Origin';
  if (key === 'cookie' || key === 'http-cookie') return 'Cookie';
  if (key === 'authorization' || key === 'http-authorization') return 'Authorization';

  return key
    .split('-')
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join('-');
}

function parseStreamHeaders(rawHeaderSegment: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const segment = rawHeaderSegment.trim();
  if (!segment) {
    return headers;
  }

  const pairs = segment
    .split(/[&|;]/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const rawName = safeDecode(pair.slice(0, separatorIndex));
    const name = normalizeHeaderName(rawName);
    if (!name) {
      continue;
    }

    const value = safeDecode(pair.slice(separatorIndex + 1))
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (!value) {
      continue;
    }

    headers[name] = value;
  }

  return headers;
}

function normalizePlayableUrl(rawUrl: string): string {
  let url = rawUrl.trim().replace(/^['"]|['"]$/g, '');
  if (!url) {
    return '';
  }

  if (url.startsWith('//')) {
    url = `https:${url}`;
  }

  // Corrige entradas de M3U com espaços acidentais no começo/fim.
  url = url.replace(/\s+$/g, '').replace(/^\s+/g, '');

  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function resolveStreamSource(rawUrl: string): StreamSourceResolution {
  const originalUrl = String(rawUrl || '').trim();
  if (!originalUrl) {
    return {
      originalUrl: '',
      playbackUrl: '',
      headers: {},
      hasHeaderHints: false,
    };
  }

  const pipeIndex = originalUrl.indexOf('|');
  if (pipeIndex < 0) {
    return {
      originalUrl,
      playbackUrl: normalizePlayableUrl(originalUrl),
      headers: {},
      hasHeaderHints: false,
    };
  }

  const rawPlaybackUrl = originalUrl.slice(0, pipeIndex).trim();
  const rawHeaderSegment = originalUrl.slice(pipeIndex + 1).trim();
  const headers = parseStreamHeaders(rawHeaderSegment);

  return {
    originalUrl,
    playbackUrl: normalizePlayableUrl(rawPlaybackUrl),
    headers,
    hasHeaderHints: rawHeaderSegment.length > 0,
  };
}

/**
 * ProgressBar Component
 * Optimized with direct DOM updates via useRef to prevent re-renders on 'timeupdate'
 */
const ProgressBar = React.memo(({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement | null> }) => {
  const progressInnerRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !video.duration || !Number.isFinite(video.duration)) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickedPercent = Math.max(0, Math.min(1, x / rect.width));
    video.currentTime = clickedPercent * video.duration;
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateProgress = () => {
      if (progressInnerRef.current && video.duration && Number.isFinite(video.duration)) {
        const percent = (video.currentTime / video.duration) * 100;
        progressInnerRef.current.style.width = `${percent}%`;
        if (thumbRef.current) {
          thumbRef.current.style.left = `${percent}%`;
        }
      }
    };

    video.addEventListener('timeupdate', updateProgress);
    return () => video.removeEventListener('timeupdate', updateProgress);
  }, [videoRef]);

  return (
    <div 
      className="h-1.5 w-full bg-white/20 rounded-full relative cursor-pointer group"
      onClick={handleSeek}
    >
      <div 
        ref={progressInnerRef} 
        className="h-full bg-red-600 rounded-full shadow-[0_0_12px_rgba(220,38,38,0.6)] relative z-10" 
        style={{ width: '0%' }} 
      />
      <div 
        ref={thumbRef}
        className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-red-600 rounded-full border-2 border-white shadow-xl opacity-0 group-hover:opacity-100 transition-opacity z-20 pointer-events-none"
        style={{ left: '0%', marginLeft: '-8px' }}
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

export function loadMediaStream(targetUrl: string, expectedType: 'hls' | 'dash' | 'mp4', isNative = false): string {
  const resolved = resolveStreamSource(targetUrl);
  let normalizedTargetUrl = resolved.playbackUrl || String(targetUrl || '').trim();
  
  try {
    const parsed = new URL(normalizedTargetUrl);
    if (expectedType === 'hls') {
       const output = (parsed.searchParams.get('output') || '').toLowerCase();
       // Em TVs Philips, forçar HLS aumenta a taxa de abertura de canais Xtream.
       if (!output || output === 'ts' || output === 'mpegts') {
         parsed.searchParams.set('output', 'hls');
       }

       // Algumas listas usam .ts/.mpegts com query hls; normalizamos para .m3u8 quando possível.
       if (parsed.pathname.match(/\.(ts|mpegts)$/i)) {
         parsed.pathname = parsed.pathname.replace(/\.(ts|mpegts)$/i, '.m3u8');
       }
    }
    normalizedTargetUrl = parsed.toString();
  } catch {
    // URL inválida
  }

  // Para player nativo usamos URL limpa; headers seguem em objeto separado para o plugin Android.
  void isNative;
  return normalizedTargetUrl;
}

export const VideoPlayer = React.memo(
  React.forwardRef<VideoPlayerHandle, VideoPlayerProps>(
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
      isBrowseMode: _isBrowseMode = false,
      isPreview = false,
      showChannelSidebar = false,
      channelBrowserCategories,
      onPictureInPictureChange,
      onZap,
      nextEpisode = null,
      onPlayNextEpisode,
    },
    ref,
  ) => {
    const [retryCount, setRetryCount] = useState(0);
    const [isAutoRetrying, setIsAutoRetrying] = useState(false);
    const [autoRetrySeconds, setAutoRetrySeconds] = useState(0);
    const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isTransitioningRef = useRef(false);
    const isUnmountingRef = useRef(false);

    useEffect(() => {
      return () => { isUnmountingRef.current = true; };
    }, []);

    const isNativePlatform = Capacitor.isNativePlatform();
    const isLiveStream = (media?.type || mediaType) === 'live';
    const streamSource = useMemo(() => resolveStreamSource(url), [url]);
    const playbackUrl = streamSource.playbackUrl || String(url || '').trim();
    const streamHeaders = streamSource.headers;
    const streamHeaderEntries = useMemo(() => Object.entries(streamHeaders), [streamHeaders]);
    const hasStreamHeaders = streamHeaderEntries.length > 0;
    const nativePlayerHeaders = useMemo(() => {
      const normalizedHeaders: Record<string, string> = {};
      streamHeaderEntries.forEach(([name, value]) => {
        if (!name || !value) return;
        normalizedHeaders[name] = value;
      });

      const hasUserAgent = Object.keys(normalizedHeaders).some((name) => {
        const lowered = name.toLowerCase();
        return lowered === 'user-agent' || lowered === 'http-user-agent';
      });
      if (!hasUserAgent) {
        normalizedHeaders['User-Agent'] = DEFAULT_NATIVE_USER_AGENT;
      }

      const hasAccept = Object.keys(normalizedHeaders).some((name) => name.toLowerCase() === 'accept');
      if (!hasAccept) {
        normalizedHeaders.Accept = '*/*';
      }

      return normalizedHeaders;
    }, [streamHeaderEntries]);
    const [forceNativeFallback, setForceNativeFallback] = useState(false);
    
    // TVs Philips e Android TVs no geral precisam do Player Nativo (ExoPlayer) para rodar Live TV.
    // O player web (MSE) costuma dar TIMEOUT ou erro de codec nessas TVs.
    const shouldPreferWebLiveFullscreen = isLiveStream && !isPreview && showChannelSidebar;
    const canUseNativeFallback = isNativePlatform && !isPreview;
    
    // Força o player nativo em Android para canais ao vivo, exceto se for explicitamente um tablet pequeno.
    // Em TVs, window.innerWidth é grande, então vamos focar na plataforma.
    const isAndroid = Capacitor.getPlatform() === 'android';
    const shouldUseNativePlayer =
      canUseNativeFallback &&
      !shouldPreferWebLiveFullscreen &&
      (forceNativeFallback || (isAndroid && isLiveStream));
    const shouldUseEmbeddedNativePreview = isAndroid && isNativePlatform && isPreview && isLiveStream;
    const shouldUseNativeBridgePlayer = shouldUseNativePlayer || shouldUseEmbeddedNativePreview;
    const savePlaybackProgress = useStore((state) => state.savePlaybackProgress);
    const [isChannelBrowserOpen, setIsChannelBrowserOpen] = useState(false);
    const videoObjectFitClass = 'object-cover';
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
    const epgData = useStore((state) => state.epgData);
    const [epgNowTs, setEpgNowTs] = useState(() => Date.now());

    useEffect(() => {
      if (!isLiveStream || isPreview) {
        return;
      }
      const intervalId = window.setInterval(() => {
        setEpgNowTs(Date.now());
      }, 30000);
      return () => window.clearInterval(intervalId);
    }, [isLiveStream, isPreview]);

    const livePrograms = useMemo<EPGProgram[]>(() => {
      if (!isLiveStream || !media || !epgData) {
        return [];
      }

      const map = new Map<string, EPGProgram[]>();
      Object.entries(epgData).forEach(([key, programs]) => {
        if (!Array.isArray(programs) || programs.length === 0) return;

        const directKey = key.trim().toLowerCase();
        if (directKey && !map.has(directKey)) {
          map.set(directKey, programs);
        }

        const normalizedKey = normalizeChannelLookupKey(key);
        if (normalizedKey && !map.has(normalizedKey)) {
          map.set(normalizedKey, programs);
        }
      });

      const lookupCandidates = [media.tvgId, media.tvgName, media.title]
        .map((value) => String(value || '').trim())
        .filter(Boolean);

      for (const key of lookupCandidates) {
        const direct = map.get(key.toLowerCase());
        if (direct && direct.length > 0) {
          return [...direct].sort((a, b) => a.start - b.start);
        }

        const normalized = map.get(normalizeChannelLookupKey(key));
        if (normalized && normalized.length > 0) {
          return [...normalized].sort((a, b) => a.start - b.start);
        }
      }

      return [];
    }, [epgData, isLiveStream, media]);

    const currentLiveProgram = useMemo(
      () => livePrograms.find((program) => epgNowTs >= program.start && epgNowTs < program.stop) || null,
      [epgNowTs, livePrograms],
    );

    const nextLiveProgram = useMemo(
      () => livePrograms.find((program) => program.start > epgNowTs) || null,
      [epgNowTs, livePrograms],
    );

    const liveProgramProgress = useMemo(() => {
      if (!currentLiveProgram) return 0;
      const duration = Math.max(1, currentLiveProgram.stop - currentLiveProgram.start);
      const elapsed = Math.min(duration, Math.max(0, epgNowTs - currentLiveProgram.start));
      return Math.min(100, Math.max(0, Math.round((elapsed / duration) * 100)));
    }, [currentLiveProgram, epgNowTs]);

    const formatProgramTime = useCallback((timestamp: number) => {
      const date = new Date(timestamp);
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    }, []);

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

    // Sistema de Navegação para o Channel Browser (Sidebar)
    const { registerNode, setFocusedId } = useTvNavigation({
      isActive: !!isChannelBrowserOpen,
    });

    // Auto-focus ao abrir o navegador de canais
    useEffect(() => {
      if (isChannelBrowserOpen) {
        const firstCatId = liveBrowserCategories[0]?.id;
        const targetId = activeBrowserCategory?.id 
          ? `live-cat-${activeBrowserCategory.id}` 
          : (firstCatId ? `live-cat-${firstCatId}` : null);
        
        if (targetId) {
          setTimeout(() => setFocusedId(targetId), 100);
        }
      }
    }, [isChannelBrowserOpen, activeBrowserCategory?.id, liveBrowserCategories, setFocusedId]);

    const [, setPlaybackDiagnostic] = useState<PlaybackDiagnostic | null>(null);
    const [previewTerminalFailure, setPreviewTerminalFailure] = useState(false);
    const hideBufferIndicator = useCallback(() => {}, []);
    const touchBufferIndicator = useCallback(
      (
        _label: string,
        _options?: {
          step?: number;
          cap?: number;
          attempt?: number;
          total?: number;
          forceResetTimer?: boolean;
        },
      ) => {},
      [],
    );
    const completeBufferIndicator = useCallback(() => {}, []);

    const [playerState, setPlayerState] = useState<NativePlayerState>(
      shouldUseNativeBridgePlayer ? 'opening' : 'error',
    );
    const [error, setError] = useState<string | null>(null);
    const [inlineError, setInlineError] = useState<string | null>(null);
    const applyPlaybackDiagnostic = useCallback(
      (_diagnostic: Omit<PlaybackDiagnostic, 'timestamp'>) => {},
      [],
    );

    useEffect(() => {
      setForceNativeFallback(false);
      setInlineError(null);
      setPlaybackDiagnostic(null);
      setPreviewTerminalFailure(false);
      setRetryCount(0);
      setIsAutoRetrying(false);
      setAutoRetrySeconds(0);
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
      hideBufferIndicator();
    }, [hideBufferIndicator, url, isPreview]);

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
    const previewHostRef = useRef<HTMLDivElement>(null);

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
      [isLiveStream, media?.id, media?.title, media?.type, mediaType, url],
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
          streamHost: extractStreamHost(playbackUrl || url),
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
      [isLiveStream, media?.category, media?.id, media?.title, media?.type, mediaType, playbackUrl, url],
    );

    const handlePlayerEvent = useCallback(
      (event: NativeVideoPlayerEvent) => {
        setPlayerState('ready');
        setError(null);
        setInlineError(null);
        setPlaybackDiagnostic(null);
        completeBufferIndicator();

        if (!isLiveStream) {
          persistProgress(event.currentTime);
        }
      },
      [completeBufferIndicator, isLiveStream, persistProgress],
    );

    const handleNativePlayerError = useCallback(
      (event: NativeVideoPlayerErrorEvent) => {
        const codeLabel =
          String(event.errorCodeName || event.errorCode || '').trim() || 'ERRO_DESCONHECIDO';
        const reason =
          String(event.message || event.cause || event.details || 'Falha ao reproduzir no player nativo.').trim();
        const httpStatus = String(event.httpStatus || '').trim();
        const detail = String(event.details || event.cause || '').trim();

        const humanMessage = httpStatus ? `${reason} (HTTP ${httpStatus})` : reason;
        setPlayerState('error');
        setError(humanMessage);
        setInlineError(httpStatus ? `Falha nativa (${codeLabel} / HTTP ${httpStatus})` : `Falha nativa (${codeLabel})`);
        hideBufferIndicator();
        applyPlaybackDiagnostic({
          stage: 'native',
          reason,
          code: codeLabel,
          detail,
          httpStatus: httpStatus || undefined,
          url: maskSensitiveUrl(playbackUrl || url),
        });

        console.error('[NativePlayer] Erro detalhado recebido do ExoPlayer:', event);
      },
      [applyPlaybackDiagnostic, hideBufferIndicator, playbackUrl, url],
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
        
        if (event.dismiss) {
          onClose();
        } else {
          // Se nao foi dismiss (ex: app foi para background), mantemos o componente montado
          // mas marcamos como nao aberto para permitir o re-trigger no foreground.
          setPlayerState('error');
          openedPlayerRef.current = false;
        }
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
      const shouldKeepNativeSessionAlive =
        isNativePlatform &&
        isLiveStream &&
        suppressNativePreviewExitOnUnmountRef.current;

      if (!openedPlayerRef.current) {
        syncProgressToSupabase(lastKnownTimeRef.current, { force: true });
        onClose();
        return;
      }

      if (shouldKeepNativeSessionAlive) {
        handledExitRef.current = true;
        openedPlayerRef.current = false;
        clearProgressPolling();
        removeListeners();
        nativeSessionHandoff = {
          url: playbackUrl || url,
          embedded: shouldUseEmbeddedNativePreview,
          capturedAt: Date.now(),
        };
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
      isLiveStream,
      isNativePlatform,
      onClose,
      playbackUrl,
      removeListeners,
      restoreSystemUi,
      shouldUseEmbeddedNativePreview,
      syncProgressFromNativePlayer,
      syncProgressToSupabase,
      url,
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
    const controlsAutoHideMs = isLiveStream ? LIVE_CONTROLS_AUTO_HIDE_MS : VOD_CONTROLS_AUTO_HIDE_MS;

    const showControls = useCallback(() => {
      setIsControlsVisible(true);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = setTimeout(() => setIsControlsVisible(false), controlsAutoHideMs);
    }, [controlsAutoHideMs]);

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
    const [isMuted, setIsMuted] = useState(false);
    
    // Auto Next Episode Logic
    const [autoNextCountdown, setAutoNextCountdown] = useState<number | null>(null);
    const autoNextTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const startAutoNextCountdown = useCallback(() => {
      if (autoNextCountdown !== null || !nextEpisode) return;
      
      setAutoNextCountdown(5);
      if (autoNextTimerRef.current) clearInterval(autoNextTimerRef.current);
      
      autoNextTimerRef.current = setInterval(() => {
        setAutoNextCountdown(prev => {
          if (prev === null) {
            if (autoNextTimerRef.current) clearInterval(autoNextTimerRef.current);
            return null;
          }
          if (prev <= 1) {
            if (autoNextTimerRef.current) clearInterval(autoNextTimerRef.current);
            onPlayNextEpisode?.();
            return null;
          }
          return prev - 1;
        });
      }, 1000);
    }, [autoNextCountdown, nextEpisode, onPlayNextEpisode]);

    const cancelAutoNext = useCallback(() => {
      if (autoNextTimerRef.current) {
        clearInterval(autoNextTimerRef.current);
        autoNextTimerRef.current = null;
      }
      setAutoNextCountdown(null);
    }, []);

    const toggleMute = useCallback(() => {
      const video = previewVideoRef.current;
      if (video) {
        video.muted = !video.muted;
        setIsMuted(video.muted);
      }
    }, []);

    const tryStartWebPlayback = useCallback(async (fromUserGesture = false) => {
      const video = previewVideoRef.current;
      if (!video) return false;

      const attemptPlay = async () => {
        await video.play();
        setIsPlaying(true);
        setInlineError(null);
        return true;
      };

      try {
        return await attemptPlay();
      } catch (playError) {
        console.warn('[VideoPlayer] play() rejeitado:', playError);

        // Alguns WebViews só iniciam após interação se o vídeo estiver mutado.
        if (!fromUserGesture) {
          setIsPlaying(!video.paused);
          return false;
        }

        const wasMuted = video.muted;
        try {
          video.muted = true;
          setIsMuted(true);
          const startedMuted = await attemptPlay();
          return startedMuted;
        } catch (mutedPlayError) {
          console.error('[VideoPlayer] Falha ao iniciar playback mesmo mutado:', mutedPlayError);
          video.muted = wasMuted;
          setIsMuted(video.muted);
          setIsPlaying(!video.paused);
          return false;
        }
      }
    }, []);

    const togglePlayPause = useCallback(async () => {
      const isNative = shouldUseNativeBridgePlayer;
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
            await tryStartWebPlayback(true);
          } else {
            video.pause();
            syncProgressToSupabase(video.currentTime, { force: true });
            setIsPlaying(false);
          }
        }
      }
      showControls();
    }, [isPlaying, shouldUseNativeBridgePlayer, showControls, syncProgressToSupabase, tryStartWebPlayback]);

    const seek = useCallback((amount: number) => {
      const video = previewVideoRef.current;
      if (video) {
        video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + amount));
        showControls();
      }
    }, [showControls]);

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
      if (isPreview || shouldUseNativePlayer) return;

      const handleTvKey = (e: KeyboardEvent) => {
        const key = e.key;
        const keyCode = (e as any).keyCode;
        const target = e.target as HTMLElement | null;
        const isTypingTarget =
          target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;
        if (isTypingTarget) {
          return;
        }

        const isActionKey =
          key === 'Enter' ||
          key === 'OK' ||
          key === 'NumpadEnter' ||
          key === 'MediaPlayPause' ||
          key === 'ArrowUp' ||
          key === 'ArrowDown' ||
          key === 'ArrowLeft' ||
          key === 'ArrowRight' ||
          key === 'Escape' ||
          key === 'Back' ||
          REMOTE_OK_KEYCODES.has(keyCode) ||
          keyCode === 85 ||
          keyCode === 179 ||
          keyCode === 19 ||
          keyCode === 20 ||
          keyCode === 21 ||
          keyCode === 22 ||
          keyCode === 4 ||
          keyCode === 27;

        if (!isActionKey) {
          return;
        }

        showControls();

        if (
          key === 'Enter' ||
          key === 'OK' ||
          key === 'NumpadEnter' ||
          key === 'MediaPlayPause' ||
          REMOTE_OK_KEYCODES.has(keyCode) ||
          keyCode === 85 ||
          keyCode === 179
        ) {
          void togglePlayPause();
          e.preventDefault();
        } else if (key === 'ArrowUp' || keyCode === 19) {
          if (isLiveStream) {
            handleZap('prev');
            e.preventDefault();
          } else {
             showControls();
             e.preventDefault();
          }
        } else if (key === 'ArrowDown' || keyCode === 20) {
          if (isLiveStream) {
            handleZap('next');
            e.preventDefault();
          } else {
             showControls();
             e.preventDefault();
          }
        } else if (key === 'ArrowLeft' || keyCode === 21) {
           if (!isLiveStream) {
             seek(-10);
             e.preventDefault();
           }
        } else if (key === 'ArrowRight' || keyCode === 22) {
           if (!isLiveStream) {
             seek(10);
             e.preventDefault();
           }
        } else if (key === 'Escape' || key === 'Back' || keyCode === 4 || keyCode === 27) {
          if (isChannelBrowserOpen) {
            setIsChannelBrowserOpen(false);
          } else {
            void closeNativePlayer();
          }
          e.preventDefault();
        }
      };

      window.addEventListener('keydown', handleTvKey);
      return () => window.removeEventListener('keydown', handleTvKey);
    }, [closeNativePlayer, isLiveStream, isPreview, isChannelBrowserOpen, handleZap, seek, shouldUseNativePlayer, showControls, togglePlayPause]);

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

    const setupNativePlayer = useCallback(async () => {
      if (handledExitRef.current) return;
      
      const sessionResumePosition = sessionResumePositionRef.current;
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
          await NativeVideoPlayer.addListener('playerError', handleNativePlayerError),
          await NativeVideoPlayer.addListener('playerExit', (event) => {
            void handlePlayerExit(event);
          }),
        ];

        const isEmbeddedPreviewMode = shouldUseEmbeddedNativePreview;

        if (!isEmbeddedPreviewMode) {
          await prepareSystemUi();
        }

        // Ensure no other player is lingering before starting
        const handoffUrl = playbackUrl || url;
        const handoffAgeMs = nativeSessionHandoff ? Date.now() - nativeSessionHandoff.capturedAt : Number.POSITIVE_INFINITY;
        const canReuseNativeSession =
          Boolean(nativeSessionHandoff) &&
          handoffAgeMs <= NATIVE_SESSION_HANDOFF_WINDOW_MS &&
          nativeSessionHandoff?.url === handoffUrl;

        if (!canReuseNativeSession) {
          try {
            await NativeVideoPlayer.stopAllPlayers().catch(() => {});
          } catch (error) {
            console.warn('[VideoPlayer] Falha ao garantir stopAllPlayers antes de init:', error);
          }
        } else {
          console.log('[NativePlayer] Reutilizando sessão ativa para handoff preview/fullscreen');
        }
        nativeSessionHandoff = null;

        const isLive = isLiveStream || mediaType === 'live';
        const secureStreamUrl = isLive
          ? normalizePlayableUrl(playbackUrl || url)
          : loadMediaStream(playbackUrl || url, media?.type === 'series' ? 'mp4' : 'hls', true);

        const readEmbeddedBounds = () => {
          const host = previewHostRef.current;
          if (!host) return null;
          const rect = host.getBoundingClientRect();
          if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 2 || rect.height < 2) {
            return null;
          }
          return {
            x: Math.max(0, Math.round(rect.left)),
            y: Math.max(0, Math.round(rect.top)),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          };
        };

        let embeddedBounds = readEmbeddedBounds();
        if (isEmbeddedPreviewMode && !embeddedBounds) {
          for (let attempt = 0; attempt < 4 && !embeddedBounds; attempt += 1) {
            await new Promise<void>((resolve) => {
              window.requestAnimationFrame(() => resolve());
            });
            embeddedBounds = readEmbeddedBounds();
          }
        }

        if (isEmbeddedPreviewMode && !embeddedBounds) {
          throw new Error('Falha ao medir a area do preview para iniciar o player nativo embutido.');
        }

        console.log(`[NativePlayer] Iniciando stream nativo (${isEmbeddedPreviewMode ? 'embedded' : 'fullscreen'}): ${secureStreamUrl}`);
        touchBufferIndicator(isEmbeddedPreviewMode ? 'Conectando prévia nativa' : 'Conectando player nativo', {
          step: 8,
          cap: 90,
          attempt: 1,
          total: 1,
          forceResetTimer: true,
        });
        setInlineError(
          isEmbeddedPreviewMode
            ? 'Iniciando prévia nativa...'
            : `Iniciando Player Nativo...\nURL: ${secureStreamUrl.substring(0, 50)}...`,
        );

        const initOptions: Parameters<typeof NativeVideoPlayer.initPlayer>[0] = {
          url: secureStreamUrl,
          headers: nativePlayerHeaders,
          title: media?.title || 'Xandeflix',
          smallTitle: media?.category || (isLive ? 'Ao Vivo' : ''),
          artwork: media?.thumbnail || media?.backdrop || '',
          chromecast: !isEmbeddedPreviewMode,
          displayMode: isEmbeddedPreviewMode ? 'all' : 'landscape',
          startAtSec: !isLive && sessionResumePosition > 5 ? sessionResumePosition : 0,
        };

        if (isEmbeddedPreviewMode && embeddedBounds) {
          initOptions.embedded = true;
          initOptions.hideControls = true;
          initOptions.x = embeddedBounds.x;
          initOptions.y = embeddedBounds.y;
          initOptions.width = embeddedBounds.width;
          initOptions.height = embeddedBounds.height;
          initOptions.title = '';
          initOptions.smallTitle = '';
        }

        const result = await NativeVideoPlayer.initPlayer(initOptions);

        if (handledExitRef.current) {
          // Se o unmount aconteceu enquanto o player estava abrindo
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
        if (handledExitRef.current) {
          void NativeVideoPlayer.exitPlayer().catch(() => {});
          return;
        }

        console.error('[NativePlayer] Erro fatal ao iniciar:', playerError);
        removeListeners();
        clearProgressPolling();
        if (!shouldUseEmbeddedNativePreview) {
          await restoreSystemUi();
        }
        hideBufferIndicator();
        const reason = normalizeErrorMessage(playerError, 'Falha ao iniciar player nativo.');
        setError(reason);
        applyPlaybackDiagnostic({
          stage: 'native',
          reason,
          detail: 'Falha durante initPlayer.',
          url: maskSensitiveUrl(playbackUrl || url),
        });
        setPlayerState('error');
        flushTelemetry('fatal_error');
      }
    }, [applyPlaybackDiagnostic, clearProgressPolling, flushTelemetry, handleNativePlayerError, handlePlayerEvent, handlePlayerExit, hideBufferIndicator, isLiveStream, media?.backdrop, media?.category, media?.thumbnail, media?.title, media?.type, mediaType, nativePlayerHeaders, playbackUrl, prepareSystemUi, removeListeners, restoreSystemUi, shouldUseEmbeddedNativePreview, syncProgressFromNativePlayer, touchBufferIndicator, url]);

    useEffect(() => {
      let appStateListener: Promise<PluginListenerHandle> | null = null;
      if (Capacitor.getPlatform() === 'android' && !isPreview && !isMinimized) {
        appStateListener = (async () => {
           return await CapacitorApp.addListener('appStateChange', ({ isActive }: { isActive: boolean }) => {
             if (isActive && !openedPlayerRef.current && !handledExitRef.current) {
               console.log('[VideoPlayer] App voltou para foreground. Retomando player nativo...');
               void setupNativePlayer();
             }
           });
        })();
      }

      return () => {
        if (appStateListener) {
          appStateListener.then(h => h.remove());
        }
      };
    }, [isPreview, isMinimized, setupNativePlayer]);

    useEffect(() => {
      if (!shouldUseNativeBridgePlayer) {
        return;
      }

      void setupNativePlayer();

      return () => {
        handledExitRef.current = true;
        clearProgressPolling();
        removeListeners();
        if (openedPlayerRef.current) {
          const shouldKeepNativeSessionAlive =
            isNativePlatform &&
            isLiveStream &&
            suppressNativePreviewExitOnUnmountRef.current;

          if (shouldKeepNativeSessionAlive) {
            nativeSessionHandoff = {
              url: playbackUrl || url,
              embedded: shouldUseEmbeddedNativePreview,
              capturedAt: Date.now(),
            };
          } else {
            NativeVideoPlayer.exitPlayer().catch(() => {});
          }
        }
      };
    }, [
      shouldUseNativeBridgePlayer,
      url,
      setupNativePlayer,
      clearProgressPolling,
      isLiveStream,
      isNativePlatform,
      playbackUrl,
      removeListeners,
      shouldUseEmbeddedNativePreview,
    ]);

    const previewVideoRef = useRef<HTMLVideoElement>(null);
    const latestPreviewUrlRef = useRef(url);
    const suppressNativePreviewExitOnUnmountRef = useRef(suppressNativePreviewExitOnUnmount);
    const onPreviewRequestFullscreenRef = useRef(onPreviewRequestFullscreen);
    latestPreviewUrlRef.current = url;
    suppressNativePreviewExitOnUnmountRef.current = suppressNativePreviewExitOnUnmount;
    onPreviewRequestFullscreenRef.current = onPreviewRequestFullscreen;

    useEffect(() => {
      // Pipeline web: usado em navegadores e como fallback.
      // Quando o bridge nativo estiver ativo (fullscreen ou preview embutido), este efeito fica inativo.
      if (shouldUseNativeBridgePlayer) return;

      const video = previewVideoRef.current;
      if (!video) return;

      const secureWebUrl = normalizePlayableUrl(playbackUrl || url);
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
      let hlsMediaRecoveryAttempts = 0;
      let nativePromotionRequested = false;
      let hardPreviewFailureReported = false;

      // Fase 2.1: Debounce de inicialização para evitar colapso de memória em trocas rápidas
      const initDelay = isPreview ? 250 : 50;
      let initTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        playCurrentSource();
      }, initDelay);

      // Regra UX: na grade de canais, o preview deve permanecer inline.
      // Fullscreen só pode ocorrer por ação explícita do usuário (Enter/OK/click).
      const allowAutomaticPreviewPromotion = false;
      const registerPreviewDiagnostic = (
        reason: string,
        targetUrl: string,
        options?: {
          code?: string;
          detail?: string;
          httpStatus?: string;
        },
      ) => {
        applyPlaybackDiagnostic({
          stage: 'preview',
          reason,
          code: options?.code,
          detail: options?.detail,
          httpStatus: options?.httpStatus,
          url: maskSensitiveUrl(targetUrl),
        });
      };

      const triggerNativeFallback = (reason: string): boolean => {
        if (disposed) {
          return false;
        }

        if (canUseNativeFallback && !forceNativeFallback && !shouldPreferWebLiveFullscreen) {
          console.warn(`[VideoPlayer] Acionando fallback para player nativo: ${reason}`);
          touchBufferIndicator('Fallback para player nativo', {
            step: 6,
            cap: 92,
          });
          registerPreviewDiagnostic(reason, latestPreviewUrlRef.current || playbackUrl || url, {
            code: 'NATIVE_FALLBACK',
            detail: 'Preview falhou; fallback para ExoPlayer nativo.',
          });
          setInlineError('Abrindo player nativo...');
          setForceNativeFallback(true);
          return true;
        }

        if (
          isPreview &&
          isNativePlatform &&
          typeof onPreviewRequestFullscreenRef.current === 'function' &&
          !nativePromotionRequested
        ) {
          nativePromotionRequested = true;
          if (allowAutomaticPreviewPromotion) {
            console.warn(`[VideoPlayer] Preview falhou. Promovendo para fullscreen nativo: ${reason}`);
            touchBufferIndicator('Abrindo fullscreen nativo', {
              step: 6,
              cap: 92,
            });
            registerPreviewDiagnostic(reason, latestPreviewUrlRef.current || playbackUrl || url, {
              code: 'PROMOTE_FULLSCREEN_NATIVE',
              detail: 'Preview falhou; solicitada promocao para fullscreen nativo.',
            });
            setInlineError('Abrindo player nativo...');
            window.setTimeout(() => {
              if (!disposed) {
                onPreviewRequestFullscreenRef.current?.();
              }
            }, 120);
            return true;
          }
        }

        return false;
      };

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

      const resolveCurrentCandidateUrl = () =>
        candidates[candidateIndex] || latestPreviewUrlRef.current || playbackUrl || url;

      const failPreviewAndStop = (
        failureReason: string,
        failureCode: string,
        failureDetail: string,
        failureUrl?: string,
      ) => {
        if (disposed || hardPreviewFailureReported) {
          return;
        }

        const targetUrl = failureUrl || resolveCurrentCandidateUrl();

        // Fase 1.1: Rotina de Auto-Retry com Backoff
        if (retryCount < 3 && !isAutoRetrying) {
          console.warn(`[VideoPlayer] Falha terminal em todos os candidatos. Iniciando retry ${retryCount + 1}/3 em 5s...`);
          setRetryCount(prev => prev + 1);
          setIsAutoRetrying(true);
          setAutoRetrySeconds(5);
          
          let secondsLeft = 5;
          autoRetryTimerRef.current = setInterval(() => {
            secondsLeft -= 1;
            setAutoRetrySeconds(secondsLeft);
            if (secondsLeft <= 0) {
              if (autoRetryTimerRef.current) {
                clearInterval(autoRetryTimerRef.current);
                autoRetryTimerRef.current = null;
              }
              setIsAutoRetrying(false);
              candidateIndex = 0;
              playCurrentSource();
            }
          }, 1000);
          
          return;
        }

        hardPreviewFailureReported = true;
        setPreviewTerminalFailure(true);
        teardownCurrentSource();
        clearStartupTimeout();
        clearStallWatchdog();
        hideBufferIndicator();
        setInlineError('Falha ao abrir o canal');
        registerPreviewDiagnostic(failureReason, targetUrl, {
          code: failureCode,
          detail: failureDetail,
        });
        notifyPreviewFailure(targetUrl);
      };

      const advanceCandidateOrFail = (
        failureReason: string,
        failureCode: string,
        failureDetail: string,
        failureUrl?: string,
      ) => {
        if (disposed || hardPreviewFailureReported) {
          return;
        }

        const currentUrl = failureUrl || resolveCurrentCandidateUrl();
        const isConnectionFailure = isLikelyConnectionFailure({
          code: failureCode,
          reason: failureReason,
          detail: failureDetail,
        });
        const isRecoverableMediaFailure = isLikelyRecoverableMediaFailure({
          code: failureCode,
          reason: failureReason,
          detail: failureDetail,
        });
        const nextIndex = candidateIndex + 1;
        const attemptsDone = candidateIndex + 1;
        const tsPipelineLikely = shouldPreferTsPipeline(currentUrl);
        const shouldPromoteEarlyToNative =
          allowAutomaticPreviewPromotion
          && isRecoverableMediaFailure
          && (tsPipelineLikely || attemptsDone >= 2);

        if (!isConnectionFailure && !isRecoverableMediaFailure) {
          if (allowAutomaticPreviewPromotion && triggerNativeFallback(`${failureReason}: ${currentUrl}`)) {
            return;
          }
          failPreviewAndStop(
            failureReason,
            failureCode,
            `${failureDetail} -> erro nao relacionado a conexao, retries interrompidos na tentativa ${candidateIndex + 1}/${candidates.length}.`,
            currentUrl,
          );
          return;
        }

        if (shouldPromoteEarlyToNative && triggerNativeFallback(`${failureReason}: ${currentUrl}`)) {
          return;
        }

        if (nextIndex < candidates.length) {
          candidateIndex = nextIndex;
          liveRecoveryAttempts = 0;
          hlsMediaRecoveryAttempts = 0;
          registerPreviewDiagnostic(failureReason, currentUrl, {
            code: failureCode,
            detail: isRecoverableMediaFailure
              ? `${failureDetail} -> erro de midia recuperavel, tentando candidato ${nextIndex + 1}/${candidates.length}.`
              : `${failureDetail} -> tentando candidato ${nextIndex + 1}/${candidates.length}.`,
          });
          playCurrentSource();
          return;
        }

        if (triggerNativeFallback(`${failureReason}: ${currentUrl}`)) {
          return;
        }

        failPreviewAndStop(failureReason, failureCode, failureDetail, currentUrl);
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
        
        // Garantir que refs de erro e estados de falha sejam resetados para nova tentativa
        setInlineError(null);
        setPreviewTerminalFailure(false);
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

          // Tolerância de 20 segundos para redes instáveis de TV
          if (Date.now() - lastLiveProgressAt < 20000) {
            return;
          }

          if (liveRecoveryAttempts >= 2) {
            console.error('[Live-Stall] Sem progresso. Avancando para o proximo candidato.');
            advanceCandidateOrFail(
              'Stream congelada por excesso de stall',
              'STALL_TIMEOUT',
              'Fluxo sem progresso apos tentativas de reconexao.',
              resolveCurrentCandidateUrl(),
            );
            return;
          }

          liveRecoveryAttempts += 1;
          console.warn(`[Live-Stall] Stream congelada. Reiniciando canal (tentativa ${liveRecoveryAttempts})...`);
          setInlineError('Reconectando canal...');
          playCurrentSource();
        }, 2000);
      };

      const playCurrentSource = () => {
        if (disposed || hardPreviewFailureReported) return;
        setPreviewTerminalFailure(false);
        setInlineError(null);

        teardownCurrentSource();
        const currentUrl = candidates[candidateIndex];
        touchBufferIndicator(`Carregando buffer (${candidateIndex + 1}/${candidates.length})`, {
          step: candidateIndex === 0 ? 7 : 4,
          cap: 94,
          attempt: candidateIndex + 1,
          total: candidates.length,
          forceResetTimer: candidateIndex === 0,
        });
        console.log(`[VideoPlayer-Preview] Tentando carregar candidato [${candidateIndex}]: ${currentUrl}`);
        const startupTimeoutMs = !isLiveStream ? 8000 : (isPreview ? 22000 : 24000);
        startupTimeoutId = setTimeout(() => {
          if (disposed) return;
          console.error('[Preview] Timeout para iniciar stream:', currentUrl);
          advanceCandidateOrFail(
            'Timeout ao iniciar stream',
            'PREVIEW_TIMEOUT',
            `Nenhum dado reproduzivel em ${startupTimeoutMs}ms.`,
            currentUrl,
          );
        }, startupTimeoutMs);

        const canUseNativeHlsTag = video.canPlayType('application/vnd.apple.mpegurl') !== '';
        const shouldUseHls = isLikelyHlsUrl(currentUrl) && !shouldPreferTsPipeline(currentUrl);
        
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
            maxBufferLength: isSportsChannel ? 60 : (isLiveStream ? 20 : 40), 
            maxMaxBufferLength: isSportsChannel ? 120 : (isLiveStream ? 40 : 120),
            maxBufferSize: isSportsChannel ? 80 * 1024 * 1024 : (isLiveStream ? 30 * 1024 * 1024 : 60 * 1024 * 1024),
            manifestLoadingTimeOut: 30000,
            levelLoadingTimeOut: 30000,
            fragLoadingTimeOut: 30000,
            manifestLoadingMaxRetry: 8,
            levelLoadingMaxRetry: 8,
            fragLoadingMaxRetry: 10,
            fragLoadingRetryDelay: 1000,
            xhrSetup: (xhr: XMLHttpRequest) => {
              if (!hasStreamHeaders) {
                return;
              }
              streamHeaderEntries.forEach(([headerName, headerValue]) => {
                try {
                  xhr.setRequestHeader(headerName, headerValue);
                } catch (headerError) {
                  console.warn(`[HLS] Header bloqueado no WebView (${headerName}):`, headerError);
                }
              });
            },
          });
          
          hlsRef.current = hls;

          hls.loadSource(currentUrl);
          hls.attachMedia(video);

          hlsManifestParsedHandler = () => {
            if (disposed || hardPreviewFailureReported) return;
            clearStartupTimeout();
            setPreviewTerminalFailure(false);
            setPlaybackDiagnostic(null);
            setInlineError(null);
            completeBufferIndicator();
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
                console.warn('[HLS] Falha de rede irrecuperável ou timeout, tentando proxima fonte...', data);
                if (data.response && data.response.code) {
                  console.warn(`[HLS] Código HTTP do erro: ${data.response.code}`);
                }
                advanceCandidateOrFail(
                  'Falha de rede no HLS',
                  'HLS_NETWORK_ERROR',
                  String(data.details || data.reason || 'Erro de rede fatal no HLS.'),
                  currentUrl,
                );
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.warn('[HLS] Erro de mídia fatal detectado, tentando recuperar buffers...', data);
                if (hlsMediaRecoveryAttempts < 1) {
                  hlsMediaRecoveryAttempts += 1;
                  hls.recoverMediaError();
                } else {
                  advanceCandidateOrFail(
                    'Erro de mídia no HLS',
                    'HLS_MEDIA_ERROR',
                    String(data.details || data.reason || 'Falha de mídia sem recuperação.'),
                    currentUrl,
                  );
                }
                break;
              default:
                console.error('[HLS] Erro fatal desconhecido, falhando para o próximo candidato.', data);
                advanceCandidateOrFail(
                  'Erro fatal no pipeline HLS',
                  String(data.type || 'HLS_FATAL'),
                  String(data.details || data.reason || ''),
                  currentUrl,
                );
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
            const mediaDataSource: Record<string, unknown> = {
              type: 'mpegts',
              isLive: isLiveStream,
              url: currentUrl,
            };

            if (hasStreamHeaders) {
              mediaDataSource.headers = Object.fromEntries(streamHeaderEntries);
            }

            const player = mpegts.createPlayer(mediaDataSource as any, {
              enableWorker: true,
              liveBufferLatencyChasing: false, // Desativado: evita pulos (stuttering) para alcançar o "ao vivo"
              liveBufferLatencyMaxLatency: isSportsChannel ? 15 : 10,
              liveBufferLatencyMinRemain: 3.0,
              lazyLoad: false,
              lazyLoadMaxDuration: isSportsChannel ? 60 : (isLiveStream ? 30 : 120),
              lazyLoadRecoverDuration: isSportsChannel ? 30 : (isLiveStream ? 15 : 60),
            });

            mpegtsPlayerRef.current = player;
            player.attachMediaElement(video);
            player.load();

            player.on(mpegts.Events.ERROR, (errorType: string, errorDetail: string, errorInfo: any) => {
              console.error(`[mpegts.js] Erro: type=${errorType}, detail=${errorDetail}`, errorInfo);
              advanceCandidateOrFail(
                'Erro fatal no pipeline MPEGTS',
                String(errorType || 'MPEGTS_FATAL'),
                String(errorDetail || ''),
                currentUrl,
              );
            });

            // Quando o MediaSource receber dados, tentar play
            loadedMetadataHandler = () => {
              if (disposed || hardPreviewFailureReported) return;
              clearStartupTimeout();
              void video.play().catch((e) => console.warn('[mpegts] play() rejeitado:', e));
            };
            playingHandler = () => {
              if (disposed || hardPreviewFailureReported) return;
              clearStartupTimeout();
              setPreviewTerminalFailure(false);
              setPlaybackDiagnostic(null);
              setInlineError(null);
              completeBufferIndicator();
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
          if (disposed || hardPreviewFailureReported) return;
          clearStartupTimeout();
          void video.play().catch((playError) => {
            console.error(`[Preview] Erro ao iniciar play (${eventName}):`, playError);
          });
        };

        loadedMetadataHandler = () => {
          if (!isLiveStream && !isPreview && sessionResumePositionRef.current > 5) {
            console.log('[VideoPlayer] Resuming Web playback at:', sessionResumePositionRef.current);
            video.currentTime = sessionResumePositionRef.current;
          }
          tryStartPlayback('loadedmetadata');
        };
        canPlayHandler = () => {
          tryStartPlayback('canplay');
        };
        playingHandler = () => {
          if (disposed || hardPreviewFailureReported) return;
          clearStartupTimeout();
          setPreviewTerminalFailure(false);
          setPlaybackDiagnostic(null);
          setInlineError(null);
          completeBufferIndicator();
          startLiveStallWatchdog();
        };
        nativeErrorHandler = () => {
          const err = video.error;
          console.error(`[Preview] MediaError nativo: code=${err?.code}, msg=${err?.message} url=${currentUrl}`);
          advanceCandidateOrFail(
            'MediaError no elemento de vídeo',
            err?.code ? `MEDIA_ERR_${err.code}` : 'MEDIA_ERR_UNKNOWN',
            String(err?.message || ''),
            currentUrl,
          );
        };
        timeUpdateHandler = () => {
          const currentTime = video.currentTime || 0;
          lastKnownTimeRef.current = Math.max(0, Math.floor(currentTime));
          
          if (!isLiveStream && !isPreview) {
            persistProgress(currentTime, video.duration);
          }

          lastObservedLiveTime = currentTime;
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

      return () => {
        disposed = true;
        hideBufferIndicator();
        if (initTimer) clearTimeout(initTimer);
        
        if (autoRetryTimerRef.current) {
          clearInterval(autoRetryTimerRef.current);
          autoRetryTimerRef.current = null;
        }
        
        if (!isLiveStream && !isPreview) {
          syncProgressToSupabase(lastKnownTimeRef.current, { force: true });
        }
        
        clearStartupTimeout();
        clearStallWatchdog();
        removeVideoEventListeners();

        // Se estivermos saindo da tela, fazemos a limpeza pesada.
        // Caso contrário, deixamos o vídeo anterior visível até o próximo play.
        if (isUnmountingRef.current) {
          destroyMpegtsInstance();
          destroyHlsInstance();
          releaseHtml5Video();
        }
      };
    }, [
      canUseNativeFallback,
      shouldPreferWebLiveFullscreen,
      forceNativeFallback,
      hasStreamHeaders,
      isLiveStream,
      isPreview,
      media?.category,
      media?.title,
      persistProgress,
      playbackUrl,
      shouldUseNativeBridgePlayer,
      streamHeaderEntries,
      syncProgressToSupabase,
      url,
      isNativePlatform,
      applyPlaybackDiagnostic,
      completeBufferIndicator,
      hideBufferIndicator,
      touchBufferIndicator,
    ]);



    const fallbackPoster = media?.backdrop || media?.thumbnail || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const shouldShowPreviewFailureOverlay = isPreview && previewTerminalFailure;
    const shouldShowSimpleErrorOverlay = !isPreview && Boolean(inlineError || error);
    const shouldShowLiveTopOverlay = !isPreview && isLiveStream;
    const isLiveUiVisible = isControlsVisible || isChannelBrowserOpen;
    const liveChannelTitle = media?.title || 'Canal Ao Vivo';

    return (
    <>
      <div 
        ref={previewHostRef}
        className={`relative h-full w-full bg-black ${
          isPreview && !isNativePlatform ? 'overflow-hidden rounded-2xl shadow-2xl' : ''
        }`}
        onMouseMove={showControls}
        onClick={() => {
          if (!isPreview && !isChannelBrowserOpen) {
            void togglePlayPause();
          }
        }}
      >
        {shouldUseNativeBridgePlayer ? (
          <>
            {playerState !== 'ready' && (
              <div className="absolute inset-0 bg-black" />
            )}
            {playerState !== 'ready' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/35 px-3 text-center text-[11px] font-semibold tracking-wide text-white/90">
                {error ? `Previa indisponivel: ${error}` : 'Carregando previa...'}
              </div>
            )}
          </>
        ) : (
          <video
            ref={previewVideoRef}
            className={`h-full w-full ${
              isPreview ? 'transform-gpu' : 'transition-transform duration-300'
            } ${videoObjectFitClass}`}
            style={{ transform: 'translateZ(0)' }}
            autoPlay
            muted={false}
            playsInline
            poster={isPreview || isLiveStream ? undefined : fallbackPoster}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={() => {
              const video = previewVideoRef.current;
              if (!video || !nextEpisode || isLiveStream || isPreview) return;
              const timeRemaining = video.duration - video.currentTime;
              if (timeRemaining > 0 && timeRemaining < 10 && autoNextCountdown === null) {
                startAutoNextCountdown();
              }
            }}
            onEnded={() => {
              if (nextEpisode && !isLiveStream && !isPreview) {
                if (autoNextCountdown === null) {
                  onPlayNextEpisode?.();
                }
              } else if (!isLiveStream) {
                void closeNativePlayer();
              }
            }}
          />
        )}
        {shouldShowPreviewFailureOverlay && (
           <div className="absolute inset-0 z-[20] flex flex-col items-center justify-center bg-black/78 px-4 text-center">
             <div className="text-[12px] font-bold uppercase tracking-wide text-red-500">Sem Sinal</div>
             <div className="mt-1 text-[12px] text-white/80">
               {inlineError || 'Falha no carregamento do canal'}
             </div>
             
             {isAutoRetrying && (
               <div className="mt-4 flex flex-col items-center gap-2">
                 <div className="h-1 w-24 bg-white/10 rounded-full overflow-hidden">
                   <div 
                     className="h-full bg-red-600 transition-all duration-1000" 
                     style={{ width: `${(5 - autoRetrySeconds) * 20}%` }}
                   />
                 </div>
                 <div className="text-[10px] font-bold text-white/60 animate-pulse">
                   RECONECTANDO EM {autoRetrySeconds}s...
                 </div>
               </div>
             )}
           </div>
        )}
        {shouldShowSimpleErrorOverlay && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 z-[90] rounded-md border border-red-500/30 bg-black/85 px-4 py-2 text-[12px] font-semibold text-red-200">
            {inlineError || error}
          </div>
        )}
        
        {/* Auto Next Countdown Overlay */}
        {autoNextCountdown !== null && nextEpisode && (
          <div className="absolute bottom-16 right-6 z-[60] rounded-md border border-white/20 bg-black/85 px-4 py-3">
            <div className="text-xs font-semibold text-white">
              Próximo episódio em {autoNextCountdown}s
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  cancelAutoNext();
                  onPlayNextEpisode?.();
                }}
                className="rounded-md border border-white/20 bg-black/40 px-3 py-1 text-xs font-semibold text-white"
              >
                Assistir agora
              </button>
              <button
                onClick={cancelAutoNext}
                className="rounded-md border border-white/20 bg-black/40 px-3 py-1 text-xs font-semibold text-white"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {shouldShowLiveTopOverlay && (
          <div
            className={`pointer-events-none absolute left-0 right-0 top-0 z-[70] flex items-start justify-between px-6 py-5 transition-opacity duration-300 ${
              isLiveUiVisible ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (canShowChannelBrowser) {
                  setIsChannelBrowserOpen((prev) => !prev);
                }
              }}
              className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-white/35 bg-black/65 text-white shadow-[0_8px_24px_rgba(0,0,0,0.45)] transition-colors hover:bg-black/80 ${
                isLiveUiVisible ? 'pointer-events-auto' : 'pointer-events-none'
              }`}
              aria-label="Abrir menu de canais"
              title="Abrir menu de canais"
            >
              <Menu size={28} />
            </button>
            <div className="pointer-events-none max-w-[68vw] rounded-2xl border border-white/20 bg-black/60 px-6 py-3 text-right text-[26px] font-black tracking-tight text-white shadow-[0_8px_24px_rgba(0,0,0,0.45)] font-['Outfit']">
              <span className="line-clamp-1">{liveChannelTitle}</span>
            </div>
          </div>
        )}

        {!isPreview && isLiveStream && (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 z-[64] bg-gradient-to-t from-black/95 via-black/72 to-transparent px-6 pb-6 pt-20 transition-all duration-300 ${
              isLiveUiVisible ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
            }`}
          >
            <div className="rounded-2xl border border-white/18 bg-black/42 px-5 py-4 shadow-[0_10px_26px_rgba(0,0,0,0.5)] backdrop-blur-[2px]">
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-white/20 bg-black/40">
                  {media?.thumbnail ? (
                    <img
                      src={media.thumbnail}
                      alt={media?.title || 'Canal'}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs font-black uppercase tracking-[0.2em] text-white/70">
                      TV
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="mb-1 truncate text-[12px] font-black uppercase tracking-[0.14em] text-white/60 font-['Outfit']">
                    {media?.category ? `Grupo: ${media.category}` : 'Canal ao vivo'}
                  </div>
                  <div className="truncate text-[34px] leading-none font-black text-white font-['Outfit']">
                    {liveChannelTitle}
                  </div>

                  <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-[15px] font-semibold text-white/90 font-['Outfit']">
                    <div className="truncate">
                      {currentLiveProgram
                        ? `${formatProgramTime(currentLiveProgram.start)} ${currentLiveProgram.title}`
                        : 'Programação indisponível'}
                    </div>
                    <div className="text-white/45">|</div>
                    <div className="truncate text-right text-white/75">
                      {nextLiveProgram
                        ? `${formatProgramTime(nextLiveProgram.start)} ${nextLiveProgram.title}`
                        : 'Sem próximo no EPG'}
                    </div>
                  </div>

                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/18">
                    <div
                      className="h-full rounded-full bg-red-500 transition-all duration-500"
                      style={{ width: `${liveProgramProgress}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {!isPreview && !isLiveStream && (
          <div
            className={`
              absolute inset-x-0 bottom-0 z-50 bg-black/75 px-4 py-3
              transition-opacity duration-200 ease-out
              ${isControlsVisible || !isPlaying ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
            `}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="truncate text-sm font-semibold text-white">
                {media?.title || 'Xandeflix Player'}
              </div>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void closeNativePlayer();
                }}
                className="rounded-md border border-white/20 bg-black/40 px-2 py-1 text-white"
                aria-label="Fechar player"
              >
                <X size={16} />
              </button>
            </div>

            {!isLiveStream && (
              <div className="mb-3">
                <ProgressBar videoRef={previewVideoRef} />
                <div className="mt-1 flex items-center justify-between text-[11px] text-white/70">
                  <TimeDisplay videoRef={previewVideoRef} />
                  <span>
                    {previewVideoRef.current?.duration
                      ? new Date(previewVideoRef.current.duration * 1000).toISOString().substring(11, 19)
                      : '--:--:--'}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              {canShowChannelBrowser && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setIsChannelBrowserOpen((prev) => !prev);
                  }}
                  className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-xs font-semibold text-white"
                >
                  {isChannelBrowserOpen ? 'Ocultar Canais' : 'Canais'}
                </button>
              )}

              {!isLiveStream && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    seek(-10);
                  }}
                  className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-xs font-semibold text-white"
                >
                  -10s
                </button>
              )}

              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void togglePlayPause();
                }}
                className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-xs font-semibold text-white"
              >
                {isPlaying ? 'Pausar' : 'Reproduzir'}
              </button>

              {!isLiveStream && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    seek(10);
                  }}
                  className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-xs font-semibold text-white"
                >
                  +10s
                </button>
              )}

              <button
                onClick={(event) => {
                  event.stopPropagation();
                  toggleMute();
                }}
                className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-xs font-semibold text-white"
              >
                {isMuted ? 'Som Off' : 'Som On'}
              </button>

              {nextEpisode && !isLiveStream && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlayNextEpisode?.();
                  }}
                  className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-xs font-semibold text-white"
                >
                  Próximo Episódio
                </button>
              )}
            </div>
          </div>
        )}

        {/* Channel Browser Sidebar (Live TV) */}
        {canShowChannelBrowser && isChannelBrowserOpen && (
          <>
            <div
              className="absolute left-0 top-0 z-[100] h-full w-[520px] max-w-[76vw] overflow-hidden border-r border-white/10 bg-zinc-900/98 animate-in slide-in-from-left duration-300"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-white/10 bg-black/50 px-6 py-6">
                <div className="text-sm font-black uppercase tracking-[0.2em] text-red-500 font-['Outfit']">Navegador de Canais</div>
                <button
                  type="button"
                  onClick={() => setIsChannelBrowserOpen(false)}
                  className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-black text-white/85 font-['Outfit'] uppercase"
                >
                  Fechar
                </button>
              </div>

              <div className="grid h-[calc(100%-80px)] min-h-0 grid-cols-[190px_1fr] overflow-hidden">
                <div className="min-h-0 overflow-y-auto border-r border-white/10 bg-black/40 p-4">
                  {liveBrowserCategories.map((category) => {
                    const selected = (activeBrowserCategory?.id || '') === category.id;
                    return (
                      <button
                        key={`live-cat-${category.id}`}
                        id={`live-cat-${category.id}`}
                        type="button"
                        data-nav-id={`live-cat-${category.id}`}
                        ref={(el) => {
                          if (el) registerNode(`live-cat-${category.id}`, el, 'modal-live-categories', {
                            onFocus: () => {
                              setChannelGroupId(category.id);
                              setChannelSearchQuery('');
                            },
                            disableAutoScroll: true,
                          });
                        }}
                        onClick={() => {
                          setChannelGroupId(category.id);
                          setChannelSearchQuery('');
                        }}
                        className="mb-2 w-full rounded-xl px-4 py-3 text-left text-[11px] font-black uppercase tracking-wide transition-colors font-['Outfit']"
                        style={{
                          color: selected ? '#fff' : 'rgba(255,255,255,0.5)',
                          background: selected ? 'rgba(229,9,20,0.3)' : 'transparent',
                          border: selected ? '1px solid rgba(229,9,20,0.5)' : '1px solid transparent',
                        }}
                      >
                        {category.title}
                      </button>
                    );
                  })}
                </div>

                <div className="flex h-full min-h-0 flex-col overflow-hidden bg-black/35 p-4">
                  <div className="relative mb-4">
                    <input
                      value={channelSearchQuery}
                      onChange={(event) => setChannelSearchQuery(event.target.value)}
                      placeholder="Buscar canal..."
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-black text-white outline-none focus:border-red-500/50 transition-colors font-['Outfit']"
                    />
                  </div>
                  <div ref={channelListContainerRef} className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide">
                    {browserChannels.map((channel) => {
                      const selected = channel.id === media?.id || channel.videoUrl === url;
                      return (
                        <button
                          key={`live-channel-${channel.id}`}
                          id={`live-channel-${channel.id}`}
                          type="button"
                          data-nav-id={`live-channel-${channel.id}`}
                          ref={(el) => {
                            if (el) registerNode(`live-channel-${channel.id}`, el, 'modal-live-channels', {
                              onEnter: () => {
                                onZap?.(channel);
                                setIsChannelBrowserOpen(false);
                              },
                              disableAutoScroll: true,
                            });
                          }}
                          onClick={() => {
                            onZap?.(channel);
                            setIsChannelBrowserOpen(false);
                          }}
                          className="mb-3 w-full rounded-2xl px-4 py-4 text-left transition-transform hover:scale-[1.02] active:scale-98"
                          style={{
                            background: selected ? 'linear-gradient(45deg, rgba(229,9,20,0.2), rgba(229,9,20,0.05))' : 'rgba(255,255,255,0.03)',
                            border: selected ? '1px solid rgba(229,9,20,0.4)' : '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          <div className="truncate text-base font-black text-white font-['Outfit'] tracking-tight">{channel.title}</div>
                          <div className="truncate text-[10px] font-black uppercase tracking-widest text-white/40 font-['Outfit'] mt-1">{channel.category}</div>
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
            className="absolute left-2 top-2 z-20 rounded-md bg-black/70 px-2 py-1 text-[10px] font-black tracking-wide text-white/90 font-['Outfit']"
          >
            TOQUE PARA AMPLIAR
          </button>
        )}
      </div>
    </>
    );
  },
), (prev, next) => {
  // O Player só deve re-renderizar se a mídia real mudar ou o estado de preview mudar.
  // Mudanças de foco no grid pai são ignoradas.
  return (
    prev.url === next.url &&
    prev.media?.id === next.media?.id &&
    prev.isPreview === next.isPreview &&
    prev.isMinimized === next.isMinimized &&
    prev.showChannelSidebar === next.showChannelSidebar
  );
});

VideoPlayer.displayName = 'VideoPlayer';
