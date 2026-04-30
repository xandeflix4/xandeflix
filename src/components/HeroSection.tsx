import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { AnimatePresence, motion } from 'motion/react';
import { Calendar, Info, Play, Star } from 'lucide-react';
import { Media } from '../types';
import { useTMDB } from '../hooks/useTMDB';
import { useEmbeddableTrailerKey } from '../hooks/useEmbeddableTrailerKey';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import type { TMDBData } from '../lib/tmdb';
import { useTvNavigation } from '../hooks/useTvNavigation';

interface HeroSectionProps {
  media: Media | null;
  onPlay: (media: Media) => void;
  isAutoRotating: boolean;
  onFocus: (id: string) => void;
  onInfo?: (media: Media) => void;
  onPrev?: () => void;
  onNext?: () => void;
  paginationIndex?: number | null;
  paginationTotal?: number;
  canPaginate?: boolean;
  preloadedTMDBData?: TMDBData | null;
  usePreloadedTMDBOnly?: boolean;
  isVisibleInList?: boolean;
  onTrailerError?: (media: Media) => void;
}

const truncateWordsWithEllipsis = (value: string, maxWords: number): string => {
  const normalized = String(value || '').replace(/\n/g, ' ').trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  const words = normalized.split(' ');
  if (words.length <= maxWords) return normalized;
  return `${words.slice(0, maxWords).join(' ')}...`;
};

