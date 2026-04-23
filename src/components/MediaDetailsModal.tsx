import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableHighlight, Image, ImageBackground, ScrollView, FlatList } from 'react-native';
import { motion } from 'motion/react';
import { Play, ArrowLeft, Star, Loader2, Heart, Clapperboard, X, ChevronDown } from 'lucide-react';
import { Media } from '../types';
import { useTMDB } from '../hooks/useTMDB';
import { useEmbeddableTrailerKey } from '../hooks/useEmbeddableTrailerKey';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { useStore } from '../store/useStore';
import { CategoryRow } from './CategoryRow';
import { cleanMediaTitle } from '../lib/titleCleaner';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { useDiskCategory } from '../hooks/useDiskCategory';

interface MediaDetailsPageProps {
  media: Media;
  onClose: () => void;
  onPlay: (media: Media) => void;
  onSelectMedia?: (media: Media) => void;
}

export const MediaDetailsPage: React.FC<MediaDetailsPageProps> = ({ 
  media, 
  onClose, 
  onPlay,
  onSelectMedia
}) => {
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [isSeasonDropdownOpen, setIsSeasonDropdownOpen] = useState(false);
  const [isTrailerModalOpen, setIsTrailerModalOpen] = useState(false);
  const [trailerStatus, setTrailerStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [trailerErrorTitle, setTrailerErrorTitle] = useState('Trailer indisponível no player');
  const [trailerErrorMessage, setTrailerErrorMessage] = useState('');
  const [trailerReloadToken, setTrailerReloadToken] = useState(0);
  const trailerLoadTimeoutRef = useRef<number | null>(null);
  const layout = useResponsiveLayout();
  const isTvMode = useStore(state => state.isTvMode);
  const isTv = layout.isTvProfile;
  const shouldEnableTvNav = isTvMode && isTv;
  const { registerNode, setFocusedId, focusedId } = useTvNavigation({
    isActive: shouldEnableTvNav,
    onBack: onClose,
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
  const backdropHeight = isTv ? '54vh' : isCompactDetails ? '52vh' : layout.isTablet ? '60vh' : '70vh';
  const detailsTopPadding = isTv ? 118 : isCompactDetails ? 84 : 104;
  const isTopDetailsFocused = useMemo(
    () =>
      focusedId === 'details-back'
      || focusedId === 'details-play'
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
    const targetId = (media.videoUrl || mergedSeriesSeasons.length > 0) ? 'details-play' : 'details-back';
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
    
    // Remove o filme/série selecionado da lista e seleciona alguns aleatoriamente
    let relatedItems = relatedDiskItems.filter(item => item.id !== media.id);
    for (let i = relatedItems.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [relatedItems[i], relatedItems[j]] = [relatedItems[j], relatedItems[i]];
    }
    
    return {
      id: `related-${media.id}`,
      type: media.type,
      title: 'Titulos Semelhantes',
      items: relatedItems.slice(0, 15),
    };
  }, [media, relatedDiskItems]);

  // Fallback visual elegante quando não há backdrop disponível
  const fallbackBg = `https://images.unsplash.com/photo-1594909122845-11baa439b7bf?q=80&w=1920&auto=format&fit=crop`;

  const displayData = useMemo(() => {


    // 1. Tenta usar o backdrop vindo do TMDB
    let finalBackdrop = tmdbData?.backdrop;

    // 2. Se não houver backdrop do TMDB
    if (!finalBackdrop) {
      // ✅ REGRA: só usa o backdrop original da mídia se for diferente da thumbnail
      if (media.backdrop && media.backdrop !== media.thumbnail) {
        finalBackdrop = media.backdrop;
      } else {
        // 🔁 Fallback para imagem cinematográfica padrão
        finalBackdrop = fallbackBg;
      }
    }

    return {
      ...media,
      description: tmdbData?.description || media.description,
      year: tmdbData?.year || media.year,
      rating: tmdbData?.rating || media.rating,
      backdrop: finalBackdrop,
      thumbnail: tmdbData?.thumbnail || media.thumbnail,
    };
  }, [media, tmdbData]);
  const genreLabel = useMemo(() => {
    const genres = Array.isArray(tmdbData?.genres) ? tmdbData?.genres.filter(Boolean) : [];
    if (genres.length > 0) return genres.slice(0, 3).join(', ');
    return media.category;
  }, [media.category, tmdbData?.genres]);

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
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 320,
        backgroundColor: 'rgba(5,5,5,0.98)',
        display: 'flex',
        flexDirection: 'column',
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
          <ImageBackground
            source={{ uri: displayData.backdrop || fallbackBg }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        </motion.div>
        {/* Gradient overlays */}
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'linear-gradient(to bottom, rgba(5,5,5,0.3) 0%, rgba(5,5,5,0) 30%, rgba(5,5,5,0.7) 70%, #050505 100%)',
        }} />
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'linear-gradient(to right, rgba(5,5,5,0.9) 0%, rgba(5,5,5,0.4) 40%, rgba(5,5,5,0) 70%)',
        }} />
      </div>

      {/* Back button */}
      <View
        style={[
          styles.topBar,
          isCompactDetails && styles.topBarCompact,
          {
            paddingHorizontal: contentPadding,
            paddingTop: layout.isMobile ? 18 : 30,
          },
        ]}
      >
        <div
          role="button"
          tabIndex={0}
          data-nav-id="details-back"
          ref={(el) => { if (el) registerNode('details-back', el, 'modal', {
            onFocus: () => ensureTopDetailsVisible(true),
            onEnter: onClose,
            disableAutoScroll: true,
            }); } }
          onClick={onClose}
          style={{
            cursor: 'pointer',
            borderRadius: 50,
            outline: 'none',
          }}
        >
          <View style={styles.backButton}>
            <View style={styles.backInner}>
              <View style={styles.iconWrap}><ArrowLeft size={24} color="white" /></View>
              <Text style={styles.backText}>Voltar</Text>
            </View>
          </View>
        </div>
        <Text
          style={[
            styles.topLogo,
            isCompactDetails && styles.topLogoCompact,
            { textAlign: 'right' as const },
          ]}
        >
          XANDEFLIX
        </Text>
      </View>

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
        {/* Main Content */}
        <View
          style={[
            styles.contentContainer,
            {
              width: '100%',
              maxWidth: isTv ? 1380 : 1280,
              alignSelf: 'stretch',
              marginLeft: 'auto',
              marginRight: 'auto',
            },
          ]}
        >
          <motion.div
            ref={detailsTopFrameRef}
            initial={false}
            animate={{
              scale: isTopDetailsFocused ? 1.01 : 1,
              y: isTopDetailsFocused ? -2 : 0,
            }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            style={{
              width: '100%',
              borderRadius: isTv ? 18 : 14,
              padding: isTv ? '24px 24px 30px 24px' : '16px 20px 30px 20px',
              background: 'linear-gradient(180deg, rgba(12,12,12,0.7) 0%, rgba(5,5,5,0.3) 100%)',
              border: isTopDetailsFocused
                ? '1px solid rgba(255,255,255,0.3)'
                : '1px solid rgba(255,255,255,0.15)',
              boxShadow: isTopDetailsFocused
                ? '0 20px 54px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.16)'
                : '0 10px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05)',
              transformOrigin: 'center top',
            }}
          >
          <View style={[styles.mainRow, shouldStackDetails && styles.mainRowCompact]}>
            {/* Poster */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              <View style={[
                styles.posterWrap, 
                isCompactDetails && styles.posterWrapCompact,
                isTv && { width: 160, height: 240, marginRight: 30 },
              ]}>
                <Image
                  source={{ uri: displayData.thumbnail }}
                  style={styles.poster as any}
                  resizeMode="contain"
                />
              </View>
            </motion.div>

            {/* Info */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              style={{
                flex: 1,
                minWidth: shouldStackDetails ? 0 : 320,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <h1
                style={{
                  margin: 0,
                  color: 'white',
                  fontFamily: 'Outfit, sans-serif',
                  fontWeight: 900,
                  letterSpacing: -1.2,
                  lineHeight: isTv ? '34px' : isCompactDetails ? '38px' : '56px',
                  fontSize: isTv ? 28 : isCompactDetails ? 32 : 56,
                  marginBottom: isCompactDetails ? 16 : 20,
                }}
              >
                {cleanMediaTitle(media.title).cleanTitle || media.title}
              </h1>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 10,
                  marginBottom: 28,
                }}
              >
                <div
                  style={{
                    backgroundColor: '#E50914',
                    color: 'white',
                    borderRadius: 4,
                    padding: '4px 12px',
                    fontSize: 13,
                    fontWeight: 800,
                    letterSpacing: 1,
                  }}
                >
                  {media.type === 'movie' ? 'FILME' : 'SÉRIE'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', color: '#EAB308', fontWeight: 800, fontSize: 18 }}>
                  <Star size={16} color="#EAB308" fill="#EAB308" />
                  <span style={{ marginLeft: 6 }}>{displayData.rating}</span>
                </div>
                <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: 18 }}>{displayData.year}</span>
                <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 18 }}>•</span>
                <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: 18 }}>{media.duration || 'VOD'}</span>
                <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 18 }}>•</span>
                <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: 18 }}>{genreLabel}</span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: isCompactDetails ? 'wrap' : 'nowrap',
                  gap: 12,
                  marginBottom: isCompactDetails ? 28 : 36,
                }}
              >
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
                    style={{
                      cursor: 'pointer',
                      borderRadius: 10,
                      outline: 'none',
                      display: 'inline-flex',
                      border: 'none',
                      background: '#E50914',
                      color: 'white',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: isTv ? '10px 20px' : isCompactDetails ? '14px 24px' : '16px 36px',
                      fontSize: isTv ? 14 : isCompactDetails ? 16 : 20,
                      fontWeight: 800,
                      fontFamily: 'Outfit, sans-serif',
                      gap: 10,
                    }}
                  >
                    <Play size={isTv ? 16 : 22} color="white" fill="white" />
                    {shouldResumePlayback ? 'Continuar Assistindo' : 'Assistir Agora'}
                  </button>
                )}

                {trailerKey && (
                  <button
                    type="button"
                    data-nav-id="details-trailer"
                    ref={(el) => { if (el) registerNode('details-trailer', el, 'modal', {
                      onFocus: () => ensureTopDetailsVisible(true),
                      disableAutoScroll: true,
                      onEnter: () => {
                        setTrailerStatus('loading');
                        setTrailerErrorTitle('Trailer indisponível no player');
                        setTrailerErrorMessage('');
                        setIsTrailerModalOpen(true);
                      },
                    }); } }
                    onClick={() => {
                      setTrailerStatus('loading');
                      setTrailerErrorTitle('Trailer indisponível no player');
                      setTrailerErrorMessage('');
                      setIsTrailerModalOpen(true);
                    }}
                    style={{
                      cursor: 'pointer',
                      borderRadius: 25,
                      outline: 'none',
                      display: 'inline-flex',
                      border: '1px solid rgba(255,255,255,0.2)',
                      background: 'rgba(255,255,255,0.04)',
                      color: 'white',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minHeight: isTv ? 38 : 50,
                      padding: isTv ? '0 12px' : '0 18px',
                      fontSize: isTv ? 12 : 15,
                      fontWeight: 700,
                      fontFamily: 'Outfit, sans-serif',
                      gap: 10,
                    }}
                  >
                    <Clapperboard size={isTv ? 16 : 20} color="white" />
                    Trailer
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
                  style={{
                    cursor: 'pointer',
                    borderRadius: 25,
                    outline: 'none',
                    display: 'inline-flex',
                    border: isFavorite ? '1px solid rgba(229,9,20,0.45)' : '1px solid rgba(255,255,255,0.2)',
                    background: isFavorite ? 'rgba(229,9,20,0.12)' : 'rgba(255,255,255,0.04)',
                    color: 'white',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: isTv ? 38 : 50,
                    padding: isTv ? '0 12px' : '0 18px',
                    fontSize: isTv ? 12 : 15,
                    fontWeight: 700,
                    fontFamily: 'Outfit, sans-serif',
                    gap: 10,
                  }}
                >
                  <Heart size={isTv ? 16 : 22} color={isFavorite ? '#E50914' : 'white'} fill={isFavorite ? '#E50914' : 'transparent'} />
                  {isFavorite ? 'Favoritado' : 'Favoritar'}
                </button>
              </div>

              <View style={{ maxWidth: isTv ? 500 : 700, overflow: 'hidden' }}>
                <Text
                  style={{
                    fontSize: isTv ? 11 : 14,
                    fontWeight: '800',
                    color: 'rgba(255,255,255,0.45)',
                    textTransform: 'uppercase',
                    letterSpacing: 2,
                    marginBottom: isTv ? 8 : 12,
                    fontFamily: 'Outfit',
                  }}
                >
                  Sinopse
                </Text>
                {tmdbLoading ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
                    <Loader2 color="#E50914" size={isTv ? 16 : 22} />
                    <Text style={{ fontSize: isTv ? 12 : 16, color: 'rgba(255,255,255,0.65)', fontFamily: 'Outfit' }}>Buscando informações...</Text>
                  </View>
                ) : (
                  <Text
                    style={{
                      margin: 0,
                      fontSize: isTv ? 13 : 19,
                      color: 'rgba(255,255,255,0.78)',
                      lineHeight: isTv ? 20 : 30,
                      fontFamily: 'Outfit',
                    }}
                  >
                    {(() => {
                      const desc = displayData.description || 'Nenhuma sinopse disponível para este título.';
                      const maxLen = isTv ? 160 : 250;
                      return desc.length > maxLen ? desc.substring(0, maxLen).trim() + '...' : desc;
                    })()}
                  </Text>
                )}
              </View>
            </motion.div>
          </View>
          </motion.div>
        </View>

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
          <View style={styles.relatedSection}>
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
          </View>
        )}

        {/* Extra bottom spacing */}
        <View style={{ height: 100 }} />
      </ScrollView>

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
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingHorizontal: 40,
    paddingTop: 30,
    paddingBottom: 20,
    zIndex: 100,
  },
  topBarCompact: {
    paddingBottom: 14,
  },
  backButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  backInner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
    fontFamily: 'Outfit',
  },
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
