import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableHighlight, Image, ImageBackground, ScrollView, FlatList } from 'react-native';
import { motion } from 'motion/react';
import { Play, ArrowLeft, Star, Loader2, Heart, Share2, Clapperboard, X } from 'lucide-react';
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
  const [isTrailerModalOpen, setIsTrailerModalOpen] = useState(false);
  const [trailerStatus, setTrailerStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [trailerErrorTitle, setTrailerErrorTitle] = useState('Trailer indisponível no player');
  const [trailerErrorMessage, setTrailerErrorMessage] = useState('');
  const [trailerReloadToken, setTrailerReloadToken] = useState(0);
  const layout = useResponsiveLayout();
  const isTvMode = useStore(state => state.isTvMode);
  const { registerNode, setFocusedId } = useTvNavigation({ isActive: isTvMode, onBack: onClose, subscribeFocused: false });
  const scrollViewRef = useRef<ScrollView>(null);
  const isTv = layout.isTvProfile;
  const contentPadding = isTv ? 40 : layout.isMobile ? 16 : layout.isTablet ? 24 : 80;
  const backdropHeight = isTv ? '50vh' : layout.isMobile ? '52vh' : layout.isTablet ? '60vh' : '70vh';
  const spacerHeight = layout.height * (isTv ? 0.18 : layout.isMobile ? 0.22 : layout.isTablet ? 0.28 : 0.35);

  useEffect(() => {
    if (media.seasons && media.seasons.length > 0) {
      setSelectedSeason(media.seasons[0].seasonNumber);
    } else {
      setSelectedSeason(null);
    }
  }, [media]);

  useEffect(() => {
    setIsTrailerModalOpen(false);
    setTrailerStatus('idle');
    setTrailerErrorTitle('Trailer indisponível no player');
    setTrailerErrorMessage('');
    setTrailerReloadToken(0);
  }, [media.id]);

  const watchHistory = useStore(state => state.watchHistory);
  const favorites = useStore(state => state.favorites);
  const toggleFavorite = useStore(state => state.toggleFavorite);
  const { items: relatedDiskItems } = useDiskCategory(media.category, 0, 140);
  const { data: tmdbData, loading: tmdbLoading } = useTMDB(media.title, media.type);
  const favoriteKey = media.videoUrl || `media:${media.id}`;
  const isFavorite = favorites.includes(favoriteKey) || favorites.includes(media.id);

  // Auto-focus the primary action when modal opens
  useEffect(() => {
    if (!isTvMode) return;
    const timer = setTimeout(() => {
      const targetId = (media.videoUrl || (media.seasons && media.seasons.length > 0)) ? 'details-play' : 'details-back';
      setFocusedId(targetId);
    }, 300);
    return () => clearTimeout(timer);
  }, [media.videoUrl, media.seasons, setFocusedId, isTvMode]);

  const primaryActionMedia = useMemo(() => {
    if (!media.seasons || media.seasons.length === 0) {
      return media.videoUrl ? media : null;
    }

    const resumableEpisode = media.seasons
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

    const firstSeason = media.seasons[0];
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
  }, [media, watchHistory]);

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
    if (!media) return null;

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

  const rawTrailerKey = tmdbData?.trailerKey || null;
  const { trailerKey } = useEmbeddableTrailerKey(rawTrailerKey, { timeoutMs: 4800 });
  const trailerPlayerId = 'details-trailer-player';
  const trailerWatchUrl = trailerKey ? `https://www.youtube.com/watch?v=${trailerKey}` : '';
  const trailerUrl = useMemo(() => {
    if (!trailerKey) return '';
    const origin =
      typeof window !== 'undefined' ? `&origin=${encodeURIComponent(window.location.origin)}` : '';
    return `https://www.youtube.com/embed/${trailerKey}?autoplay=1&mute=0&controls=1&modestbranding=1&playsinline=1&rel=0&enablejsapi=1&playerapiid=${trailerPlayerId}&cacheBust=${trailerReloadToken}${origin}`;
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

    const timeoutId = window.setTimeout(() => {
      setTrailerStatus((current) => {
        if (current === 'ready') return current;
        setTrailerErrorTitle('Falha ao carregar trailer');
        setTrailerErrorMessage('Tempo de resposta excedido no carregamento do trailer.');
        return 'error';
      });
    }, 10000);

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
        window.clearTimeout(timeoutId);
        setTrailerStatus('ready');
        setTrailerErrorMessage('');
        return;
      }

      if (payload.event === 'onStateChange') {
        const stateCode = Number(payload.info);
        if (stateCode === 1 || stateCode === 3 || stateCode === 2 || stateCode === 5) {
          window.clearTimeout(timeoutId);
          setTrailerStatus('ready');
        }
        return;
      }

      if (payload.event === 'onError') {
        window.clearTimeout(timeoutId);
        setTrailerStatus('error');
        const mappedError = mapTrailerError(Number(payload.info));
        setTrailerErrorTitle(mappedError.title);
        setTrailerErrorMessage(mappedError.message);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.clearTimeout(timeoutId);
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
        zIndex: 900,
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
          layout.isCompact && styles.topBarCompact,
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
          ref={(el) => el && registerNode('details-back', el, 'modal', {
            onFocus: () => {},
            onEnter: onClose,
            disableAutoScroll: true,
          })}
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
        <Text style={[styles.topLogo, layout.isCompact && styles.topLogoCompact]}>XANDEFLIX</Text>
      </View>

      {/* Scrollable content */}
      <ScrollView
        style={{ flex: 1, zIndex: 2 }}
        contentContainerStyle={[
          styles.scrollContent,
          layout.isCompact && styles.scrollContentCompact,
          {
            paddingHorizontal: contentPadding,
            paddingBottom: layout.bottomNavigationHeight + 40,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Spacer to push content below the backdrop */}
        <View style={{ height: spacerHeight }} />

        {/* Main Content */}
        <View style={styles.contentContainer}>
          <View style={[styles.mainRow, layout.isCompact && styles.mainRowCompact, isTv && { flexDirection: 'row' as any }]}>
            {/* Poster */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              <View style={[
                styles.posterWrap, 
                layout.isCompact && styles.posterWrapCompact,
                isTv && { width: 160, height: 240, marginRight: 30 },
              ]}>
                <Image
                  source={{ uri: displayData.thumbnail }}
                  style={styles.poster}
                  resizeMode="contain"
                />
              </View>
            </motion.div>

            {/* Info */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              style={{ flex: 1 }}
            >
              <Text style={[
                styles.title, 
                layout.isCompact && styles.titleCompact,
                isTv && { fontSize: 28, lineHeight: 34, marginBottom: 10 },
              ]}>{cleanMediaTitle(media.title).cleanTitle}</Text>

              {/* Meta badges */}
              <View style={styles.metaRow}>
                <View style={styles.typeBadge}>
                  <Text style={styles.typeBadgeText}>{media.type === 'movie' ? 'FILME' : 'SÉRIE'}</Text>
                </View>
                <View style={styles.metaItem}>
                  <View style={styles.iconWrap}><Star size={16} color="#EAB308" fill="#EAB308" /></View>
                  <Text style={styles.ratingVal}>{displayData.rating}</Text>
                </View>
                <Text style={styles.metaSep}>•</Text>
                <Text style={styles.metaText}>{displayData.year}</Text>
                <Text style={styles.metaSep}>•</Text>
                <Text style={styles.metaText}>{media.duration || 'VOD'}</Text>
                <Text style={styles.metaSep}>•</Text>
                <Text style={styles.metaText}>{media.category}</Text>
              </View>

              {/* Actions */}
              <View style={[styles.actionRow, layout.isCompact && styles.actionRowCompact]}>
                {primaryActionMedia && (
                  <div
                    role="button"
                    tabIndex={0}
                    data-nav-id="details-play"
                    ref={(el) => el && registerNode('details-play', el, 'modal', {
                      onFocus: () => {},
                      onEnter: () => onPlay(primaryActionMedia),
                      disableAutoScroll: true,
                    })}
                    onClick={() => onPlay(primaryActionMedia)}
                    style={{
                      cursor: 'pointer',
                      borderRadius: 8,
                      outline: 'none',
                    }}
                  >
                    <View style={[
                      styles.playBtn, 
                      layout.isCompact && styles.playBtnCompact,
                      isTv && { paddingHorizontal: 20, paddingVertical: 10 },
                    ]}>
                      <View style={styles.playBtnInner}>
                        <View style={styles.iconWrap}><Play size={isTv ? 16 : 22} color="white" fill="white" /></View>
                        <Text style={[
                          styles.playBtnText, 
                          layout.isCompact && styles.playBtnTextCompact,
                          isTv && { fontSize: 14 },
                        ]}>
                          {shouldResumePlayback ? 'Continuar Assistindo' : 'Assistir Agora'}
                        </Text>
                      </View>
                    </View>
                  </div>
                )}

                {trailerKey && (
                  <div
                    role="button"
                    tabIndex={0}
                    data-nav-id="details-trailer"
                    ref={(el) => el && registerNode('details-trailer', el, 'modal', {
                      onFocus: () => {},
                      disableAutoScroll: true,
                      onEnter: () => {
                        setTrailerStatus('loading');
                        setTrailerErrorTitle('Trailer indisponível no player');
                        setTrailerErrorMessage('');
                        setIsTrailerModalOpen(true);
                      },
                    })}
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
                    }}
                  >
                    <View style={[styles.trailerBtn, isTv && { minHeight: 38, paddingHorizontal: 12 }]}>
                      <View style={styles.favoriteBtnInner}>
                        <Clapperboard size={isTv ? 16 : 20} color="white" />
                        <Text style={[styles.favoriteBtnText, isTv && { fontSize: 12 }]}>Trailer</Text>
                      </View>
                    </View>
                  </div>
                )}

                <div
                  role="button"
                  tabIndex={0}
                  data-nav-id="details-favorite"
                  ref={(el) => el && registerNode('details-favorite', el, 'modal', {
                    onFocus: () => {},
                    onEnter: () => toggleFavorite(favoriteKey),
                    disableAutoScroll: true,
                  })}
                  onClick={() => toggleFavorite(favoriteKey)}
                  style={{
                    cursor: 'pointer',
                    borderRadius: 25,
                    outline: 'none',
                  }}
                >
                  <View style={[styles.favoriteBtn, isFavorite && styles.favoriteBtnActive, isTv && { minHeight: 38, paddingHorizontal: 12 }]}>
                    <View style={styles.favoriteBtnInner}>
                      <Heart size={isTv ? 16 : 22} color={isFavorite ? '#E50914' : 'white'} fill={isFavorite ? '#E50914' : 'transparent'} />
                      <Text style={[styles.favoriteBtnText, isFavorite && styles.favoriteBtnTextActive, isTv && { fontSize: 12 }]}>
                        {isFavorite ? 'Favoritado' : 'Favoritar'}
                      </Text>
                    </View>
                  </View>
                </div>

                <div
                  role="button"
                  tabIndex={0}
                  data-nav-id="details-share"
                  ref={(el) => el && registerNode('details-share', el, 'modal', {
                    onFocus: () => {},
                    onEnter: () => {},
                    disableAutoScroll: true,
                  })}
                  onClick={() => {}}
                  style={{
                    cursor: 'pointer',
                    borderRadius: 25,
                    outline: 'none',
                  }}
                >
                  <View style={[styles.circleBtn, isTv && { width: 38, height: 38 }]}>
                    <View style={styles.iconWrap}><Share2 size={isTv ? 16 : 22} color="white" /></View>
                  </View>
                </div>
              </View>

              {/* Synopsis */}
              <View style={[styles.synopsisBlock, layout.isCompact && styles.synopsisBlockCompact, isTv && { maxWidth: 500 }]}>
                <Text style={[styles.sectionLabel, isTv && { fontSize: 11, marginBottom: 8 }]}>Sinopse</Text>
                {tmdbLoading ? (
                  <View style={styles.loaderRow}>
                    <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}>
                      <Loader2 color="#E50914" size={isTv ? 16 : 22} />
                    </motion.div>
                    <Text style={[styles.loaderText, isTv && { fontSize: 12 }]}>Buscando informações...</Text>
                  </View>
                ) : (
                  <Text style={[
                    styles.synopsisText,
                    isTv && { fontSize: 13, lineHeight: 20 },
                  ]} numberOfLines={isTv ? 4 : undefined}>
                    {displayData.description || 'Nenhuma sinopse disponível para este título.'}
                  </Text>
                )}
              </View>
            </motion.div>
          </View>
        </View>

        {/* Seasons & Episodes */}
        {media.seasons && media.seasons.length > 0 && selectedSeason !== null && (
          <View style={styles.seasonsContainer}>
             <View style={styles.seasonTabs}>
               <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                 {media.seasons.map(season => (
                   <div
                     key={season.seasonNumber}
                     role="button"
                     tabIndex={0}
                     data-nav-id={`details-season-${season.seasonNumber}`}
                     ref={(el) => el && registerNode(`details-season-${season.seasonNumber}`, el, 'modal-seasons', {
                       onFocus: () => {},
                       onEnter: () => setSelectedSeason(season.seasonNumber),
                       disableAutoScroll: true,
                     })}
                     onClick={() => setSelectedSeason(season.seasonNumber)}
                     style={{
                       cursor: 'pointer',
                       outline: 'none',
                     }}
                   >
                     <View style={[
                       styles.seasonTab,
                       selectedSeason === season.seasonNumber && styles.seasonTabActive,
                     ]}>
                       <Text style={[
                         styles.seasonTabText,
                         selectedSeason === season.seasonNumber && styles.seasonTabTextActive
                       ]}>
                         Temporada {season.seasonNumber}
                       </Text>
                     </View>
                   </div>
                 ))}
               </ScrollView>
             </View>
             
             <View style={styles.episodesGrid}>
               {media.seasons.find(s => s.seasonNumber === selectedSeason)?.episodes.map((ep, idx) => {
                 const currentPos = watchHistory[ep.videoUrl];
                 const isStarted = currentPos && currentPos > 10;

                 return (
                 <div
                   key={ep.id}
                   role="button"
                   tabIndex={0}
                   data-nav-id={`details-episode-${ep.id}`}
                   ref={(el) => el && registerNode(`details-episode-${ep.id}`, el, 'modal-episodes', {
                     onFocus: () => {},
                     disableAutoScroll: true,
                     onEnter: () => onPlay({ 
                       ...media,
                       videoUrl: ep.videoUrl,
                       title: `${media.title} - ${ep.title}`,
                       currentEpisode: ep,
                       currentSeasonNumber: selectedSeason,
                     }),
                   })}
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
                       <View style={[styles.episodeIndex, isStarted && { opacity: 0.5 }]}>
                         <Text style={styles.episodeIndexText}>{idx + 1}</Text>
                       </View>
                       <View style={styles.episodeInfo}>
                         <Text style={[styles.episodeTitle, isStarted && { color: '#E50914' }]}>{ep.title}</Text>
                         <Text style={styles.episodeSubtitle}>
                           Episódio {ep.episodeNumber} {isStarted ? `• Em andamento (${Math.floor(currentPos / 60)}m)` : ''}
                         </Text>
                       </View>
                       <View style={styles.episodePlayIcon}>
                         <Play size={20} color="white" />
                       </View>
                     </View>
                   </View>
                 </div>
                 );
               })}
             </View>
          </View>
        )}

        {/* Related Content */}
        {relatedCategory && relatedCategory.items.length > 0 && (
          <View style={styles.relatedSection}>
            <CategoryRow 
              category={relatedCategory}
              rowIndex={999}
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
    letterSpacing: -2,
    fontFamily: 'Outfit',
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
  },
  mainRow: {
    flexDirection: 'row',
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
    marginRight: 16,
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
    marginRight: 12,
  },
  favoriteBtn: {
    minHeight: 50,
    paddingHorizontal: 18,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
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
    marginRight: 12,
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
    marginTop: 60,
    marginBottom: 20,
  } as any,
  seasonsContainer: {
    marginTop: 50,
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