export const HeroSection: React.FC<HeroSectionProps> = React.memo(({
  media,
  onPlay,
  isAutoRotating,
  onFocus,
  onInfo,
  onPrev,
  onNext,
  paginationIndex = null,
  paginationTotal = 0,
  canPaginate = false,
  preloadedTMDBData = null,
  usePreloadedTMDBOnly = false,
  isVisibleInList = true,
  onTrailerError,
}) => {
  const { registerNode, focusedId } = useTvNavigation({ isActive: false, subscribeFocused: true });
  const playBtnRef = useRef<HTMLDivElement | null>(null);
  const infoBtnRef = useRef<HTMLDivElement | null>(null);
  const heroViewportRef = useRef<HTMLDivElement | null>(null);
  const trailerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const [isHeroInViewport, setIsHeroInViewport] = useState(true);
  const [showTrailer, setShowTrailer] = useState(false);
  const [trailerStatus, setTrailerStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [stableBackgroundUri, setStableBackgroundUri] = useState('');
  const [failedBackgroundUris, setFailedBackgroundUris] = useState<Record<string, true>>({});

  const layout = useResponsiveLayout();
  const isTvProfile = layout.isTvProfile;

  const shouldRenderSideMenu = (!layout.isMobile || layout.isTvProfile);
  const isLiveChannel = media?.type === 'live' || (media as any)?.type === 'channel' || (media as any)?.isLive;
  const shouldFetchOnDemandTMDB = Boolean(media) && !isLiveChannel && !preloadedTMDBData && !usePreloadedTMDBOnly;

  const { data: tmdbData } = useTMDB(
    shouldFetchOnDemandTMDB ? media?.title : undefined,
    shouldFetchOnDemandTMDB ? media?.type : undefined,
    { categoryHint: media?.category },
  );

  const resolvedTMDBData = preloadedTMDBData || tmdbData;
  const rawTrailerKey = resolvedTMDBData?.trailerKey || null;
  const { trailerKey: embeddableTrailerKey } = useEmbeddableTrailerKey(rawTrailerKey, {
    timeoutMs: 4200,
  });

  const displayData = useMemo(() => {
    if (!media) return null;

    const tmdbDesc = resolvedTMDBData?.description;
    const tmdbYear = resolvedTMDBData?.year;
    const tmdbRating = resolvedTMDBData?.rating;
    const tmdbBackdrop = resolvedTMDBData?.backdrop;
    const tmdbThumbnail = resolvedTMDBData?.thumbnail;
    const tmdbMatchedTitle = String(resolvedTMDBData?.matchedTitle || '').trim();
    const mediaTitle = String(media.title || '').trim();
    // Prioriza o título limpo do banco de dados (TMDB) para ocultar dados inúteis como 'S01E07'
    const finalTitle = tmdbMatchedTitle || mediaTitle || 'Titulo indisponivel';

    let finalBackdrop = tmdbBackdrop || media.backdrop || '';
    const currentThumbnail = tmdbThumbnail || media.thumbnail || '';
    if (finalBackdrop && currentThumbnail && finalBackdrop === currentThumbnail) {
      finalBackdrop = '';
    }

    return {
      ...media,
      title: finalTitle,
      description: tmdbDesc || media.description,
      year: tmdbYear || media.year,
      rating: tmdbRating || media.rating,
      backdrop: finalBackdrop,
      thumbnail: currentThumbnail,
      trailerKey: rawTrailerKey,
    };
  }, [media, rawTrailerKey, resolvedTMDBData]);

  const backgroundCandidates = useMemo(() => {
    const candidates = [displayData?.backdrop, displayData?.thumbnail, media?.backdrop, media?.thumbnail]
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0);
    return Array.from(new Set(candidates));
  }, [displayData?.backdrop, displayData?.thumbnail, media?.backdrop, media?.thumbnail]);

  useEffect(() => {
    setFailedBackgroundUris({});
  }, [displayData?.id, displayData?.title]);

  const preferredBackgroundUri = useMemo(
    () => backgroundCandidates.find((uri) => !failedBackgroundUris[uri]) || '',
    [backgroundCandidates, failedBackgroundUris],
  );

  useEffect(() => {
    if (!preferredBackgroundUri) return;
    if (stableBackgroundUri === preferredBackgroundUri) return;

    let cancelled = false;
    const image = new Image();
    image.onload = () => !cancelled && setStableBackgroundUri(preferredBackgroundUri);
    image.onerror = () => !cancelled && setFailedBackgroundUris((prev) => ({ ...prev, [preferredBackgroundUri]: true }));
    image.src = preferredBackgroundUri;

    return () => {
      cancelled = true;
    };
  }, [preferredBackgroundUri, stableBackgroundUri]);

  useEffect(() => {
    setShowTrailer(false);
    setTrailerStatus('idle');

    if (!embeddableTrailerKey || !isVisibleInList || !isHeroInViewport || !isAutoRotating) {
      return;
    }

    const timer = window.setTimeout(() => {
      setTrailerStatus('loading');
      setShowTrailer(true);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [displayData?.id, embeddableTrailerKey, isVisibleInList, isHeroInViewport, isAutoRotating]);

  useEffect(() => {
    if (trailerStatus === 'failed' && onTrailerError && media) {
      onTrailerError(media);
    }
  }, [trailerStatus, onTrailerError, media]);

  useEffect(() => {
    if (!embeddableTrailerKey) {
      setIsHeroInViewport(true);
      return;
    }

    const target = heroViewportRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          setIsHeroInViewport(entry.isIntersecting && entry.intersectionRatio >= 0.35);
        }
      },
      { threshold: [0, 0.2, 0.35, 0.6, 1] },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [displayData?.id, embeddableTrailerKey]);

  useEffect(() => {
    if (!displayData) return;
    const canPlayNow = Boolean(String(displayData.videoUrl || '').trim());

    const cleanups = [
      registerNode('hero-play', playBtnRef.current, 'hero', {
        onFocus: () => onFocus('hero-play'),
        onEnter: () => {
          if (canPlayNow) {
            onPlay(displayData);
            return;
          }
          onInfo?.(displayData);
        },
        disableAutoScroll: true,
      }),
      registerNode('hero-info', infoBtnRef.current, 'hero', {
        onFocus: () => onFocus('hero-info'),
        onEnter: () => onInfo?.(displayData),
        disableAutoScroll: true,
      }),
    ];

    return () => cleanups.forEach((cleanup) => cleanup?.());
  }, [displayData, onFocus, onInfo, onPlay, registerNode]);

  if (!displayData) return null;
  const canPlayNow = Boolean(String(displayData.videoUrl || '').trim());

  const backgroundUri = stableBackgroundUri || preferredBackgroundUri || '';
  const shouldPlayTrailer =
    Boolean(embeddableTrailerKey)
    && isHeroInViewport
    && isVisibleInList
    && isAutoRotating
    && showTrailer;

  const trailerOrigin = typeof window !== 'undefined' ? `&origin=${encodeURIComponent(window.location.origin)}` : '';
  const trailerUrl = shouldPlayTrailer
    ? `https://www.youtube.com/embed/${embeddableTrailerKey}?autoplay=1&mute=0&controls=0&modestbranding=1&loop=1&playlist=${embeddableTrailerKey}&playsinline=1&rel=0&iv_load_policy=3&fs=0&enablejsapi=1${trailerOrigin}`
    : '';
  const trailerReady = shouldPlayTrailer && trailerStatus === 'ready';

  const viewportWidth = Math.max(layout.contentMaxWidth || layout.width, layout.width);
  const baseHeroHeight = Math.round(
    Math.min(layout.heroHeightMax, Math.max(layout.heroMinHeight, viewportWidth * layout.heroHeightRatio)),
  );
  const heroHeight = isTvProfile
    ? Math.max(420, Math.min(baseHeroHeight, Math.round(layout.height * 0.92)))
    : baseHeroHeight;
  const isCompactHero = heroHeight <= 360;

  const contentWidth = isTvProfile ? '32%' : Math.min(760, viewportWidth * 0.68);

  const sideMenuOffset = shouldRenderSideMenu ? layout.sideRailCollapsedWidth : 0;
  const horizontalPadding = isTvProfile ? (isCompactHero ? 34 : 52) : 26;
  const bottomPadding = isTvProfile ? (isCompactHero ? 18 : 24) : 24;
  const titleSize = isTvProfile
    ? (isCompactHero ? 16 : Math.max(18, Math.min(22, Math.round(viewportWidth * 0.014))))
    : Math.max(20, Math.min(36, Math.round(viewportWidth * 0.032)));
  const metaSize = isTvProfile ? (isCompactHero ? 9 : 10) : 14;
  const synopsisSize = isTvProfile ? (isCompactHero ? 10 : 11) : 14;
  const synopsisLineHeight = isTvProfile ? (isCompactHero ? '14px' : '16px') : '21px';
  const buttonFontSize = isTvProfile ? (isCompactHero ? 11 : 12) : 14;
  const buttonVerticalPadding = isTvProfile ? (isCompactHero ? 5 : 6) : 10;
  const buttonHorizontalPadding = isTvProfile ? (isCompactHero ? 12 : 14) : 16;

  const synopsis = truncateWordsWithEllipsis(displayData.description || '', isTvProfile ? 16 : 30)
    || 'Sinopse nao disponivel para este conteudo.';

  const showPaginationDots = canPaginate && paginationTotal > 1 && paginationIndex != null;
  const normalizedPaginationIndex =
    paginationIndex == null || paginationIndex < 0
      ? 0
      : Math.min(paginationTotal - 1, paginationIndex);
  const dotWindow = 9;
  const dotStart = Math.max(0, normalizedPaginationIndex - Math.floor(dotWindow / 2));
  const dotEnd = Math.min(paginationTotal, dotStart + dotWindow);
  const visibleDotIndices = Array.from({ length: Math.max(0, dotEnd - dotStart) }, (_, idx) => dotStart + idx);

  const handleTouchStart = (event: any) => {
    if (!canPaginate) return;
    const touch = event?.nativeEvent?.touches?.[0] || event?.nativeEvent?.changedTouches?.[0];
    if (!touch) return;
    touchStartRef.current = { x: Number(touch.pageX || 0), y: Number(touch.pageY || 0) };
  };

  const handleTouchEnd = (event: any) => {
    if (!canPaginate || !touchStartRef.current) return;
    const touch = event?.nativeEvent?.changedTouches?.[0] || event?.nativeEvent?.touches?.[0];
    if (!touch) {
      touchStartRef.current = null;
      return;
    }

    const start = touchStartRef.current;
    touchStartRef.current = null;

    const deltaX = Number(touch.pageX || 0) - start.x;
    const deltaY = Number(touch.pageY || 0) - start.y;
    const minSwipeDistance = 44;
    const maxVerticalDrift = 42;

    if (Math.abs(deltaX) < minSwipeDistance || Math.abs(deltaY) > maxVerticalDrift) return;
    if (deltaX < 0) {
      onNext?.();
    } else {
      onPrev?.();
    }
  };

  return (
    <View
      onTouchStart={handleTouchStart as any}
      onTouchEnd={handleTouchEnd as any}
      style={{
        width: (sideMenuOffset > 0 ? `calc(100% - ${sideMenuOffset}px)` : '100%') as any,
        marginLeft: sideMenuOffset,
        height: heroHeight,
        minHeight: heroHeight,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#050505',
      }}
    >
      <div ref={heroViewportRef} style={{ position: 'absolute', inset: 0, zIndex: -1 }} />

      <div className="absolute inset-0 z-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${displayData.id || 'hero'}-${backgroundUri || 'no-image'}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.65 }}
            className="absolute inset-0"
          >
            {backgroundUri ? (
              <img
                src={backgroundUri}
                alt={displayData.title}
                className="absolute inset-0"
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'center top',
                  opacity: trailerReady ? 0.08 : 1,
                  transition: 'opacity 760ms ease',
                }}
              />
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'linear-gradient(135deg, #1f2937 0%, #0f172a 100%)',
                }}
              />
            )}
 
            {shouldPlayTrailer && trailerStatus !== 'failed' && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  right: 0,
                  width: '100%',
                  zIndex: 5,
                  overflow: 'hidden',
                  isolation: 'isolate',
                }}
              >
                <iframe
                  ref={trailerIframeRef}
                  src={trailerUrl}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen={false}
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    pointerEvents: 'none',
                    opacity: trailerReady ? 1 : 0,
                    transition: 'opacity 760ms ease',
                    transform: layout.isTvProfile ? 'scale(1.08)' : 'scale(1.04)',
                    transformOrigin: 'left center',
                  }}
                  onLoad={() => setTrailerStatus('ready')}
                  onError={() => setTrailerStatus('failed')}
                  title={`Trailer de ${displayData.title}`}
                />
                <div
                  aria-hidden
                  style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    opacity: trailerReady ? 1 : 0,
                    transition: 'opacity 760ms ease',
                    background: 'linear-gradient(to right, rgba(5,5,5,0.96) 0%, rgba(5,5,5,0.72) 16%, rgba(5,5,5,0.22) 36%, transparent 52%)',
                  }}
                />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
 
      <div className="absolute inset-0 z-10 pointer-events-none">
        {/* Gradiente Vertical (Bottom-up) */}
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to top, #050505 0%, rgba(5,5,5,0.95) 8%, rgba(5,5,5,0.6) 22%, rgba(5,5,5,0.08) 42%, transparent 100%)'
        }} />
        {/* Gradiente Horizontal (Left-to-right) intenso para garantir fundo escuro para o texto */}
        <div style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: '65%',
          background: 'linear-gradient(to right, #050505 0%, rgba(5,5,5,0.98) 25%, rgba(5,5,5,0.6) 55%, transparent 100%)'
        }} />
      </div>

      <div
        key={`hero-content-${displayData.id}`}
        style={{
          position: 'relative',
          zIndex: 20,
          height: '100%',
          width: '100%',
          display: 'flex',
          alignItems: 'flex-end',
          pointerEvents: 'none',
        }}
      >
        <div
          className="hero-content"
          style={{
            pointerEvents: 'auto',
            width: contentWidth,
            maxWidth: '92vw',
            paddingLeft: horizontalPadding,
            paddingRight: 16,
            paddingBottom: bottomPadding,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <h1
            style={{
              margin: 0,
              color: '#fff',
              fontSize: titleSize,
              fontWeight: 900,
              lineHeight: 1.02,
              letterSpacing: -1.1,
              textShadow: '0 8px 18px rgba(0,0,0,0.46)',
            }}
          >
            {displayData.title}
          </h1>

          <div
            style={{
              marginTop: isCompactHero ? 14 : 20, // Aumentado o espaçamento entre o título e os metadados
              display: 'flex',
              alignItems: 'center',
              gap: isCompactHero ? 12 : 16, // Aumentado o espaçamento entre os itens de metadados
              flexWrap: 'wrap',
            }}
          >
            {!!displayData.rating && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderRadius: 8, padding: '3px 8px', background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.14)' }}>
                <Star size={metaSize} color="#facc15" fill="#facc15" />
                <span style={{ color: '#fff', fontWeight: 900, fontSize: metaSize }}>{displayData.rating}</span>
              </div>
            )}
            {!!displayData.year && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'rgba(255,255,255,0.86)', fontWeight: 800, fontSize: metaSize }}>
                <Calendar size={metaSize} />
                {displayData.year}
              </div>
            )}
            <div style={{ borderRadius: 7, padding: '3px 8px', background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <span style={{ color: '#fff', fontSize: Math.max(10, metaSize - 2), fontWeight: 900, letterSpacing: 0.7, textTransform: 'uppercase' }}>
                {String(displayData.category || displayData.type || 'Filme')}
              </span>
            </div>
            {!canPlayNow && (
              <div style={{ borderRadius: 7, padding: '3px 8px', background: 'rgba(245,158,11,0.2)', border: '1px solid rgba(245,158,11,0.5)' }}>
                <span style={{ color: '#fbbf24', fontSize: Math.max(10, metaSize - 2), fontWeight: 900, letterSpacing: 0.7, textTransform: 'uppercase' }}>
                  Em breve
                </span>
              </div>
            )}
          </div>

          <p
            className="hero-synopsis"
            style={{
              margin: `${isCompactHero ? 16 : 22}px 0 0 0`, // Aumentado o espaçamento entre metadados e a sinopse
              color: 'rgba(255,255,255,0.9)',
              fontSize: synopsisSize,
              lineHeight: synopsisLineHeight,
              maxWidth: '100%', // Respeita a largura do contentWidth (30%)
              textShadow: '0 4px 14px rgba(0,0,0,0.56)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box' as any,
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            } as React.CSSProperties}
          >
            {synopsis}
          </p>

          {showPaginationDots && (
            <div
              aria-hidden
              style={{
                marginTop: isCompactHero ? 10 : 12,
                display: 'flex',
                alignItems: 'center',
                gap: isCompactHero ? 6 : 8,
                minHeight: 14,
              }}
            >
              {visibleDotIndices.map((dotIndex) => {
                const isActive = dotIndex === normalizedPaginationIndex;
                return (
                  <span
                    key={`hero-dot-${dotIndex}`}
                    style={{
                      width: isActive ? 16 : 7,
                      height: 7,
                      borderRadius: 999,
                      backgroundColor: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.34)',
                      transition: 'all 160ms ease',
                    }}
                  />
                );
              })}
            </div>
          )}

          <div style={{ marginTop: isCompactHero ? 10 : 12, display: 'flex', alignItems: 'center', gap: isCompactHero ? 8 : 10, flexWrap: 'wrap' }}>
            <div
              ref={playBtnRef}
              role="button"
              tabIndex={0}
              data-nav-id="hero-play"
              onClick={() => {
                if (canPlayNow) {
                  onPlay(displayData);
                  return;
                }
                onInfo?.(displayData);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderRadius: 10,
                border: canPlayNow ? '1px solid rgba(255,255,255,0.34)' : '1px solid rgba(255,255,255,0.24)',
                backgroundColor: canPlayNow
                  ? (focusedId === 'hero-play' ? '#fff' : 'rgba(255,255,255,0.92)')
                  : (focusedId === 'hero-play' ? 'rgba(255,255,255,0.34)' : 'rgba(17,24,39,0.52)'),
                color: canPlayNow ? '#111827' : '#fff',
                fontSize: buttonFontSize,
                fontWeight: 900,
                padding: `${buttonVerticalPadding}px ${buttonHorizontalPadding}px`,
                cursor: 'pointer',
                minWidth: isTvProfile ? (isCompactHero ? 120 : 130) : 170, // Reduzido
                justifyContent: 'center',
                transform: focusedId === 'hero-play' ? 'scale(1.04)' : 'scale(1)',
                transition: 'transform 150ms ease, background-color 150ms ease',
              }}
            >
              <Play size={isCompactHero ? 15 : 17} color={canPlayNow ? '#111827' : '#fff'} fill={canPlayNow ? '#111827' : '#fff'} />
              {canPlayNow ? 'Assistir Agora' : 'Ver Detalhes'}
            </div>

            <div
              ref={infoBtnRef}
              role="button"
              tabIndex={0}
              data-nav-id="hero-info"
              onClick={() => onInfo?.(displayData)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.24)',
                backgroundColor: focusedId === 'hero-info' ? 'rgba(255,255,255,0.34)' : 'rgba(17,24,39,0.52)',
                color: '#fff',
                fontSize: buttonFontSize,
                fontWeight: 900,
                padding: `${buttonVerticalPadding}px ${buttonHorizontalPadding}px`,
                cursor: 'pointer',
                minWidth: isTvProfile ? (isCompactHero ? 110 : 120) : 150, // Reduzido
                justifyContent: 'center',
                transform: focusedId === 'hero-info' ? 'scale(1.04)' : 'scale(1)',
                transition: 'transform 150ms ease, background-color 150ms ease',
              }}
            >
              <Info size={isCompactHero ? 15 : 17} color="#fff" />
              Detalhes
            </div>
          </div>
        </div>
      </div>
    </View>
  );
});
