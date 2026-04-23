import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { StatusBar } from '@capacitor/status-bar';
import { LoaderCircle, X, Play, Pause, Volume2, VolumeX, FastForward, Rewind, Activity, SlidersHorizontal, ChevronDown } from 'lucide-react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import type { Category, Media } from '../types';
import { useStore } from '../store/useStore';
import { NetworkDiagnostic } from './NetworkDiagnostic';
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
type BufferIndicatorState = {
  visible: boolean;
  label: string;
  progress: number;
  phase: number;
  startedAt: number;
  attempt: number;
  total: number;
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
type StreamSourceResolution = {
  originalUrl: string;
  playbackUrl: string;
  headers: Record<string, string>;
  hasHeaderHints: boolean;
};
const PLAYBACK_PROGRESS_SYNC_INTERVAL_MS = 15000;
const MIN_PROGRESS_DELTA_SECONDS = 3;
const TABLET_MIN_WIDTH = 768;
const SWIPE_UP_MIN_DISTANCE_PX = 70;
const SWIPE_MAX_HORIZONTAL_DRIFT_PX = 160;
const SWIPE_MAX_DURATION_MS = 900;
const REMOTE_OK_KEYCODES = new Set([13, 23, 66]);
const DEFAULT_NATIVE_USER_AGENT = 'VLC/3.0.21 LibVLC/3.0.21';

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
      nextEpisode = null,
      onPlayNextEpisode,
    },
    ref,
  ) => {
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
    const epgData = useStore((state) => state.epgData);
    const playlistCategories = useStore((state) => state.playlistCategories);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
      if (!isLiveStream) return;
      const interval = setInterval(() => setNow(Date.now()), 30000);
      return () => clearInterval(interval);
    }, [isLiveStream]);

    const normalizeKey = useCallback((value: string | null | undefined) => {
      const raw = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\b(canal|channel|tv|hd|fhd|h265|h264|sd|4k|uhd)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
      return raw;
    }, []);

    const currentProgram = useMemo(() => {
      if (!isLiveStream || !media || !epgData) {
        return null;
      }
      
      const tvgId = (media as any).tvgId?.toLowerCase();
      const tvgName = (media as any).tvgName?.toLowerCase();
      
      let programs = (tvgId ? epgData[tvgId] : null) || (tvgName ? epgData[tvgName] : null) || [];
      
      if (programs.length === 0) {
        const titleKey = normalizeKey(media.title);
        
        // 1. Tentar match exato com as chaves (ID ou Nomes normalizados no parser)
        const match = Object.entries(epgData).find(([key]) => {
          const normalizedKey = normalizeKey(key);
          return normalizedKey === titleKey;
        });

        if (match) {
          programs = match[1];
        } else {
          // 2. Tentar match parcial (fuzzy) - se o título do canal estiver contido na chave do EPG ou vice-versa
          const fuzzyMatch = Object.entries(epgData).find(([key]) => {
            const normalizedKey = normalizeKey(key);
            if (!normalizedKey || !titleKey) return false;
            return (titleKey.length >= 4 && normalizedKey.includes(titleKey)) || 
                   (normalizedKey.length >= 4 && titleKey.includes(normalizedKey));
          });
          if (fuzzyMatch) programs = fuzzyMatch[1];
        }
      }

      const found = programs.find(p => now >= p.start && now < p.stop) || null;
      return found;
    }, [isLiveStream, media, epgData, now, normalizeKey]);

    const nextProgram = useMemo(() => {
      if (!isLiveStream || !media || !epgData || !currentProgram) return null;
      
      const tvgId = (media as any).tvgId?.toLowerCase();
      const tvgName = (media as any).tvgName?.toLowerCase();
      
      let programs = (tvgId ? epgData[tvgId] : null) || (tvgName ? epgData[tvgName] : null) || [];
      
      if (programs.length === 0) {
        const titleKey = normalizeKey(media.title);
        const match = Object.entries(epgData).find(([key]) => {
          const normalizedKey = normalizeKey(key);
          if (!normalizedKey || !titleKey) return false;
          return normalizedKey === titleKey || 
                 (titleKey.length >= 4 && normalizedKey.includes(titleKey)) || 
                 (normalizedKey.length >= 4 && titleKey.includes(normalizedKey));
        });
        if (match) programs = match[1];
      }

      const sorted = [...programs].sort((a, b) => a.start - b.start);
      return sorted.find(p => p.start >= currentProgram.stop) || null;
    }, [isLiveStream, media, epgData, currentProgram, normalizeKey]);

    const currentProgramProgress = useMemo(() => {
      if (!currentProgram) return 0;
      const total = currentProgram.stop - currentProgram.start;
      const elapsed = now - currentProgram.start;
      return Math.min(100, Math.max(0, (elapsed / total) * 100));
    }, [currentProgram, now]);

    const [forceNativeFallback, setForceNativeFallback] = useState(false);
    
    // TVs Philips e Android TVs no geral precisam do Player Nativo (ExoPlayer) para rodar Live TV.
    // O player web (MSE) costuma dar TIMEOUT ou erro de codec nessas TVs.
    const canUseNativeFallback = isNativePlatform && !isPreview;
    
    // Força o player nativo em Android para canais ao vivo, exceto se for explicitamente um tablet pequeno.
    // Em TVs, window.innerWidth é grande, então vamos focar na plataforma.
    const isAndroid = Capacitor.getPlatform() === 'android';
    const shouldUseNativePlayer = canUseNativeFallback && (forceNativeFallback || (isAndroid && isLiveStream));
    const shouldUseEmbeddedNativePreview = isAndroid && isNativePlatform && isPreview && isLiveStream;
    const shouldUseNativeBridgePlayer = shouldUseNativePlayer || shouldUseEmbeddedNativePreview;
    const savePlaybackProgress = useStore((state) => state.savePlaybackProgress);
    const [isChannelBrowserOpen, setIsChannelBrowserOpen] = useState(false);
    const [isRelatedVisible, setIsRelatedVisible] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [videoScale, setVideoScale] = useState<'fit' | 'fill' | 'zoom'>('fit');
    const touchSwipeStartRef = useRef<{ x: number; y: number; startedAt: number } | null>(null);
    const suppressTapAfterSwipeRef = useRef(false);
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

    const relatedMedia = useMemo(() => {
      if (!media || isLiveStream || isPreview) return [];
      const categoryItems = playlistCategories[media.category] || [];
      return categoryItems
        .filter(item => item.id !== media.id)
        .slice(0, 15)
        .map(item => ({
           id: item.id,
           title: item.title,
           thumbnail: item.logo,
           backdrop: item.logo,
           category: item.group || media.category,
           videoUrl: item.url,
           type: (item.type as any) || 'movie',
           description: '',
           rating: '',
           year: 0
        } as Media));
    }, [isLiveStream, isPreview, media, playlistCategories]);

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
    const [playbackDiagnostic, setPlaybackDiagnostic] = useState<PlaybackDiagnostic | null>(null);
    const [previewTerminalFailure, setPreviewTerminalFailure] = useState(false);
    const [bufferIndicator, setBufferIndicator] = useState<BufferIndicatorState>({
      visible: false,
      label: '',
      progress: 0,
      phase: 0,
      startedAt: 0,
      attempt: 0,
      total: 0,
    });
    const bufferHideTimerRef = useRef<number | null>(null);
    const hideBufferIndicator = useCallback(() => {
      if (bufferHideTimerRef.current) {
        window.clearTimeout(bufferHideTimerRef.current);
        bufferHideTimerRef.current = null;
      }
      setBufferIndicator((prev) => ({
        ...prev,
        visible: false,
        label: '',
        progress: 0,
        phase: 0,
        startedAt: 0,
        attempt: 0,
        total: 0,
      }));
    }, []);
    const touchBufferIndicator = useCallback(
      (
        label: string,
        options?: {
          step?: number;
          cap?: number;
          attempt?: number;
          total?: number;
          forceResetTimer?: boolean;
        },
      ) => {
        const step = options?.step ?? 2;
        const cap = options?.cap ?? 95;
        const attempt = options?.attempt;
        const total = options?.total;
        const forceResetTimer = options?.forceResetTimer ?? false;
        const now = Date.now();

        setBufferIndicator((prev) => {
          const baseProgress =
            !prev.visible || forceResetTimer
              ? Math.max(4, Math.min(18, step * 2))
              : Math.min(cap, prev.progress + step);

          return {
            visible: true,
            label: label || prev.label || 'Carregando stream',
            progress: baseProgress,
            phase: prev.visible ? prev.phase : 0,
            startedAt: !prev.visible || forceResetTimer ? now : prev.startedAt,
            attempt: typeof attempt === 'number' ? attempt : prev.attempt,
            total: typeof total === 'number' ? total : prev.total,
          };
        });
      },
      [],
    );
    const completeBufferIndicator = useCallback(() => {
      if (bufferHideTimerRef.current) {
        window.clearTimeout(bufferHideTimerRef.current);
        bufferHideTimerRef.current = null;
      }
      setBufferIndicator((prev) => ({
        ...prev,
        visible: true,
        progress: 100,
        phase: prev.phase,
      }));
      bufferHideTimerRef.current = window.setTimeout(() => {
        hideBufferIndicator();
      }, 420);
    }, [hideBufferIndicator]);

    useEffect(() => {
      if (!bufferIndicator.visible) {
        return;
      }

      const intervalId = window.setInterval(() => {
        setBufferIndicator((prev) => {
          if (!prev.visible) return prev;

          const driftStep =
            prev.progress < 35 ? 4.6
              : prev.progress < 68 ? 2.2
              : prev.progress < 90 ? 0.9
              : 0.2;
          const nextProgress = prev.progress >= 99 ? prev.progress : Math.min(95, prev.progress + driftStep);

          return {
            ...prev,
            phase: (prev.phase + 1) % 4,
            progress: nextProgress,
          };
        });
      }, 340);

      return () => {
        clearInterval(intervalId);
      };
    }, [bufferIndicator.visible]);

    useEffect(() => {
      return () => {
        if (bufferHideTimerRef.current) {
          window.clearTimeout(bufferHideTimerRef.current);
          bufferHideTimerRef.current = null;
        }
      };
    }, []);

    const [playerState, setPlayerState] = useState<NativePlayerState>(
      shouldUseNativeBridgePlayer ? 'opening' : 'error',
    );
    const [error, setError] = useState<string | null>(
      shouldUseNativeBridgePlayer ? null : 'O player nativo esta disponivel apenas no app Android/Capacitor.',
    );
    const [inlineError, setInlineError] = useState<string | null>(null);
    const applyPlaybackDiagnostic = useCallback(
      (diagnostic: Omit<PlaybackDiagnostic, 'timestamp'>) => {
        setPlaybackDiagnostic({
          ...diagnostic,
          timestamp: Date.now(),
        });
      },
      [],
    );

    useEffect(() => {
      setForceNativeFallback(false);
      setInlineError(null);
      setPlaybackDiagnostic(null);
      setPreviewTerminalFailure(false);
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
      controlsTimerRef.current = setTimeout(() => setIsControlsVisible(false), 8000);
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

    const openRelatedDrawer = useCallback(() => {
      if (isLiveStream || isPreview || relatedMedia.length === 0) {
        return false;
      }
      setIsSettingsOpen(false);
      setIsChannelBrowserOpen(false);
      setIsRelatedVisible(true);
      showControls();
      return true;
    }, [isLiveStream, isPreview, relatedMedia.length, showControls]);

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
             if (openRelatedDrawer()) {
               e.preventDefault();
             }
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
          if (isRelatedVisible) {
            setIsRelatedVisible(false);
          } else if (isChannelBrowserOpen) {
            setIsChannelBrowserOpen(false);
          } else {
            onClose();
          }
          e.preventDefault();
        }
      };

      window.addEventListener('keydown', handleTvKey);
      return () => window.removeEventListener('keydown', handleTvKey);
    }, [isLiveStream, isPreview, isRelatedVisible, isChannelBrowserOpen, handleZap, onClose, openRelatedDrawer, seek, shouldUseNativePlayer, showControls, togglePlayPause]);

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
        try {
          await NativeVideoPlayer.stopAllPlayers().catch(() => {});
        } catch (error) {
          console.warn('[VideoPlayer] Falha ao garantir stopAllPlayers antes de init:', error);
        }

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
    }, [applyPlaybackDiagnostic, clearProgressPolling, flushTelemetry, handleNativePlayerError, handlePlayerEvent, handlePlayerExit, hideBufferIndicator, isLiveStream, media?.backdrop, media?.category, media?.thumbnail, media?.title, media?.type, nativePlayerHeaders, playbackUrl, prepareSystemUi, removeListeners, restoreSystemUi, shouldUseEmbeddedNativePreview, syncProgressFromNativePlayer, touchBufferIndicator, url]);

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
          NativeVideoPlayer.exitPlayer().catch(() => {});
        }
      };
    }, [shouldUseNativeBridgePlayer, url, setupNativePlayer, clearProgressPolling, removeListeners]);

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

        if (canUseNativeFallback && !forceNativeFallback) {
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

        hardPreviewFailureReported = true;
        setPreviewTerminalFailure(true);
        teardownCurrentSource();
        clearStartupTimeout();
        clearStallWatchdog();
        hideBufferIndicator();
        const targetUrl = failureUrl || resolveCurrentCandidateUrl();
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
            maxBufferLength: isSportsChannel ? 120 : (isLiveStream ? 30 : 60), // 120s para Esportes, 30s para Live normal, 60s para VOD
            maxMaxBufferLength: isSportsChannel ? 240 : (isLiveStream ? 60 : 180), // Limite máximo tolerado
            maxBufferSize: isSportsChannel ? 200 * 1024 * 1024 : (isLiveStream ? 60 * 1024 * 1024 : 150 * 1024 * 1024), // 200MB para esportes
            manifestLoadingTimeOut: 15000,
            levelLoadingTimeOut: 15000,
            fragLoadingTimeOut: 15000,
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
                console.warn('[HLS] Falha de rede irrecuperável, tentando proxima fonte...', data);
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

      playCurrentSource();

      return () => {
        disposed = true;
        hideBufferIndicator();
        if (!isLiveStream && !isPreview) {
          syncProgressToSupabase(lastKnownTimeRef.current, { force: true });
        }
        clearStartupTimeout();
        clearStallWatchdog();
        removeVideoEventListeners();
        destroyMpegtsInstance();
        destroyHlsInstance();
        releaseHtml5Video();
      };
    }, [
      canUseNativeFallback,
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
    const bufferMiniDiagReason = playbackDiagnostic?.reason
      ? (playbackDiagnostic.reason.length > 86 ? `${playbackDiagnostic.reason.slice(0, 83)}...` : playbackDiagnostic.reason)
      : '';
    const shouldShowBufferIndicator =
      bufferIndicator.visible &&
      !previewTerminalFailure &&
      !inlineError &&
      !(shouldUseNativeBridgePlayer && playerState === 'error');
    const bufferElapsedSeconds = bufferIndicator.startedAt
      ? Math.max(0, Math.floor((Date.now() - bufferIndicator.startedAt) / 1000))
      : 0;
    const bufferAnimatedDots = '.'.repeat((bufferIndicator.phase % 3) + 1);

    return (
    <>
      <div 
        ref={previewHostRef}
        className={`relative h-full w-full bg-black ${
          isPreview && !isNativePlatform ? 'overflow-hidden rounded-2xl shadow-2xl' : ''
        }`}
        onMouseMove={showControls}
        onPointerDown={(event) => {
          showControls();
          touchSwipeStartRef.current = null;

          const isTouchGesture = event.pointerType === 'touch' || event.pointerType === 'pen';
          if (!isTouchGesture) {
            return;
          }
          if (isLiveStream || isPreview || isRelatedVisible || isChannelBrowserOpen || isSettingsOpen || relatedMedia.length === 0) {
            return;
          }
          if (typeof window !== 'undefined') {
            if (window.innerWidth < TABLET_MIN_WIDTH) {
              return;
            }
            if (event.clientY < window.innerHeight * 0.4) {
              return;
            }
          }

          touchSwipeStartRef.current = {
            x: event.clientX,
            y: event.clientY,
            startedAt: Date.now(),
          };
        }}
        onPointerUp={(event) => {
          const swipeStart = touchSwipeStartRef.current;
          touchSwipeStartRef.current = null;
          if (!swipeStart) {
            return;
          }
          const deltaY = swipeStart.y - event.clientY;
          const deltaX = Math.abs(event.clientX - swipeStart.x);
          const elapsedMs = Date.now() - swipeStart.startedAt;
          const isValidSwipeUp =
            deltaY >= SWIPE_UP_MIN_DISTANCE_PX &&
            deltaX <= SWIPE_MAX_HORIZONTAL_DRIFT_PX &&
            elapsedMs <= SWIPE_MAX_DURATION_MS;
          if (isValidSwipeUp && openRelatedDrawer()) {
            suppressTapAfterSwipeRef.current = true;
            event.preventDefault();
          }
        }}
        onPointerCancel={() => {
          touchSwipeStartRef.current = null;
        }}
        onClick={(e) => {
          if (suppressTapAfterSwipeRef.current) {
            suppressTapAfterSwipeRef.current = false;
            e.preventDefault();
            return;
          }
          if (!isPreview && !isRelatedVisible && !isChannelBrowserOpen && !isSettingsOpen) {
            void togglePlayPause();
          }
        }}
      >
        {shouldUseNativeBridgePlayer ? (
          <>
            {playerState !== 'ready' && (
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(239,68,68,0.18),rgba(0,0,0,0.96)_58%)]" />
            )}
            {playerState !== 'ready' && !shouldShowBufferIndicator && (
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
            } ${
              videoScale === 'fit' ? 'object-contain' : videoScale === 'fill' ? 'object-fill' : 'object-cover'
            }`}
            style={{ transform: 'translateZ(0)' }}
            autoPlay
            muted={false}
            playsInline
            poster={isPreview ? undefined : fallbackPoster}
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
                onClose();
              }
            }}
          />
        )}
        {shouldShowBufferIndicator && (
          <div className="absolute inset-0 z-[11] flex items-center justify-center bg-black/82 px-4 text-center">
            <div className="relative w-full max-w-[390px] rounded-2xl border border-white/10 bg-zinc-950/90 p-4 shadow-2xl">
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-red-300 font-['Outfit']">
                Buffer Dinâmico
              </div>
              <div className="mt-2 text-[12px] font-semibold text-white/90 break-words">
                {bufferIndicator.label || 'Conectando stream'}{bufferAnimatedDots}
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-red-600 via-red-500 to-amber-400 transition-all duration-300"
                  style={{ width: `${Math.max(2, Math.min(100, bufferIndicator.progress))}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-white/65">
                <span>{Math.round(Math.max(0, Math.min(100, bufferIndicator.progress)))}%</span>
                <span>{bufferElapsedSeconds}s</span>
              </div>
              {bufferIndicator.total > 0 && (
                <div className="mt-1 text-[9px] uppercase tracking-widest text-white/45">
                  Tentativa {Math.max(1, bufferIndicator.attempt)}/{bufferIndicator.total}
                </div>
              )}
              {playbackDiagnostic && (
                <div className="absolute bottom-3 right-3 max-w-[188px] rounded-lg border border-red-500/35 bg-black/75 p-2 text-left shadow-lg">
                  <div className="text-[8px] font-black uppercase tracking-[0.16em] text-red-300">Diag</div>
                  {playbackDiagnostic.code && (
                    <div className="mt-0.5 text-[8px] font-semibold text-white/85 break-all">
                      {playbackDiagnostic.code}
                    </div>
                  )}
                  <div className="mt-0.5 text-[8px] text-white/65 break-words">
                    {bufferMiniDiagReason}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {shouldShowPreviewFailureOverlay && (
           <div className="absolute inset-0 z-[20] flex flex-col items-center justify-center bg-black/80 px-4 text-center">
             <div className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500 mb-1 font-['Outfit']">Sem Sinal</div>
             <div className="text-[10px] font-bold text-white/70 uppercase tracking-widest font-['Outfit']">
               {inlineError || 'Falha no carregamento do canal'}
             </div>
             {playbackDiagnostic && (
               <div className="mt-3 w-full max-w-[340px] rounded-xl border border-red-500/35 bg-black/70 p-3 text-left">
                 <div className="text-[9px] font-black uppercase tracking-[0.2em] text-red-300 font-['Outfit']">Diagnóstico</div>
                 <div className="mt-1 text-[10px] font-semibold text-white/90 break-words">
                   {playbackDiagnostic.reason}
                 </div>
                 {playbackDiagnostic.code && (
                   <div className="mt-1 text-[9px] text-white/70 break-words">
                     Código: {playbackDiagnostic.code}
                   </div>
                 )}
                 {playbackDiagnostic.httpStatus && (
                   <div className="mt-1 text-[9px] text-white/70 break-words">
                     HTTP: {playbackDiagnostic.httpStatus}
                   </div>
                 )}
                 {playbackDiagnostic.url && (
                   <div className="mt-1 text-[9px] text-white/60 break-all">
                     URL: {playbackDiagnostic.url}
                   </div>
                 )}
                 {playbackDiagnostic.detail && (
                   <div className="mt-1 text-[9px] text-white/60 break-words">
                     Detalhe: {playbackDiagnostic.detail}
                   </div>
                 )}
               </div>
             )}
             <div className="text-[9px] text-white/40 mt-3 uppercase max-w-[200px] font-['Outfit']">O player nativo pode suportar este canal. Clique em tela cheia.</div>
           </div>
        )}
        {inlineError && !isPreview && !shouldUseNativeBridgePlayer && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 z-[90] rounded-xl border border-red-500/30 bg-zinc-900/95 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-red-200 font-['Outfit']">
            {inlineError}
          </div>
        )}
        {playbackDiagnostic && !isPreview && (inlineError || error || playerState === 'error') && (
          <div className="absolute bottom-6 left-6 right-6 z-[95] rounded-2xl border border-red-500/35 bg-zinc-950/95 p-4 text-left shadow-2xl md:max-w-[720px] md:right-auto">
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-red-300 font-['Outfit']">Diagnóstico do Player</div>
            <div className="mt-2 text-[12px] font-semibold text-white break-words">
              {playbackDiagnostic.reason}
            </div>
            {playbackDiagnostic.code && (
              <div className="mt-1 text-[11px] text-white/80 break-words">
                Código: {playbackDiagnostic.code}
              </div>
            )}
            {playbackDiagnostic.httpStatus && (
              <div className="mt-1 text-[11px] text-white/80 break-words">
                HTTP: {playbackDiagnostic.httpStatus}
              </div>
            )}
            {playbackDiagnostic.url && (
              <div className="mt-1 text-[10px] text-white/60 break-all">
                URL: {playbackDiagnostic.url}
              </div>
            )}
            {playbackDiagnostic.detail && (
              <div className="mt-1 text-[10px] text-white/60 break-words">
                Detalhe: {playbackDiagnostic.detail}
              </div>
            )}
            <div className="mt-2 text-[9px] uppercase tracking-widest text-white/40">
              Atualizado: {new Date(playbackDiagnostic.timestamp).toLocaleTimeString()}
            </div>
          </div>
        )}
        
        {/* Auto Next Countdown Overlay */}
        {autoNextCountdown !== null && nextEpisode && (
          <div className="absolute bottom-40 right-12 z-[60] flex flex-col items-end gap-4 animate-in fade-in slide-in-from-right-10 duration-500">
            <div className="bg-zinc-900/98 border border-white/10 p-6 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col gap-4 max-w-[340px] ring-1 ring-white/5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-red-600 animate-pulse" />
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-red-500 font-['Outfit']">Próximo Episódio em {autoNextCountdown}s</span>
                </div>
                <button onClick={cancelAutoNext} className="text-white/40 hover:text-white p-1 transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="flex gap-4">
                <div className="relative">
                  <img 
                    src={nextEpisode.thumbnail || nextEpisode.backdrop || ''} 
                    className="w-28 h-18 rounded-lg object-cover border border-white/10 shadow-lg"
                    alt="Próximo"
                  />
                  <div className="absolute inset-0 bg-black/20 rounded-lg flex items-center justify-center">
                    <Play size={20} fill="white" className="text-white opacity-60" />
                  </div>
                </div>
                <div className="flex-1 min-w-0 flex flex-col justify-center">
                  <h4 className="text-white font-black text-sm truncate font-['Outfit']">{nextEpisode.title}</h4>
                  <p className="text-white/40 text-[10px] font-bold uppercase tracking-wider mt-1.5 font-['Outfit']">Série • Próximo</p>
                </div>
              </div>
              <div className="flex gap-3 mt-1">
                <button 
                  onClick={() => { cancelAutoNext(); onPlayNextEpisode?.(); }}
                  className="flex-1 bg-white text-black font-black py-3 rounded-xl text-[11px] uppercase tracking-[0.1em] hover:bg-red-600 hover:text-white transition-colors shadow-xl active:scale-95 font-['Outfit']"
                >
                  Assistir Agora
                </button>
                <button 
                  onClick={cancelAutoNext}
                  className="px-5 bg-white/10 text-white font-black py-3 rounded-xl text-[11px] uppercase tracking-[0.1em] hover:bg-white/20 transition-colors border border-white/5 active:scale-95 font-['Outfit']"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cinematic Controls Overlay (Z-50) */}
        {!isPreview && (
          <div 
            className={`
              absolute inset-0 z-50 flex flex-col justify-between p-8 bg-gradient-to-t from-black/90 via-transparent to-black/70
              transition-opacity duration-500 ease-in-out
              ${isControlsVisible || !isPlaying ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
            `}
          >
            {/* Top Bar: Title & Subtitle */}
            <div className="flex items-start justify-between">
               <div className="flex flex-col gap-1">
                 <div className="flex items-center gap-4 mb-2">
                    {canShowChannelBrowser && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setIsChannelBrowserOpen((prev) => !prev);
                        }}
                        className="rounded-xl border border-red-500/30 bg-zinc-900/95 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-red-200 font-['Outfit']"
                      >
                        {isChannelBrowserOpen ? 'Ocultar Canais' : 'Canais'}
                      </button>
                    )}
                 </div>
                 <h2 className="text-4xl font-black text-white drop-shadow-2xl font-['Outfit'] tracking-tight">
                   {media?.title || 'Xandeflix Player'}
                 </h2>
                 {(media as any).currentEpisode && (
                   <p className="text-xl font-bold text-white/60 font-['Outfit'] mt-1">
                     Temporada {(media as any).currentSeasonNumber} • Episódio {(media as any).currentEpisode.episodeNumber}: {(media as any).currentEpisode.title}
                   </p>
                 )}
                 {isLiveStream && currentProgram && (
                   <div className="flex items-center gap-3 mt-2 bg-red-600/20 self-start px-3 py-1 rounded-full border border-red-500/30">
                      <div className="w-2 h-2 rounded-full bg-red-600 animate-pulse" />
                      <span className="text-xs font-black text-red-500 uppercase tracking-widest font-['Outfit']">AO VIVO AGORA</span>
                   </div>
                 )}
               </div>

               <div className="flex items-center gap-4">
                  <button 
                    onClick={(e) => { e.stopPropagation(); setIsSettingsOpen(!isSettingsOpen); }}
                    className="p-3 rounded-full bg-zinc-900/90 hover:bg-white/10 transition-transform border border-white/10"
                    aria-label="Configurações de vídeo"
                  >
                    <SlidersHorizontal size={24} className="text-white" />
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    className="p-3 rounded-full bg-zinc-900/90 hover:bg-white/10 transition-transform border border-white/10"
                    aria-label="Fechar player"
                  >
                    <X size={28} className="text-white" />
                  </button>
               </div>
            </div>

            {/* Center: Big Play/Pause & Skip Buttons */}
            <div className="absolute inset-0 flex items-center justify-center gap-16 pointer-events-none">
              {!isLiveStream && (
                <button
                  onClick={(e) => { e.stopPropagation(); seek(-10); }}
                  className="p-6 rounded-full bg-zinc-900/80 border border-white/5 transition-transform pointer-events-auto hover:scale-110 active:scale-95"
                >
                  <Rewind size={42} className="text-white/80" />
                  <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] font-black text-white/40 uppercase font-['Outfit']">10s</span>
                </button>
              )}

              <button
                onClick={(e) => { e.stopPropagation(); togglePlayPause(); }}
                className={`
                  p-12 rounded-full bg-zinc-900/95 border border-white/20
                  transition-transform duration-500 pointer-events-auto hover:scale-110 active:scale-90
                  shadow-[0_0_60px_rgba(0,0,0,0.5)]
                `}
              >
                {isPlaying ? (
                  <Pause size={64} fill="white" className="text-white drop-shadow-2xl" />
                ) : (
                  <Play size={64} fill="white" className="text-white ml-2 drop-shadow-2xl" />
                )}
              </button>

              {!isLiveStream && (
                <button
                  onClick={(e) => { e.stopPropagation(); seek(10); }}
                  className="p-6 rounded-full bg-zinc-900/80 border border-white/5 transition-transform pointer-events-auto hover:scale-110 active:scale-95"
                >
                  <FastForward size={42} className="text-white/80" />
                  <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] font-black text-white/40 uppercase font-['Outfit']">10s</span>
                </button>
              )}
            </div>

            {/* Bottom Section: Progress & Controls */}
            <div className="flex flex-col gap-6">
              {!isLiveStream && (
                <div className="group relative py-4 cursor-pointer">
                  <ProgressBar videoRef={previewVideoRef} />
                  <div className="absolute -top-6 left-0 right-0 flex justify-between px-2">
                     <TimeDisplay videoRef={previewVideoRef} />
                     <span className="text-white/40 text-xs font-black font-['Outfit']">
                        {previewVideoRef.current?.duration ? new Date(previewVideoRef.current.duration * 1000).toISOString().substr(11, 8) : '--:--:--'}
                     </span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between">
                 <div className="flex items-center gap-8">
                    <button 
                      onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                      className="p-2 text-white/70 hover:text-white transition-colors hover:scale-110"
                    >
                      {isMuted ? <VolumeX size={32} /> : <Volume2 size={32} />}
                    </button>

                    {!isLiveStream && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          openRelatedDrawer();
                        }}
                        className="flex items-center gap-2 text-white/60 hover:text-white transition-colors font-['Outfit'] font-black uppercase tracking-widest text-sm"
                      >
                         <ChevronDown size={20} className="rotate-180" />
                         Similares
                      </button>
                    )}
                 </div>

                 <div className="flex items-center gap-6">
                    {nextEpisode && (
                      <button 
                        onClick={(e) => { e.stopPropagation(); onPlayNextEpisode?.(); }}
                        className="flex items-center gap-3 bg-white text-black px-8 py-3 rounded-xl transition-transform shadow-xl active:scale-95 font-['Outfit']"
                      >
                        <FastForward size={22} fill="black" />
                        <span className="text-sm font-black uppercase tracking-wider">Próximo Episódio</span>
                      </button>
                    )}
                 </div>
              </div>
            </div>
          </div>
        )}

        {/* Settings Overlay */}
        {isSettingsOpen && (
          <div 
            className="absolute top-24 right-8 z-[70] bg-zinc-900/98 border border-white/10 p-6 rounded-3xl w-72 shadow-2xl animate-spring-zoom"
            onClick={(e) => e.stopPropagation()}
          >
             <h4 className="text-white font-black uppercase tracking-[0.2em] text-[10px] mb-6 border-b border-white/10 pb-4">Configurações de Vídeo</h4>
             
             <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                   <span className="text-white/40 text-[10px] font-black uppercase tracking-widest">Enquadramento</span>
                   <div className="grid grid-cols-3 gap-2">
                      {(['fit', 'fill', 'zoom'] as const).map(scale => (
                        <button
                          key={scale}
                          onClick={() => setVideoScale(scale)}
                          className={`py-2 rounded-lg text-[10px] font-black uppercase transition-colors ${videoScale === scale ? 'bg-red-600 text-white' : 'bg-white/5 text-white/40 border border-white/5'}`}
                        >
                          {scale === 'fit' ? 'Ajustar' : scale === 'fill' ? 'Preencher' : 'Zoom'}
                        </button>
                      ))}
                   </div>
                </div>

                <button 
                  onClick={() => setShowDiagnostic(true)}
                  className="mt-4 flex items-center justify-between w-full p-3 bg-white/5 rounded-xl border border-white/5 hover:bg-white/10 transition-colors"
                >
                  <span className="text-white text-xs font-bold font-['Outfit']">Diagnóstico de Rede</span>
                  <Activity size={16} className="text-white/40" />
                </button>
             </div>
          </div>
        )}

        {/* Related Titles Drawer */}
        {isRelatedVisible && (
          <div
            className="absolute inset-x-0 bottom-0 z-[80] h-[45vh] bg-zinc-900/98 border-t border-white/10 p-8 animate-spring-up"
            onClick={(e) => e.stopPropagation()}
          >
               <div className="flex items-center justify-between mb-8">
                  <div className="flex flex-col">
                    <h3 className="text-2xl font-black text-white font-['Outfit'] uppercase tracking-tight">Títulos Semelhantes</h3>
                    <p className="text-white/40 text-sm font-medium font-['Outfit']">Mais de {media?.category}</p>
                  </div>
                  <button 
                    onClick={() => setIsRelatedVisible(false)}
                    className="p-3 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-white/10"
                  >
                    <X size={24} className="text-white" />
                  </button>
               </div>

               <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
                  {relatedMedia.map((item) => (
                    <button
                      key={`related-${item.id}`}
                      onClick={() => {
                        onZap?.(item);
                        setIsRelatedVisible(false);
                      }}
                      className="flex-shrink-0 w-64 group relative transition-transform hover:scale-105 active:scale-95"
                    >
                      <div className="aspect-video rounded-xl overflow-hidden border border-white/10 shadow-2xl">
                        <img 
                          src={item.thumbnail || item.backdrop || ''} 
                          className="w-full h-full object-cover"
                          alt={item.title}
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                           <Play size={32} fill="white" className="text-white" />
                        </div>
                      </div>
                      <p className="mt-3 text-white font-black text-sm truncate font-['Outfit'] tracking-tight">{item.title}</p>
                      <p className="text-white/40 text-[10px] font-bold uppercase tracking-widest mt-1 font-['Outfit']">{item.category}</p>
                    </button>
                  ))}
                  {relatedMedia.length === 0 && (
                    <div className="flex items-center justify-center w-full h-32 text-white/20 font-['Outfit'] font-black uppercase tracking-widest italic">
                       Nenhum título semelhante encontrado
                    </div>
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
                        type="button"
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
                          data-channel-selected={selected ? 'true' : undefined}
                          type="button"
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
      {showDiagnostic && (
          <NetworkDiagnostic onClose={() => setShowDiagnostic(false)} testUrl={playbackUrl || url} />
      )}
    </>
    );
  },
);

VideoPlayer.displayName = 'VideoPlayer';
