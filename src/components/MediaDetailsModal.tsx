import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableHighlight, Image, ScrollView } from 'react-native';
import { motion } from 'motion/react';
import { Play, Star, Loader2, Heart, Clapperboard, X, ChevronDown } from 'lucide-react';
import { Media } from '../types';
import { useTMDB } from '../hooks/useTMDB';
import { useEmbeddableTrailerKey } from '../hooks/useEmbeddableTrailerKey';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { useStore } from '../store/useStore';
import { CategoryRow } from './CategoryRow';
import { cleanMediaTitle } from '../lib/titleCleaner';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { useDiskCategory } from '../hooks/useDiskCategory';
import { fetchTMDBPersonFilmography, type TMDBPersonFilmographyItem } from '../lib/tmdb';

interface MediaDetailsPageProps {
  media: Media;
  onClose: () => void;
  onPlay: (media: Media) => void;
  onSelectMedia?: (media: Media) => void;
  sideMenuOffset?: number;
}

const normalizeArtworkUrl = (value: string | null | undefined): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let normalized = raw;
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  }

  try {
    return encodeURI(normalized);
  } catch {
    return normalized;
  }
};

export const MediaDetailsPage: React.FC<MediaDetailsPageProps> = ({ 
  media, 
  onClose, 
  onPlay,
  onSelectMedia,
  sideMenuOffset = 0,
}) => {
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [isSeasonDropdownOpen, setIsSeasonDropdownOpen] = useState(false);
  const [isTrailerModalOpen, setIsTrailerModalOpen] = useState(false);
  const [trailerStatus, setTrailerStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [trailerErrorTitle, setTrailerErrorTitle] = useState('Trailer indisponível no player');
  const [trailerErrorMessage, setTrailerErrorMessage] = useState('');
  const [trailerReloadToken, setTrailerReloadToken] = useState(0);
  const [selectedCastActor, setSelectedCastActor] = useState<{ id: number; name: string } | null>(null);
  const [actorFilmography, setActorFilmography] = useState<TMDBPersonFilmographyItem[]>([]);
  const [isActorFilmographyLoading, setIsActorFilmographyLoading] = useState(false);
  const [actorFilmographyError, setActorFilmographyError] = useState('');
  const trailerLoadTimeoutRef = useRef<number | null>(null);
  const layout = useResponsiveLayout();
  const isTvMode = useStore(state => state.isTvMode);
  const isTv = layout.isTvProfile;
  const shouldEnableTvNav = isTvMode && isTv;
  const { registerNode, setFocusedId, focusedId } = useTvNavigation({
    isActive: shouldEnableTvNav,
    onBack: () => {
      if (selectedCastActor) {
        setSelectedCastActor(null);
        setActorFilmography([]);
        setActorFilmographyError('');
        setIsActorFilmographyLoading(false);
        return;
      }
      if (isTrailerModalOpen) {
        setIsTrailerModalOpen(false);
        setTrailerStatus('idle');
        setTrailerErrorTitle('Trailer indisponível no player');
        setTrailerErrorMessage('');
        return;
      }
      onClose();
    },
    subscribeFocused: true,
  });
  const scrollViewRef = useRef<ScrollView>(null);
  const detailsTopFrameRef = useRef<HTMLDivElement | null>(null);
  const safeLayoutWidth = Number.isFinite(layout.width) && layout.width > 0 ? layout.width : 1280;
  const viewportWidth =
    typeof window !== 'undefined' && Number.isFinite(window.innerWidth) && window.innerWidth > 0
      ? window.innerWidth
      : safeLayoutWidth;
  const shouldStackDetails = !isTv && viewportWidth < 980;
  const isCompactDetails = !isTv && viewportWidth < 760;
  const contentPadding = isTv ? 40 : isCompactDetails ? 16 : viewportWidth < 1200 ? 24 : 56;
  const titleTextShadow = isTv
    ? '0 3px 18px rgba(0,0,0,0.90), 0 1px 4px rgba(0,0,0,0.76)'
    : '0 3px 20px rgba(0,0,0,0.88), 0 1px 4px rgba(0,0,0,0.72)';
  const synopsisTextShadow = isTv
    ? '0 2px 12px rgba(0,0,0,0.88), 0 1px 3px rgba(0,0,0,0.7)'
    : '0 2px 14px rgba(0,0,0,0.84), 0 1px 3px rgba(0,0,0,0.66)';
  const heroBaseHeight = Math.round(
    Math.min(layout.heroHeightMax, Math.max(layout.heroMinHeight, viewportWidth * layout.heroHeightRatio)),
  );
  const backdropHeight = isTv
    ? Math.max(420, Math.min(heroBaseHeight, Math.round(layout.height * 0.92)))
    : heroBaseHeight;
  const detailsTopPadding = isTv ? 72 : isCompactDetails ? 56 : 68;
  const isTopDetailsFocused = useMemo(
    () =>
      focusedId === 'details-play'
      || focusedId === 'details-trailer'
      || focusedId === 'details-favorite',
    [focusedId],
  );

  const ensureTopDetailsVisible = useCallback((smooth = false) => {
    if (typeof document === 'undefined') return;
    const modalScroll = document.querySelector('[data-details-scroll="1"]') as HTMLElement | null;
    if (!modalScroll) return;

    const frameTop = detailsTopFrameRef.current?.offsetTop ?? 0;
    const targetTop = Math.max(0, frameTop - 18);
    const behavior = smooth && !isTv ? 'smooth' : 'auto';

    if (Math.abs(modalScroll.scrollTop - targetTop) > 10) {
      modalScroll.scrollTo({ top: targetTop, behavior });
    }
  }, [isTv]);

  useEffect(() => {
    setIsTrailerModalOpen(false);
    setTrailerStatus('idle');
    setTrailerErrorTitle('Trailer indisponível no player');
    setTrailerErrorMessage('');
    setTrailerReloadToken(0);
    setSelectedCastActor(null);
    setActorFilmography([]);
    setActorFilmographyError('');
    setIsActorFilmographyLoading(false);
  }, [media.id]);

  useEffect(() => {
    // Garante que cada abertura de título começa no topo da página de detalhes.
    const resetScroll = () => {
      try {
        scrollViewRef.current?.scrollTo?.({ y: 0, animated: false });
      } catch {
        // no-op
      }
      if (typeof document !== 'undefined') {
        const modalScroll = document.querySelector('[data-details-scroll="1"]') as HTMLElement | null;
        if (modalScroll) modalScroll.scrollTop = 0;
      }
    };

    const timerA = setTimeout(resetScroll, 30);
    const timerB = setTimeout(resetScroll, 260);
    return () => {
      clearTimeout(timerA);
      clearTimeout(timerB);
    };
  }, [media.id]);

  useEffect(() => {
    if (!isTopDetailsFocused) return;
    ensureTopDetailsVisible(true);
  }, [ensureTopDetailsVisible, isTopDetailsFocused]);

  const watchHistory = useStore(state => state.watchHistory);
  const playbackProgress = useStore(state => state.playbackProgress);
  const favorites = useStore(state => state.favorites);
  const toggleFavorite = useStore(state => state.toggleFavorite);
  const { items: relatedDiskItems } = useDiskCategory(media.category, 0, 1200);
  const normalizeSeriesKey = useCallback((value: string) => {
    return cleanMediaTitle(String(value || '').trim())
      .cleanTitle
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .toLowerCase();
  }, []);
  const mergedSeriesSeasons = useMemo(() => {
    const baseTitleKey = normalizeSeriesKey(media.title);
    const seasonsMap = new Map<number, Map<string, any>>();

    const appendEpisode = (input: {
      id?: string;
      title?: string;
      videoUrl?: string;
      seasonNumber?: number;
      episodeNumber?: number;
    }) => {
      const seasonNumber = Number(input.seasonNumber);
      const episodeNumber = Number(input.episodeNumber);
      const videoUrl = String(input.videoUrl || '').trim();
      if (!Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber) || !videoUrl) return;
      if (!seasonsMap.has(seasonNumber)) seasonsMap.set(seasonNumber, new Map());
      const seasonMap = seasonsMap.get(seasonNumber)!;
      const epKey = `${episodeNumber}::${videoUrl}`;
      if (seasonMap.has(epKey)) return;
      seasonMap.set(epKey, {
        id: String(input.id || `ep-${seasonNumber}-${episodeNumber}-${videoUrl}`),
        title: String(input.title || `Episódio ${episodeNumber}`),
        seasonNumber,
        episodeNumber,
        videoUrl,
      });
    };

    (media.seasons || []).forEach((season) => {
      season.episodes.forEach((ep) => appendEpisode(ep as any));
    });

    relatedDiskItems.forEach((item: any) => {
      const itemTitleKey = normalizeSeriesKey(item.title);
      if (itemTitleKey !== baseTitleKey) return;

      const parsed = cleanMediaTitle(item.title);
      if (parsed.season !== undefined && parsed.episode !== undefined) {
        appendEpisode({
          id: item.id,
          title: item.title,
          seasonNumber: parsed.season,
          episodeNumber: parsed.episode,
          videoUrl: item.videoUrl,
        });
      }

      if (Array.isArray(item.seasons)) {
        item.seasons.forEach((season: any) => {
          if (!Array.isArray(season?.episodes)) return;
          season.episodes.forEach((ep: any) => appendEpisode(ep));
        });
      }
    });

    return Array.from(seasonsMap.entries())
      .map(([seasonNumber, seasonEntries]) => ({
        seasonNumber,
        episodes: Array.from(seasonEntries.values()).sort((a, b) => a.episodeNumber - b.episodeNumber),
      }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
  }, [media.seasons, media.title, normalizeSeriesKey, relatedDiskItems]);
  useEffect(() => {
    if (mergedSeriesSeasons.length === 0) {
      setSelectedSeason(null);
      return;
    }
    setSelectedSeason((current) => {
      if (current !== null && mergedSeriesSeasons.some((s) => s.seasonNumber === current)) {
        return current;
      }
      return mergedSeriesSeasons[0].seasonNumber;
    });
  }, [mergedSeriesSeasons]);
  const tmdbLookupType = useMemo<'movie' | 'series'>(() => {
    if (media.type === 'series') return 'series';
    if (media.type === 'movie') return 'movie';
    return mergedSeriesSeasons.length > 0 ? 'series' : 'movie';
  }, [media.type, mergedSeriesSeasons.length]);
  const { data: tmdbData, loading: tmdbLoading } = useTMDB(media.title, tmdbLookupType, { categoryHint: media.category });
  const favoriteKey = media.videoUrl || `media:${media.id}`;
  const isFavorite = favorites.includes(favoriteKey) || favorites.includes(media.id);

  // Auto-focus the primary action when modal opens
  useEffect(() => {
    if (!shouldEnableTvNav) return;
    const targetId = (media.videoUrl || mergedSeriesSeasons.length > 0) ? 'details-play' : 'details-favorite';
    const focusPrimaryAction = () => setFocusedId(targetId);

    const rafId = typeof window !== 'undefined'
      ? window.requestAnimationFrame(focusPrimaryAction)
      : 0;
    const fallbackTimer = setTimeout(focusPrimaryAction, 220);

    return () => {
      if (typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafId);
      }
      clearTimeout(fallbackTimer);
    };
  }, [media.videoUrl, mergedSeriesSeasons.length, setFocusedId, shouldEnableTvNav]);

  const primaryActionMedia = useMemo(() => {
    if (mergedSeriesSeasons.length === 0) {
      return media.videoUrl ? media : null;
    }

    const resumableEpisode = mergedSeriesSeasons
      .flatMap((season) =>
        season.episodes.map((episode) => ({
          episode,
          seasonNumber: season.seasonNumber,
          progress: watchHistory[episode.videoUrl] || 0,
        })),
      )
      .find((entry) => entry.progress > 5);

    if (resumableEpisode) {
      return {
        ...media,
        videoUrl: resumableEpisode.episode.videoUrl,
        title: `${media.title} - ${resumableEpisode.episode.title}`,
        currentEpisode: resumableEpisode.episode,
        currentSeasonNumber: resumableEpisode.seasonNumber,
      };
    }

    const firstSeason = mergedSeriesSeasons[0];
    const firstEpisode = firstSeason?.episodes?.[0];

    if (!firstEpisode) {
      return null;
    }

    return {
      ...media,
      videoUrl: firstEpisode.videoUrl,
      title: `${media.title} - ${firstEpisode.title}`,
      currentEpisode: firstEpisode,
      currentSeasonNumber: firstSeason.seasonNumber,
    };
  }, [media, mergedSeriesSeasons, watchHistory]);
  const selectedSeasonEpisodes = useMemo(() => {
    if (selectedSeason === null) return [];
    return mergedSeriesSeasons.find((s) => s.seasonNumber === selectedSeason)?.episodes || [];
  }, [mergedSeriesSeasons, selectedSeason]);

  const shouldResumePlayback = useMemo(() => {
    if (!primaryActionMedia?.videoUrl) {
      return false;
    }

    return (watchHistory[primaryActionMedia.videoUrl] || 0) > 5;
  }, [primaryActionMedia, watchHistory]);

  const relatedCategory = useMemo(() => {
    // Busca a categoria que contém o conteúdo atual
    if (!relatedDiskItems.length) return null;
    
    // Remove o filme/série selecionado da lista e prioriza itens que já têm capa válida.
    const relatedItems = relatedDiskItems.filter(item => item.id !== media.id);
    const withArtwork = relatedItems.filter((item: any) =>
      Boolean(normalizeArtworkUrl(item.thumbnail) || normalizeArtworkUrl(item.backdrop)),
    );
    const withoutArtwork = relatedItems.filter((item: any) =>
      !(normalizeArtworkUrl(item.thumbnail) || normalizeArtworkUrl(item.backdrop)),
    );

    for (let i = withArtwork.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [withArtwork[i], withArtwork[j]] = [withArtwork[j], withArtwork[i]];
    }
    for (let i = withoutArtwork.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [withoutArtwork[i], withoutArtwork[j]] = [withoutArtwork[j], withoutArtwork[i]];
    }
    const prioritizedRelatedItems = [...withArtwork, ...withoutArtwork];
    
    return {
      id: `related-${media.id}`,
      type: media.type,
      title: 'Titulos Semelhantes',
      items: prioritizedRelatedItems.slice(0, 15),
    };
  }, [media, relatedDiskItems]);

  // Fallback visual elegante quando não há backdrop disponível
  const fallbackBg = `https://images.unsplash.com/photo-1594909122845-11baa439b7bf?q=80&w=1920&auto=format&fit=crop`;

  const displayData = useMemo(() => {
    const tmdbBackdrop = normalizeArtworkUrl(tmdbData?.backdrop);
    const mediaBackdrop = normalizeArtworkUrl(media.backdrop);
    const mediaThumbnail = normalizeArtworkUrl(media.thumbnail);
    const tmdbThumbnail = normalizeArtworkUrl(tmdbData?.thumbnail);

    // 1. Tenta usar o backdrop vindo do TMDB
    let finalBackdrop = tmdbBackdrop;

    // 2. Se não houver backdrop do TMDB, tenta usar o da mídia somente se for distinto do poster.
    if (!finalBackdrop) {
      if (mediaBackdrop && mediaBackdrop !== mediaThumbnail) {
        finalBackdrop = mediaBackdrop;
      } else {
        finalBackdrop = fallbackBg;
      }
    }

    return {
      ...media,
      description: tmdbData?.description || media.description,
      year: tmdbData?.year || media.year,
      rating: tmdbData?.rating || media.rating,
      backdrop: finalBackdrop,
      thumbnail: tmdbThumbnail || mediaThumbnail,
    };
  }, [fallbackBg, media, tmdbData]);
  const genreLabel = useMemo(() => {
    const genres = Array.isArray(tmdbData?.genres) ? tmdbData?.genres.filter(Boolean) : [];
    if (genres.length > 0) return genres.slice(0, 3).join(', ');
    return media.category;
  }, [media.category, tmdbData?.genres]);
  const streamingProvider = tmdbData?.streamingProvider || null;
  const castList = useMemo(
    () => (Array.isArray(tmdbData?.cast) ? tmdbData.cast.filter((member) => Number(member?.id) > 0) : []),
    [tmdbData?.cast],
  );
  const closeActorFilmography = useCallback(() => {
    setSelectedCastActor(null);
    setActorFilmography([]);
    setActorFilmographyError('');
    setIsActorFilmographyLoading(false);
  }, []);
  const handleFilmographySelect = useCallback((item: TMDBPersonFilmographyItem) => {
    if (typeof onSelectMedia !== 'function') return;

    const fallbackTitle = cleanMediaTitle(item.title).cleanTitle || item.title;
    const selectedMedia: Media = {
      id: `tmdb-filmography-${item.mediaType}-${item.id}`,
      title: fallbackTitle,
      description: '',
      thumbnail: item.poster || displayData.thumbnail || '',
      backdrop: item.backdrop || displayData.backdrop || '',
      videoUrl: '',
      type: (item.mediaType === 'movie' ? 'movie' : 'series') as any,
      year: item.year || 0,
      rating: item.rating || '0.0',
      duration: 'VOD',
      category: media.category,
    };

    closeActorFilmography();
    onSelectMedia(selectedMedia);
  }, [closeActorFilmography, displayData.backdrop, displayData.thumbnail, media.category, onSelectMedia]);

  useEffect(() => {
    if (!selectedCastActor?.id) return;

    let cancelled = false;
    setIsActorFilmographyLoading(true);
    setActorFilmographyError('');
    setActorFilmography([]);

    const loadFilmography = async () => {
      try {
        const results = await fetchTMDBPersonFilmography(selectedCastActor.id, 28);
        if (cancelled) return;
        setActorFilmography(results);
      } catch (error) {
        if (cancelled) return;
        console.warn('[Details] Falha ao buscar filmografia do ator', error);
        setActorFilmographyError('Não foi possível carregar a filmografia deste ator agora.');
      } finally {
        if (!cancelled) setIsActorFilmographyLoading(false);
      }
    };

    loadFilmography();
    return () => {
      cancelled = true;
    };
  }, [selectedCastActor]);

  useEffect(() => {
    if (!shouldEnableTvNav || !selectedCastActor) return;
    const timer = setTimeout(() => setFocusedId('actor-filmography-close'), 80);
    return () => clearTimeout(timer);
  }, [selectedCastActor, setFocusedId, shouldEnableTvNav]);
  useEffect(() => {
    if (!shouldEnableTvNav || !selectedCastActor || isActorFilmographyLoading) return;
    const first = actorFilmography[0];
    if (!first) return;
    const timer = setTimeout(() => {
      setFocusedId(`actor-filmography-item-${first.mediaType}-${first.id}`);
    }, 120);
    return () => clearTimeout(timer);
  }, [actorFilmography, isActorFilmographyLoading, selectedCastActor, setFocusedId, shouldEnableTvNav]);

  const rawTrailerKey = tmdbData?.trailerKey || null;
  const { trailerKey } = useEmbeddableTrailerKey(rawTrailerKey, { timeoutMs: 4800 });
  const trailerPlayerId = 'details-trailer-player';
  const trailerWatchUrl = trailerKey ? `https://www.youtube.com/watch?v=${trailerKey}` : '';
  const trailerUrl = useMemo(() => {
    if (!trailerKey) return '';
    const origin =
      typeof window !== 'undefined' ? `&origin=${encodeURIComponent(window.location.origin)}` : '';
    return `https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=0&controls=1&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&fs=1&cc_load_policy=0&disablekb=0&enablejsapi=1&playerapiid=${trailerPlayerId}&cacheBust=${trailerReloadToken}${origin}`;
  }, [trailerKey, trailerPlayerId, trailerReloadToken]);

  const closeTrailerModal = () => {
    setIsTrailerModalOpen(false);
    setTrailerStatus('idle');
    setTrailerErrorTitle('Trailer indisponível no player');
    setTrailerErrorMessage('');
  };

  const retryTrailerPlayback = () => {
    setTrailerStatus('loading');
    setTrailerErrorTitle('Trailer indisponível no player');
    setTrailerErrorMessage('');
    setTrailerReloadToken((current) => current + 1);
  };

  const clearTrailerLoadTimeout = () => {
    if (typeof window === 'undefined') return;
    if (trailerLoadTimeoutRef.current !== null) {
      window.clearTimeout(trailerLoadTimeoutRef.current);
      trailerLoadTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    if (!isTrailerModalOpen || !trailerUrl || typeof window === 'undefined') {
      return;
    }

    setTrailerStatus('loading');
    setTrailerErrorTitle('Trailer indisponível no player');
    setTrailerErrorMessage('');

    const mapTrailerError = (code: number) => {
      if (code === 2) {
        return {
          title: 'Link de trailer inválido',
          message: 'A origem retornou um formato inválido para este trailer.',
        };
      }
      if (code === 5) {
        return {
          title: 'Formato não suportado',
          message: 'Este trailer não pode ser reproduzido neste dispositivo.',
        };
      }
      if (code === 100) {
        return {
          title: 'Trailer removido',
          message: 'Este trailer não está mais disponível no YouTube.',
        };
      }
      if (code === 101 || code === 150) {
        return {
          title: 'Reprodução bloqueada',
          message: 'A fonte bloqueou reprodução incorporada. Use "Abrir no YouTube".',
        };
      }
      return {
        title: 'Trailer indisponível no player',
        message: 'Não foi possível carregar este trailer incorporado.',
      };
    };

    clearTrailerLoadTimeout();
    trailerLoadTimeoutRef.current = window.setTimeout(() => {
      setTrailerStatus((current) => {
        if (current === 'ready') return current;
        setTrailerErrorTitle('Falha ao carregar trailer');
        setTrailerErrorMessage('Tempo de resposta excedido no carregamento do trailer.');
        return 'error';
      });
      trailerLoadTimeoutRef.current = null;
    }, 22000);

    const handleMessage = (event: MessageEvent) => {
      if (
        typeof event.origin !== 'string' ||
        (!event.origin.includes('youtube.com') && !event.origin.includes('youtube-nocookie.com'))
      ) {
        return;
      }

      let payload: any = null;
      if (typeof event.data === 'string') {
        try {
          payload = JSON.parse(event.data);
        } catch {
          payload = null;
        }
      } else if (event.data && typeof event.data === 'object') {
        payload = event.data;
      }

      if (!payload || typeof payload !== 'object' || typeof payload.event !== 'string') {
        return;
      }

      if (payload.id && payload.id !== trailerPlayerId) {
        return;
      }

      if (payload.event === 'onReady') {
        clearTrailerLoadTimeout();
        setTrailerStatus('ready');
        setTrailerErrorMessage('');
        return;
      }

      if (payload.event === 'onStateChange') {
        const stateCode = Number(payload.info);
        if (stateCode === 1 || stateCode === 3 || stateCode === 2 || stateCode === 5) {
          clearTrailerLoadTimeout();
          setTrailerStatus('ready');
        }
        return;
      }

      if (payload.event === 'onError') {
        clearTrailerLoadTimeout();
        setTrailerStatus('error');
        const mappedError = mapTrailerError(Number(payload.info));
        setTrailerErrorTitle(mappedError.title);
        setTrailerErrorMessage(mappedError.message);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      clearTrailerLoadTimeout();
      window.removeEventListener('message', handleMessage);
    };
  }, [isTrailerModalOpen, trailerPlayerId, trailerUrl]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      style={{
        position: 'fixed',
        top: 0,
        left: sideMenuOffset,
        right: 0,
        bottom: 0,
        zIndex: 250,
        backgroundColor: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        transition: 'left 220ms ease-out',
      }}
    >
      {/* Full-screen backdrop image */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: backdropHeight,
        overflow: 'hidden',
      }}>
        <motion.div
          initial={{ scale: 1.1 }}
          animate={{ scale: 1.0 }}
          transition={{ duration: 10, ease: 'linear' }}
          style={{ width: '100%', height: '100%' }}
        >
          <Image
            source={{ uri: displayData.backdrop || fallbackBg }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center top',
            } as any}
            resizeMode="cover"
          />
        </motion.div>
        {/* Hero-like gradient overlays */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'linear-gradient(to top, #050505 0%, rgba(5,5,5,0.95) 8%, rgba(5,5,5,0.6) 22%, rgba(5,5,5,0.08) 42%, transparent 100%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '65%',
            pointerEvents: 'none',
            background:
              'linear-gradient(to right, #050505 0%, rgba(5,5,5,0.98) 25%, rgba(5,5,5,0.6) 55%, transparent 100%)',
          }}
        />
      </div>

      <Text
        style={[
          styles.topLogo,
          isCompactDetails && styles.topLogoCompact,
          {
            position: 'absolute',
            top: layout.isMobile ? 14 : 20,
            right: contentPadding,
            zIndex: 90,
            textAlign: 'right' as const,
          },
        ]}
      >
        XANDEFLIX
      </Text>

      {/* Scrollable content */}
      <ScrollView
        ref={scrollViewRef as any}
        data-details-scroll="1"
        style={{ flex: 1, zIndex: 2 }}
        contentContainerStyle={[
          styles.scrollContent,
          isCompactDetails && styles.scrollContentCompact,
          {
            width: '100%',
            minWidth: '100%',
            paddingHorizontal: contentPadding,
            paddingTop: detailsTopPadding,
            paddingBottom: layout.bottomNavigationHeight + 40,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Main Content using Tailwind Flow */}
        <div className="flex flex-col gap-10 w-full max-w-[1380px] mx-auto z-10 relative">
          
          {/* Top Frame: Poster + Info */}
          <motion.div
            ref={detailsTopFrameRef as any}
            initial={false}
            animate={{
              scale: isTopDetailsFocused ? 1.01 : 1,
              y: isTopDetailsFocused ? -2 : 0,
            }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className={`flex ${shouldStackDetails ? 'flex-col items-center text-center' : 'flex-row items-start'} gap-8 w-full`}
            style={{
              padding: isTv ? '30px' : '24px',
              borderRadius: isTv ? 24 : 16,
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
            }}
          >
            {/* Poster */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="shrink-0"
              style={{ width: shouldStackDetails ? 200 : isTv ? 180 : 260 }}
            >
              <div
                className="overflow-hidden rounded-xl shadow-2xl"
                style={{ width: '100%', height: shouldStackDetails ? 300 : isTv ? 270 : 390 }}
              >
                <Image
                  source={{ uri: displayData.thumbnail }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="cover"
                />
              </div>
              {streamingProvider?.name && (
                <div
                  style={{
                    marginTop: isTv ? 12 : 14,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: shouldStackDetails ? 'center' : 'flex-start',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: isTv ? 9 : 10,
                      padding: isTv ? '10px 14px' : '12px 16px',
                      borderRadius: 14,
                      backgroundColor: 'rgba(0,0,0,0.44)',
                      border: '1px solid rgba(255,255,255,0.14)',
                    }}
                  >
                    {streamingProvider.logo && (
                      <Image
                        source={{ uri: streamingProvider.logo }}
                        style={{ width: isTv ? 24 : 28, height: isTv ? 24 : 28, borderRadius: 6 } as any}
                        resizeMode="contain"
                      />
                    )}
                    <span
                      style={{
                        color: 'rgba(255,255,255,0.98)',
                        fontSize: isTv ? 15 : 18,
                        fontWeight: 900,
                        letterSpacing: 0.15,
                        fontFamily: 'Outfit',
                        lineHeight: isTv ? '18px' : '22px',
                        textShadow: '0 2px 10px rgba(0,0,0,0.72)',
                      }}
                    >
                      {streamingProvider.name}
                      {streamingProvider.region !== 'BR' ? ` (${streamingProvider.region})` : ''}
                    </span>
                  </div>
                </div>
              )}
            </motion.div>

            {/* Info */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="flex flex-col flex-1 w-full gap-5"
            >
              <h1
                className={`font-black text-white leading-tight tracking-tighter m-0 ${isTv ? 'text-4xl' : isCompactDetails ? 'text-3xl' : 'text-5xl'}`}
                style={{ fontFamily: 'Outfit', textShadow: titleTextShadow }}
              >
                {cleanMediaTitle(media.title).cleanTitle || media.title}
              </h1>

              <div className={`flex flex-wrap items-center gap-3 text-white/75 font-bold ${isTv ? 'text-sm' : 'text-lg'}`}>
                <div className="bg-[#E50914] text-white px-3 py-1 rounded text-xs tracking-widest uppercase">
                  {media.type === 'movie' ? 'FILME' : 'SÉRIE'}
                </div>
                <div className="flex items-center text-yellow-500 gap-1">
                  <Star size={16} fill="currentColor" /> {displayData.rating}
                </div>
                <span>{displayData.year}</span>
                <span className="text-white/30">•</span>
                <span>{media.duration || 'VOD'}</span>
                <span className="text-white/30">•</span>
                <span>{genreLabel}</span>
              </div>

              {/* Actions */}
              <div className={`flex flex-wrap items-center gap-3 ${isCompactDetails ? 'justify-center' : ''}`}>
                {primaryActionMedia && (
                  <button
                    type="button"
                    data-nav-id="details-play"
                    ref={(el) => { if (el) registerNode('details-play', el, 'modal', {
                      onFocus: () => ensureTopDetailsVisible(true),
                      onEnter: () => onPlay(primaryActionMedia),
                      disableAutoScroll: true,
                    }); } }
                    onClick={() => onPlay(primaryActionMedia)}
                    className="flex items-center justify-center gap-2 bg-[#E50914] text-white font-bold rounded-xl outline-none cursor-pointer border-none"
                    style={{ padding: isTv ? '12px 24px' : '16px 36px', fontSize: isTv ? 16 : 20, fontFamily: 'Outfit' }}
                  >
                    <Play size={isTv ? 18 : 24} fill="currentColor" />
                    {shouldResumePlayback ? 'Continuar' : 'Assistir'}
                  </button>
                )}

                {trailerKey && (
                  <button
                    type="button"
                    data-nav-id="details-trailer"
                    ref={(el) => { if (el) registerNode('details-trailer', el, 'modal', {
                      onFocus: () => ensureTopDetailsVisible(true),
                      onEnter: () => { setTrailerStatus('loading'); setIsTrailerModalOpen(true); },
                      disableAutoScroll: true,
                    }); } }
                    onClick={() => { setTrailerStatus('loading'); setIsTrailerModalOpen(true); }}
                    className="flex items-center justify-center gap-2 bg-white/5 text-white font-bold rounded-full outline-none cursor-pointer border border-white/20"
                    style={{ padding: isTv ? '8px 20px' : '12px 24px', fontSize: isTv ? 14 : 16, fontFamily: 'Outfit' }}
                  >
                    <Clapperboard size={isTv ? 16 : 20} /> Trailer
                  </button>
                )}

                <button
                  type="button"
                  data-nav-id="details-favorite"
                  ref={(el) => { if (el) registerNode('details-favorite', el, 'modal', {
                    onFocus: () => ensureTopDetailsVisible(true),
                    onEnter: () => toggleFavorite(favoriteKey),
                    disableAutoScroll: true,
                  }); } }
                  onClick={() => toggleFavorite(favoriteKey)}
                  className={`flex items-center justify-center gap-2 font-bold rounded-full outline-none cursor-pointer border ${isFavorite ? 'bg-red-500/10 border-red-500/50 text-[#E50914]' : 'bg-white/5 border-white/20 text-white'}`}
                  style={{ padding: isTv ? '8px 20px' : '12px 24px', fontSize: isTv ? 14 : 16, fontFamily: 'Outfit' }}
                >
                  <Heart size={isTv ? 16 : 20} fill={isFavorite ? 'currentColor' : 'transparent'} /> 
                  {isFavorite ? 'Salvo' : 'Favoritar'}
                </button>
              </div>

              {/* Synopsis */}
              <div className="flex flex-col gap-2 mt-2 w-full max-w-[700px]">
                <span className="text-white/40 text-xs font-black tracking-widest uppercase" style={{ fontFamily: 'Outfit' }}>Sinopse</span>
                {displayData.description ? (
                  <div className="relative">
                    <p
                      className="text-white/80 m-0 leading-relaxed line-clamp-4 md:line-clamp-5"
                      style={{ fontSize: isTv ? 14 : 18, fontFamily: 'Outfit', textShadow: synopsisTextShadow }}
                    >
                      {displayData.description}
                    </p>
                    {tmdbLoading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px] rounded">
                         <div className="flex items-center gap-3 bg-black/60 px-4 py-2 rounded-full border border-white/10">
                            <Loader2 size={16} color="#E50914" className="animate-spin" /> 
                            <span className="text-xs text-white/70 font-bold uppercase tracking-wider">Atualizando...</span>
                         </div>
                      </div>
                    )}
                  </div>
                ) : tmdbLoading ? (
                  <div className="flex items-center gap-3 py-2 text-white/60">
                    <Loader2 size={20} color="#E50914" className="animate-spin" /> 
                    <span className="text-sm">Buscando informações...</span>
                  </div>
                ) : (
                  <p
                    className="text-white/40 italic m-0"
                    style={{ fontSize: isTv ? 14 : 16, fontFamily: 'Outfit', textShadow: synopsisTextShadow }}
                  >
                    Sinopse não disponível.
                  </p>
                )}
              </div>

              {/* Cast */}
              <div className="flex flex-col gap-2 mt-1 w-full max-w-[780px]">
                <span className="text-white/40 text-xs font-black tracking-widest uppercase" style={{ fontFamily: 'Outfit' }}>
                  Elenco
                </span>
                {castList.length > 0 ? (
                  <div className={`flex flex-wrap gap-2 ${shouldStackDetails ? 'justify-center' : ''}`}>
                    {castList.map((member) => (
                      <button
                        key={`cast-${member.id}`}
                        type="button"
                        data-nav-id={`details-cast-${member.id}`}
                        ref={(el) => { if (el) registerNode(`details-cast-${member.id}`, el, 'modal', {
                          onFocus: () => ensureTopDetailsVisible(true),
                          onEnter: () => setSelectedCastActor({ id: member.id, name: member.name }),
                          disableAutoScroll: true,
                        }); } }
                        onClick={() => setSelectedCastActor({ id: member.id, name: member.name })}
                        className="outline-none cursor-pointer border border-white/20 bg-black/35 text-white rounded-full"
                        style={{
                          padding: isTv ? '8px 14px' : '10px 16px',
                          fontSize: isTv ? 13 : 14,
                          fontWeight: 700,
                          fontFamily: 'Outfit',
                        }}
                      >
                        {member.name}
                      </button>
                    ))}
                  </div>
                ) : tmdbLoading ? (
                  <div className="flex items-center gap-2 py-1 text-white/55">
                    <Loader2 size={16} color="#E50914" className="animate-spin" />
                    <span style={{ fontFamily: 'Outfit', fontSize: isTv ? 12 : 13 }}>Carregando elenco...</span>
                  </div>
                ) : (
                  <span style={{ color: 'rgba(255,255,255,0.45)', fontFamily: 'Outfit', fontSize: isTv ? 12 : 13 }}>
                    Elenco indisponível para este título.
                  </span>
                )}
              </div>

            </motion.div>
          </motion.div>

        {/* Seasons & Episodes */}
        {mergedSeriesSeasons.length > 0 && selectedSeason !== null && (
          <div style={styles.seasonsContainer as any}>
             <div style={{ position: 'relative', marginBottom: 30, zIndex: 10, alignSelf: 'flex-start', marginLeft: 20 }}>
               <button
                 data-nav-id="season-selector"
                 onClick={() => setIsSeasonDropdownOpen(!isSeasonDropdownOpen)}
                 ref={(el) => { if (el) registerNode('season-selector', el, 'modal', {
                    onFocus: () => {},
                    onEnter: () => setIsSeasonDropdownOpen(prev => !prev),
                    disableAutoScroll: true
                 }); }}
                 style={{
                   backgroundColor: 'rgba(255,255,255,0.08)',
                   border: '1px solid rgba(255,255,255,0.2)',
                   borderRadius: 8,
                   padding: '12px 24px',
                   color: 'white',
                   fontSize: 18,
                   fontWeight: 'bold',
                   display: 'flex',
                   alignItems: 'center',
                   gap: 12,
                   cursor: 'pointer',
                   outline: 'none',
                   fontFamily: 'Outfit, sans-serif'
                 }}
               >
                 Temporada {selectedSeason}
                 <ChevronDown size={20} color="rgba(255,255,255,0.7)" style={{ transform: isSeasonDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
               </button>

               {isSeasonDropdownOpen && (
                 <div style={{
                   position: 'absolute',
                   top: '100%',
                   left: 0,
                   marginTop: 8,
                   backgroundColor: '#141414',
                   border: '1px solid rgba(255,255,255,0.1)',
                   borderRadius: 8,
                   minWidth: 220,
                   maxHeight: 320,
                   overflowY: 'auto',
                   boxShadow: '0 10px 30px rgba(0,0,0,0.8)',
                   zIndex: 20
                 }} className="custom-scrollbar">
                   {mergedSeriesSeasons.map((season) => (
                      <div
                        key={season.seasonNumber}
                        role="button"
                        tabIndex={0}
                        data-nav-id={`details-season-${season.seasonNumber}`}
                        ref={(el) => { if (el) registerNode(`details-season-${season.seasonNumber}`, el, 'modal-seasons', {
                           onFocus: () => {},
                           onEnter: () => {
                              setSelectedSeason(season.seasonNumber);
                              setIsSeasonDropdownOpen(false);
                              setFocusedId('season-selector');
                           },
                           disableAutoScroll: true
                        }); }}
                        onClick={() => {
                           setSelectedSeason(season.seasonNumber);
                           setIsSeasonDropdownOpen(false);
                        }}
                        style={{
                          padding: '16px 24px',
                          color: selectedSeason === season.seasonNumber ? 'white' : 'rgba(255,255,255,0.6)',
                          backgroundColor: selectedSeason === season.seasonNumber ? 'rgba(255,255,255,0.08)' : 'transparent',
                          cursor: 'pointer',
                          fontSize: 16,
                          fontWeight: selectedSeason === season.seasonNumber ? 'bold' : 'normal',
                          outline: 'none',
                          fontFamily: 'Outfit, sans-serif'
                        }}
                      >
                        Temporada {season.seasonNumber}
                      </div>
                   ))}
                 </div>
               )}
             </div>
             
             <div style={styles.episodesGrid as any}>
               {selectedSeasonEpisodes.map((ep, idx) => {
                 const currentPos = watchHistory[ep.videoUrl];
                 const isStarted = Boolean(currentPos && currentPos > 10);

                 return (
                 <div
                   key={ep.id}
                   role="button"
                   tabIndex={0}
                   data-nav-id={`details-episode-${ep.id}`}
                   ref={(el) => { if (el) registerNode(`details-episode-${ep.id}`, el, 'modal-episodes', {
                     onFocus: () => {},
                     disableAutoScroll: true,
                     onEnter: () => onPlay({ 
                       ...media,
                       videoUrl: ep.videoUrl,
                       title: `${media.title} - ${ep.title}`,
                       currentEpisode: ep,
                       currentSeasonNumber: selectedSeason,
                      }),
                    }); } }
                   onClick={() => onPlay({ 
                     ...media,
                     videoUrl: ep.videoUrl,
                     title: `${media.title} - ${ep.title}`,
                     currentEpisode: ep,
                     currentSeasonNumber: selectedSeason,
                   })}
                   style={{
                     cursor: 'pointer',
                     borderRadius: 8,
                     outline: 'none',
                   }}
                 >
                   <View style={[styles.episodeCard]}>
                     <View style={[styles.episodeInner, { overflow: 'hidden' }]}>
                       <View style={[styles.episodeIndex, isStarted ? { opacity: 0.5 } : undefined]}>
                         <Text style={styles.episodeIndexText}>{idx + 1}</Text>
                       </View>
                       <View style={styles.episodeInfo}>
                         <Text style={[styles.episodeTitle, isStarted ? { color: '#E50914' } : undefined]}>{ep.title}</Text>
                         <Text style={styles.episodeSubtitle}>
                           Episódio {ep.episodeNumber} {isStarted ? `• Em andamento (${Math.floor(currentPos / 60)}m)` : ''}
                         </Text>
                       </View>
                       <View style={styles.episodePlayIcon}>
                         <Play size={20} color="white" />
                        </View>
                        {(() => {
                            const pData = playbackProgress[ep.videoUrl] || (ep.id ? playbackProgress[ep.id] : null);
                            if (!pData || !pData.duration || pData.currentTime < 10) return null;
                            const pct = Math.min(100, Math.max(0, (pData.currentTime / pData.duration) * 100));
                            return (
                              <View 
                                style={{ 
                                  position: 'absolute', 
                                  bottom: 0, 
                                  left: 0, 
                                  right: 0, 
                                  height: 3, 
                                  backgroundColor: 'rgba(255,255,255,0.1)' 
                                }}
                              >
                                <View 
                                  style={{ 
                                    width: `${pct}%`, 
                                    height: '100%', 
                                    backgroundColor: '#E50914'
                                  }} 
                                />
                              </View>
                            );
                         })()}
                       </View>
                     </View>
                   </div>
                 );
               })}
             </div>
          </div>
        )}

        {/* Related Content */}
        {relatedCategory && relatedCategory.items.length > 0 && (
          <div className="w-full mt-12 mb-8 pt-8 border-t border-white/10 z-10 relative">
            <CategoryRow 
              category={relatedCategory}
              rowIndex={999}
              navSection="modal-related"
              navIdPrefix="details-related-"
              disableSideMenuOffset
              tightTopSpacing
              onSeeAll={() => {}}
              onMediaFocus={() => {}}
              onMediaPress={(m) => onSelectMedia && onSelectMedia(m)}
            />
          </div>
        )}
      </div>
      <div style={{ height: 100 }} />
    </ScrollView>

    {selectedCastActor && (
      <div style={styles.actorModalBackdrop as any}>
        <div style={styles.actorModalCard as any}>
          <div style={styles.actorModalHeader as any}>
            <View style={{ flex: 1 }}>
              <Text style={styles.actorModalTitle}>Filmes com {selectedCastActor.name}</Text>
              <Text style={styles.actorModalSubtitle}>
                Filtro de títulos por ator com base no TMDB
              </Text>
            </View>
            <button
              type="button"
              onClick={closeActorFilmography}
              data-nav-id="actor-filmography-close"
              ref={(el) => { if (el) registerNode('actor-filmography-close', el, 'modal', {
                onEnter: closeActorFilmography,
                disableAutoScroll: true,
              }); } }
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'rgba(255,255,255,0.06)',
                color: 'white',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <X size={20} color="white" />
            </button>
          </div>

          <div style={styles.actorModalBody as any} className="custom-scrollbar">
            {isActorFilmographyLoading ? (
              <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Loader2 size={20} color="#E50914" className="animate-spin" />
                <span style={{ color: 'rgba(255,255,255,0.75)', fontFamily: 'Outfit', fontWeight: 700 }}>
                  Carregando filmografia...
                </span>
              </div>
            ) : actorFilmographyError ? (
              <div style={{ padding: 24, color: '#FCA5A5', fontFamily: 'Outfit', fontWeight: 700 }}>
                {actorFilmographyError}
              </div>
            ) : actorFilmography.length === 0 ? (
              <div style={{ padding: 24, color: 'rgba(255,255,255,0.62)', fontFamily: 'Outfit', fontWeight: 600 }}>
                Não encontramos filmes deste ator no TMDB.
              </div>
            ) : (
              <div style={styles.actorFilmographyGrid as any}>
                {actorFilmography.map((item) => (
                  <button
                    key={`actor-film-${item.mediaType}-${item.id}`}
                    type="button"
                    data-nav-id={`actor-filmography-item-${item.mediaType}-${item.id}`}
                    ref={(el) => { if (el) registerNode(`actor-filmography-item-${item.mediaType}-${item.id}`, el, 'modal', {
                      onEnter: () => handleFilmographySelect(item),
                      disableAutoScroll: true,
                    }); } }
                    onClick={() => handleFilmographySelect(item)}
                    style={{
                      width: '100%',
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      margin: 0,
                      cursor: 'pointer',
                      outline: 'none',
                      borderRadius: 10,
                      overflow: 'hidden',
                    }}
                  >
                    <div style={styles.actorFilmographyItem as any}>
                      <div style={styles.actorFilmographyPosterWrap as any}>
                        {item.poster ? (
                          <Image source={{ uri: item.poster }} style={styles.actorFilmographyPoster as any} resizeMode="cover" />
                        ) : (
                          <div style={styles.actorFilmographyPosterFallback as any}>
                            <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 800 }}>SEM CAPA</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )}

    {isTrailerModalOpen && trailerUrl && (
      <div style={styles.trailerModalBackdrop as any}>
        <div style={styles.trailerModalCard as any}>
          <div style={styles.trailerModalHeader as any}>
            <Text style={styles.trailerModalTitle}>Trailer Oficial</Text>
            <TouchableHighlight
              onPress={closeTrailerModal}
              underlayColor="rgba(255,255,255,0.1)"
              style={styles.trailerModalClose}
            >
              <View style={styles.iconWrap}>
                <X size={20} color="white" />
              </View>
            </TouchableHighlight>
          </div>
          <div style={styles.trailerFrameWrap as any}>
              <iframe
                id={trailerPlayerId}
                src={trailerUrl}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                onLoad={() => {
                  // Em Android WebView, o evento postMessage do YouTube nem sempre chega.
                  // Se o iframe carregou, liberamos o estado para esconder "Carregando...".
                  clearTrailerLoadTimeout();
                  setTrailerStatus((current) => (current === 'error' ? current : 'ready'));
                  setTrailerErrorMessage('');
                }}
                style={styles.trailerFrame as any}
              />
              {trailerStatus === 'loading' && (
                <div style={styles.trailerLoadingOverlay as any}>
                  <Text style={styles.trailerLoadingText}>Carregando trailer...</Text>
                </div>
              )}
              {trailerStatus === 'error' && (
                <div style={styles.trailerFallbackOverlay as any}>
                  <div style={styles.trailerFallbackCard as any}>
                    <Text style={styles.trailerFallbackTitle}>{trailerErrorTitle}</Text>
                    <Text style={styles.trailerFallbackText}>
                      {trailerErrorMessage || 'Não foi possível carregar este trailer incorporado.'}
                    </Text>
                    <div style={styles.trailerFallbackActions as any}>
                      <TouchableHighlight
                        onPress={retryTrailerPlayback}
                        underlayColor="#B80710"
                        style={styles.trailerFallbackPrimaryBtn}
                      >
                        <Text style={styles.trailerFallbackPrimaryBtnText}>Tentar novamente</Text>
                      </TouchableHighlight>
                      {!!trailerWatchUrl && (
                        <TouchableHighlight
                          onPress={() => {
                            if (typeof window !== 'undefined') {
                              window.open(trailerWatchUrl, '_blank', 'noopener,noreferrer');
                            }
                          }}
                          underlayColor="rgba(255,255,255,0.2)"
                          style={styles.trailerFallbackSecondaryBtn}
                        >
                          <Text style={styles.trailerFallbackSecondaryBtnText}>Abrir no YouTube</Text>
                        </TouchableHighlight>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
};

const styles = StyleSheet.create({
  topLogo: {
    fontSize: 32,
    fontWeight: '900',
    color: '#E50914',
    fontStyle: 'italic',
    letterSpacing: -1.2,
    fontFamily: 'Outfit',
    flexShrink: 1,
  },
  topLogoCompact: {
    fontSize: 24,
    letterSpacing: -1,
  },
  scrollContent: {
    paddingHorizontal: 80,
  },
  scrollContentCompact: {
    paddingHorizontal: 16,
  },
  contentContainer: {
    zIndex: 10,
    minHeight: 360,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    width: '100%',
  } as any,
  mainRowCompact: {
    flexDirection: 'column',
  },
  posterWrap: {
    width: 260,
    height: 390,
    borderRadius: 16,
    overflow: 'hidden',
    marginRight: 50,
  } as any,
  posterWrapCompact: {
    width: 180,
    height: 270,
    marginRight: 0,
    marginBottom: 24,
    alignSelf: 'center',
  },
  poster: {
    width: '100%',
    height: '100%',
  },
  title: {
    fontSize: 56,
    fontWeight: '900',
    color: 'white',
    fontFamily: 'Outfit',
    letterSpacing: -2,
    lineHeight: 60,
    marginBottom: 20,
    maxWidth: '90%',
  },
  titleCompact: {
    fontSize: 32,
    lineHeight: 38,
    maxWidth: '100%',
    marginBottom: 16,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 28,
    flexWrap: 'wrap',
  } as any,
  typeBadge: {
    backgroundColor: '#E50914',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 4,
    marginRight: 16,
  },
  typeBadgeText: {
    color: 'white',
    fontSize: 13,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  ratingVal: {
    color: '#EAB308',
    fontSize: 18,
    fontWeight: 'bold',
    marginLeft: 5,
  },
  metaSep: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 18,
    marginHorizontal: 10,
  },
  metaText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 18,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 36,
  } as any,
  actionRowCompact: {
    flexWrap: 'wrap',
    rowGap: 12,
    marginBottom: 28,
  },
  playBtn: {
    backgroundColor: '#E50914',
    paddingHorizontal: 36,
    paddingVertical: 16,
    borderRadius: 8,
  },
  playBtnCompact: {
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  playBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
  } as any,
  playBtnText: {
    color: 'white',
    fontSize: 20,
    fontWeight: 'bold',
    marginLeft: 10,
    fontFamily: 'Outfit',
  },
  playBtnTextCompact: {
    fontSize: 16,
  },
  circleBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  favoriteBtn: {
    minHeight: 50,
    paddingHorizontal: 18,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  favoriteBtnActive: {
    borderColor: 'rgba(229,9,20,0.45)',
    backgroundColor: 'rgba(229,9,20,0.12)',
  },
  favoriteBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  } as any,
  favoriteBtnText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'Outfit',
  },
  favoriteBtnTextActive: {
    color: '#FCA5A5',
  },
  trailerBtn: {
    minHeight: 50,
    paddingHorizontal: 18,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  iconWrap: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  actorModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1180,
    backgroundColor: 'rgba(0,0,0,0.82)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  },
  actorModalCard: {
    width: '100%',
    maxWidth: 1180,
    maxHeight: '82%',
    backgroundColor: '#090909',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  actorModalHeader: {
    minHeight: 74,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingLeft: 18,
    paddingRight: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  actorModalTitle: {
    color: 'white',
    fontSize: 24,
    fontWeight: '900',
    fontFamily: 'Outfit',
  },
  actorModalSubtitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    marginTop: 2,
    fontWeight: '600',
    letterSpacing: 0.4,
    fontFamily: 'Outfit',
  },
  actorModalBody: {
    flex: 1,
    overflowY: 'auto',
    padding: 16,
  },
  actorFilmographyGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
    gap: 14,
    alignItems: 'start',
    alignContent: 'start',
  },
  actorFilmographyItem: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    overflow: 'hidden',
  },
  actorFilmographyPosterWrap: {
    width: '100%',
    height: 250,
    backgroundColor: '#151515',
  },
  actorFilmographyPoster: {
    width: '100%',
    height: '100%',
  },
  actorFilmographyPosterFallback: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #101010, #1b1b1b)',
  },
  trailerModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1200,
    backgroundColor: 'rgba(0,0,0,0.82)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  },
  trailerModalCard: {
    width: '100%',
    maxWidth: 1100,
    backgroundColor: '#080808',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  trailerModalHeader: {
    height: 64,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 18,
    paddingRight: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  trailerModalTitle: {
    color: 'white',
    fontSize: 18,
    fontWeight: '800',
    fontFamily: 'Outfit',
  },
  trailerModalClose: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  trailerFrameWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    backgroundColor: '#000',
  },
  trailerFrame: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    borderWidth: 0,
  },
  trailerLoadingOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trailerLoadingText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'Outfit',
  },
  trailerFallbackOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  trailerFallbackCard: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 12,
    padding: 20,
    backgroundColor: 'rgba(8,8,8,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  trailerFallbackTitle: {
    color: 'white',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 10,
    fontFamily: 'Outfit',
  },
  trailerFallbackText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 16,
    fontFamily: 'Outfit',
  },
  trailerFallbackActions: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  trailerFallbackPrimaryBtn: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#E50914',
  },
  trailerFallbackPrimaryBtnText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '800',
    fontFamily: 'Outfit',
  },
  trailerFallbackSecondaryBtn: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  trailerFallbackSecondaryBtnText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Outfit',
  },
  synopsisBlock: {
    maxWidth: 700,
  },
  synopsisBlockCompact: {
    maxWidth: '100%',
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: 'rgba(255,255,255,0.4)',
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 12,
    fontFamily: 'Outfit',
  },
  synopsisText: {
    fontSize: 19,
    color: 'rgba(255,255,255,0.75)',
    lineHeight: 30,
  },
  loaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
  } as any,
  loaderText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 16,
    marginLeft: 12,
  },
  relatedSection: {
    marginTop: 50,
    marginBottom: 30,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  } as any,
  seasonsContainer: {
    marginTop: 50,
    marginBottom: 42,
    width: '100%',
  },
  seasonTabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
    marginBottom: 30,
    paddingBottom: 2,
  } as any,
  seasonTab: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    marginRight: 10,
  },
  seasonTabActive: {
    borderBottomWidth: 3,
    borderBottomColor: '#E50914',
  },
  seasonTabText: {
    fontSize: 20,
    color: 'rgba(255,255,255,0.5)',
    fontWeight: 'bold',
  },
  seasonTabTextActive: {
    color: 'white',
  },
  episodesGrid: {
    flexDirection: 'column',
    gap: 12,
    width: '100%',
    maxWidth: 800,
  } as any,
  episodeCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  episodeInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
  } as any,
  episodeIndex: {
    width: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  episodeIndexText: {
    fontSize: 24,
    color: 'rgba(255,255,255,0.3)',
    fontWeight: 'bold',
    fontFamily: 'Outfit',
  },
  episodeInfo: {
    flex: 1,
    marginLeft: 10,
  },
  episodeTitle: {
    fontSize: 18,
    color: 'white',
    fontWeight: '600',
    marginBottom: 4,
  },
  episodeSubtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
  },
  episodePlayIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
