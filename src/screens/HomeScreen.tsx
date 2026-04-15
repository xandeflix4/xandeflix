import React, { useState, useEffect, useRef, useMemo, Suspense, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableHighlight,
  TextInput,
  Platform,
} from 'react-native';
import { useStore } from '../store/useStore';
import { motion, AnimatePresence } from 'motion/react';
import { Search, RotateCcw, LogOut, ChevronRight, LayoutGrid, X, Star } from 'lucide-react';
import { Media, Category } from '../types';
import { useVirtualizer } from '@tanstack/react-virtual';

// Custom Hooks
import { usePlaylist } from '../hooks/usePlaylist';
import { useMediaFilter } from '../hooks/useMediaFilter';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { fetchTMDBMetadata, isTMDBConfigured, type TMDBData } from '../lib/tmdb';
import { detectTvEnvironment } from '../lib/deviceProfile';

// Components
import { SideMenu } from '../components/SideMenu';
import { HeroSection } from '../components/HeroSection';
import { CategoryRow } from '../components/CategoryRow';
import { SettingsModal } from '../components/SettingsModal';
import { LoadingScreen } from '../components/LoadingScreen';
import { VideoPlayer, VideoPlayerHandle } from '../components/VideoPlayer';

// Lazy Components
const LiveTVGrid = React.lazy(() => import('../components/LiveTVGrid').then(m => ({ default: m.LiveTVGrid })));
const MediaDetailsPage = React.lazy(() => import('../components/MediaDetailsModal').then(m => ({ default: m.MediaDetailsPage })));
const CategoryGridView = React.lazy(() => import('../components/CategoryGridView').then(m => ({ default: m.CategoryGridView })));
const SIDEMENU_COLLAPSED_WIDTH = 80;
const SIDEMENU_EXPANDED_WIDTH = 280;
const SIDEMENU_PUSH_OFFSET = SIDEMENU_EXPANDED_WIDTH - SIDEMENU_COLLAPSED_WIDTH;

const CategoryRowSkeleton = ({ layout }: { layout: any }) => (
  <View style={{ marginBottom: layout.isCompact ? 30 : 44 }}>
    <View style={{ height: 32, width: 200, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 4, marginBottom: 20 }} />
    <View style={{ flexDirection: 'row', gap: 16 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <View key={i} style={{ width: 220, height: 330, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 12 }} />
      ))}
    </View>
  </View>
);
const HERO_TMDB_PRELOAD_LIMIT = 6;

const getHeroMediaKey = (media: Media | null | undefined): string => {
  if (!media) return '';
  return media.id;
};

const normalizeTMDBType = (type: string | undefined): 'movie' | 'series' | null => {
  const normalized = String(type || '').toLowerCase();
  if (normalized === 'movie') return 'movie';
  if (normalized === 'series') return 'series';
  return null;
};

const _isTvBoot = detectTvEnvironment();
const HOME_ARTWORK_PREFETCH_ITEM_LIMIT = _isTvBoot ? 12 : 60;
const HOME_ARTWORK_DIRECT_IMAGE_LIMIT = _isTvBoot ? 16 : 90;
const HOME_ARTWORK_PREFETCH_CONCURRENCY = _isTvBoot ? 2 : 6;
const HOME_ARTWORK_PREFETCH_TIMEOUT_MS = _isTvBoot ? 5000 : 18000;
const HOME_ARTWORK_CRITICAL_CATEGORY_LIMIT = _isTvBoot ? 2 : 4;
const HOME_ARTWORK_CRITICAL_ITEMS_PER_CATEGORY = _isTvBoot ? 4 : 8;

const isLikelyPlaceholderArtwork = (url: string): boolean => {
  const normalized = String(url || '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized.includes('picsum.photos') || normalized.includes('placeholder');
};

const hasUsefulArtworkUrl = (url: string | null | undefined): boolean => {
  const normalized = String(url || '').trim();
  return Boolean(normalized) && !isLikelyPlaceholderArtwork(normalized);
};

const hasDistinctBackdrop = (item: Media): boolean => {
  const backdrop = String(item.backdrop || '').trim();
  const thumbnail = String(item.thumbnail || '').trim();
  return backdrop.length > 0 && backdrop !== thumbnail;
};

const getTMDBRankingScore = (metadata: TMDBData | null | undefined): number | null => {
  if (!metadata) return null;

  const voteAverageRaw =
    Number.isFinite(metadata.voteAverage as number)
      ? Number(metadata.voteAverage)
      : Number.parseFloat(String(metadata.rating || '0'));

  const voteAverage = Number.isFinite(voteAverageRaw) ? voteAverageRaw : 0;
  if (voteAverage <= 0) return null;

  const voteCount = Math.max(0, Number(metadata.voteCount || 0));
  const popularity = Math.max(0, Number(metadata.popularity || 0));
  const confidence = Math.min(1, Math.log10(voteCount + 1) / 3);
  const popularityBoost = Math.min(1.2, Math.log10(popularity + 1) * 0.35);
  const matchScore = typeof metadata.matchScore === 'number' ? metadata.matchScore : 0.8;

  return (voteAverage * (0.7 + confidence * 0.3)) + popularityBoost + (matchScore * 0.25);
};

const preloadImageUrl = async (url: string): Promise<void> => {
  const safeUrl = String(url || '').trim();
  if (!safeUrl || typeof window === 'undefined' || typeof Image === 'undefined') return;

  await new Promise<void>((resolve) => {
    const image = new Image();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timeoutId = window.setTimeout(finish, 1700);
    image.onload = () => {
      window.clearTimeout(timeoutId);
      finish();
    };
    image.onerror = () => {
      window.clearTimeout(timeoutId);
      finish();
    };
    image.src = safeUrl;
  });
};

interface RowsVirtualListProps {
  categories: Category[];
  cardPreloadedTMDB: Record<string, TMDBData>;
  cardTMDBMissedByKey: Record<string, true>;
  handleCategoryMediaFocus: (media: Media, id: string) => void;
  handleMediaPress: (media: Media) => void;
  setGridCategory: (cat: Category) => void;
  heroMedia: Media | null;
  heroPreloadedTMDB: TMDBData | null;
  isHeroAutoRotating: boolean;
  layout: any;
  handleHeroFocus: (id: string) => void;
  setIsDetailsVisible: (visible: boolean) => void;
  setDetailsMedia: (media: Media | null) => void;
  isHeroVisibleInList: boolean;
  handlePlay: (media: Media) => void;
  scrollRef: React.RefObject<HTMLDivElement>;
}

const RowsVirtualList = React.memo(({
  categories,
  cardPreloadedTMDB,
  cardTMDBMissedByKey,
  handleCategoryMediaFocus,
  handleMediaPress,
  setGridCategory,
  heroMedia,
  heroPreloadedTMDB,
  isHeroAutoRotating,
  layout,
  handleHeroFocus,
  setIsDetailsVisible,
  setDetailsMedia,
  isHeroVisibleInList,
  handlePlay,
  scrollRef,
}: RowsVirtualListProps) => {
  const viewportWidth = Math.max(layout.contentMaxWidth || layout.width, layout.width);
  const baseHeroEstimatedHeight = Math.round(
    Math.min(
      layout.heroHeightMax,
      Math.max(layout.heroMinHeight, viewportWidth * layout.heroHeightRatio),
    ),
  );
  const heroEstimatedHeight = layout.isTvProfile
    ? Math.max(280, Math.min(baseHeroEstimatedHeight, Math.round(layout.height * 0.58)))
    : baseHeroEstimatedHeight;
  const rowEstimatedHeight = layout.isTvProfile ? 220 : 360;

  if (layout.isTvProfile) {
    return (
      <div style={{ width: '100%' }}>
        <HeroSection
          media={heroMedia}
          onPlay={handlePlay}
          isAutoRotating={isHeroAutoRotating}
          onFocus={handleHeroFocus}
          preloadedTMDBData={heroPreloadedTMDB}
          usePreloadedTMDBOnly={false}
          isVisibleInList={isHeroVisibleInList}
          onInfo={(m) => {
            setDetailsMedia(m);
            setIsDetailsVisible(true);
          }}
        />

        {categories.map((category, index) => (
          <CategoryRow
            key={category.id}
            category={category}
            rowIndex={index}
            preloadedTMDBByKey={cardPreloadedTMDB}
            tmdbMissedByKey={cardTMDBMissedByKey}
            onMediaFocus={handleCategoryMediaFocus}
            onMediaPress={handleMediaPress}
            onSeeAll={setGridCategory}
          />
        ))}
      </div>
    );
  }

  const rowVirtualizer = useVirtualizer({
    count: categories.length + 1, // +1 for Hero
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      if (index === 0) return heroEstimatedHeight;
      return rowEstimatedHeight;
    },
    overscan: 10,
  });

  return (
    <div
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const isHero = virtualRow.index === 0;
        
        if (isHero) {
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <HeroSection 
                media={heroMedia} 
                onPlay={handlePlay}
                isAutoRotating={isHeroAutoRotating}
                onFocus={handleHeroFocus}
                preloadedTMDBData={heroPreloadedTMDB}
                usePreloadedTMDBOnly={false}
                isVisibleInList={isHeroVisibleInList}
                onInfo={(m) => {
                  setDetailsMedia(m);
                  setIsDetailsVisible(true);
                }}
              />
            </div>
          );
        }

        const category = categories[virtualRow.index - 1];
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <CategoryRow
              key={category.id}
              category={category}
              rowIndex={virtualRow.index - 1}
              preloadedTMDBByKey={cardPreloadedTMDB}
              tmdbMissedByKey={cardTMDBMissedByKey}
              onMediaFocus={handleCategoryMediaFocus}
              onMediaPress={handleMediaPress}
              onSeeAll={setGridCategory}
            />
          </div>
        );
      })}
    </div>
  );
});

const runWithConcurrency = async <T,>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  if (items.length === 0) return;
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const workers = Array.from({ length: poolSize }, async () => {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      await worker(items[currentIndex]);
    }
  });

  await Promise.all(workers);
};

const pickRandomHeroMedia = (candidates: Media[], previous: Media | null): Media | null => {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const previousKey = getHeroMediaKey(previous);
  let selected = candidates[Math.floor(Math.random() * candidates.length)];
  let attempts = 0;

  while (getHeroMediaKey(selected) === previousKey && attempts < 10) {
    selected = candidates[Math.floor(Math.random() * candidates.length)];
    attempts += 1;
  }

  return selected;
};

const HomeScreen: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  // Global Store State
  const activeFilter = useStore((state) => state.activeFilter);
  const searchQuery = useStore((state) => state.searchQuery);
  const isSettingsVisible = useStore((state) => state.isSettingsVisible);
  const setIsSettingsVisible = useStore((state) => state.setIsSettingsVisible);
  const hiddenCategoryIds = useStore((state) => state.hiddenCategoryIds);
  const setActiveFilter = useStore((state) => state.setActiveFilter);
  const isTvMode = useStore((state) => state.isTvMode);
  const playerMode = useStore((state) => state.playerMode);
  const setPlayerMode = useStore((state) => state.setPlayerMode);
  const favorites = useStore((state) => state.favorites);
  const lastPlaylistUrl = useStore((state) => state.lastPlaylistUrl);
  const fetchPlaylistAction = useStore((state) => state.fetchPlaylist);

  // Local UI State
  const [activeVideoUrl, setActiveVideoUrl] = useState<string | null>(null);
  const [videoType, setVideoType] = useState<'live' | 'movie' | 'series' | null>(null);
  const [playingMedia, setPlayingMedia] = useState<Media | null>(null);
  const [isAutoRotating, setIsAutoRotating] = useState(true);
  const [detailsMedia, setDetailsMedia] = useState<Media | null>(null);
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);
  const [gridCategory, setGridCategory] = useState<Category | null>(null);
  const [heroMedia, setHeroMedia] = useState<Media | null>(null);
  const [isHeroVisibleInList, setIsHeroVisibleInList] = useState(true);
  const [isSideMenuExpanded, setIsSideMenuExpanded] = useState(false);
  const [heroPreloadedTMDB, setHeroPreloadedTMDB] = useState<Record<string, TMDBData>>({});
  const [cardPreloadedTMDB, setCardPreloadedTMDB] = useState<Record<string, TMDBData>>({});
  const [cardTMDBMissedByKey, setCardTMDBMissedByKey] = useState<Record<string, true>>({});
  const [isPreparingInitialArtwork, setIsPreparingInitialArtwork] = useState(true);
  const heroPreloadedTMDBRef = useRef<Record<string, TMDBData>>({});
  const cardPreloadScopeRef = useRef<string>('');

  // TV Navigation — active only in TV mode AND when no overlay is stealing focus
  const isHomeNavActive = isTvMode && !isDetailsVisible && !gridCategory && !isSettingsVisible && !playingMedia;
  const { setFocusedId } = useTvNavigation({ isActive: isHomeNavActive, subscribeFocused: false });

  // Global Back Handler
  useEffect(() => {
    const handleGlobalBack = (e: KeyboardEvent) => {
      const key = e.key;
      const isBack = key === 'Escape' || key === 'Back' || (e as any).keyCode === 4;
      
      if (!isBack) return;

      if (playingMedia) {
        setPlayingMedia(null);
        setActiveVideoUrl(null);
        setPlayerMode('closed');
        e.preventDefault();
        return;
      }

      if (isDetailsVisible) {
        setIsDetailsVisible(false);
        setDetailsMedia(null);
        e.preventDefault();
        return;
      }

      if (gridCategory) {
        setGridCategory(null);
        e.preventDefault();
        return;
      }

      if (isSettingsVisible) {
        setIsSettingsVisible(false);
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleGlobalBack);
    return () => window.removeEventListener('keydown', handleGlobalBack);
  }, [playingMedia, isDetailsVisible, gridCategory, isSettingsVisible, setPlayerMode, setIsSettingsVisible]);

  const {
    fetchPlaylist,
    loading,
    playlistError,
    playlistStatus,
    playlistProgress,
    playlistLogs,
    catalogPreviewCategories,
    isWritingDatabase,
  } = usePlaylist();
  const { filteredCategories } = useMediaFilter(catalogPreviewCategories);

  // Controle de foco inicial seguro contra Race Conditions
  const initialFocusSetRef = useRef(false);
  
  // A interface está pronta para foco assim que o catálogo existir; prefetch roda em background.
  const isInterfaceReadyForFocus = catalogPreviewCategories.length > 0;

  useEffect(() => {
    if (!isTvMode || !isInterfaceReadyForFocus) {
      return;
    }

    if (!initialFocusSetRef.current) {
      // Pequeno delay para garantir que o React e a FlatList comitaram os nós no DOM (paint)
      const timeoutId = setTimeout(() => {
        const activeNavId = (document.activeElement as HTMLElement | null)?.dataset?.navId;
        if (!activeNavId) {
          setFocusedId('menu-home');
        }
      }, 150);
      
      initialFocusSetRef.current = true;
      return () => clearTimeout(timeoutId);
    }
  }, [isTvMode, isInterfaceReadyForFocus, setFocusedId]);

  const layout = useResponsiveLayout();
  const { isTvProfile } = layout;
  const sideMenuCollapsedWidth = layout.sideRailCollapsedWidth || SIDEMENU_COLLAPSED_WIDTH;
  const sideMenuExpandedWidth = layout.sideRailExpandedWidth || SIDEMENU_EXPANDED_WIDTH;
  const sideMenuPushOffset = sideMenuExpandedWidth - sideMenuCollapsedWidth;
  const shouldRenderSideMenu = isTvMode || layout.isDesktop;
  const mainContentShift = shouldRenderSideMenu && isSideMenuExpanded ? sideMenuPushOffset : 0;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activePlayerRef = useRef<VideoPlayerHandle | null>(null);
  const hasRequestedInitialPlaylistRef = useRef(false);
  const wasPlayingRef = useRef(false);
  const autoRotateResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHeroRandomFilter = activeFilter === 'home' || activeFilter === 'movie' || activeFilter === 'series';

  const clearAutoRotateResumeTimer = useCallback(() => {
    if (autoRotateResumeTimerRef.current) {
      clearTimeout(autoRotateResumeTimerRef.current);
      autoRotateResumeTimerRef.current = null;
    }
  }, []);

  const scheduleHeroAutoRotateResume = useCallback((delayMs?: number) => {
    if (!isHeroRandomFilter) return;
    if (activeVideoUrl || isDetailsVisible || gridCategory || isSettingsVisible) return;

    clearAutoRotateResumeTimer();
    autoRotateResumeTimerRef.current = setTimeout(() => {
      autoRotateResumeTimerRef.current = null;
      setIsAutoRotating(true);
    }, delayMs ?? (layout.isTvProfile ? 10000 : 7000));
  }, [
    activeVideoUrl,
    clearAutoRotateResumeTimer,
    gridCategory,
    isDetailsVisible,
    isHeroRandomFilter,
    isSettingsVisible,
    layout.isTvProfile,
  ]);
  
  // Initial Data Fetch (Auto-Load Etapa 12)
  useEffect(() => {
    if (!hasRequestedInitialPlaylistRef.current) {
      if (lastPlaylistUrl && catalogPreviewCategories.length === 0) {
        console.log('[Auto-Load] Restaurando última lista:', lastPlaylistUrl);
        fetchPlaylistAction(lastPlaylistUrl);
      } else {
        fetchPlaylist();
      }
      hasRequestedInitialPlaylistRef.current = true;
    }
  }, [fetchPlaylist, fetchPlaylistAction, lastPlaylistUrl, catalogPreviewCategories.length]);

  const handleRetryPlaylist = useCallback(() => {
    void fetchPlaylist();
  }, [fetchPlaylist]);

  const totalMediaItems = useMemo(
    () => catalogPreviewCategories.reduce((sum, category) => sum + category.items.length, 0),
    [catalogPreviewCategories],
  );

  const heroCandidates = useMemo(() => {
    if (!isHeroRandomFilter) return [];

    const allowedTypes =
      activeFilter === 'movie'
        ? new Set(['movie'])
        : activeFilter === 'series'
          ? new Set(['series'])
          : new Set(['movie', 'series']);

    const seen = new Set<string>();
    return filteredCategories
      .filter((category) => {
        if (activeFilter === 'movie') return category.type === 'movie';
        if (activeFilter === 'series') return category.type === 'series';
        return category.type === 'movie' || category.type === 'series';
      })
      .flatMap((category) => category.items)
      .filter((item) => allowedTypes.has(String(item.type).toLowerCase()))
      .filter((item) => {
        const key = getHeroMediaKey(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [activeFilter, filteredCategories, isHeroRandomFilter]);

  const heroReadyCandidates = useMemo(
    () =>
      heroCandidates.filter((item) => {
        const key = getHeroMediaKey(item);
        const metadata = key ? heroPreloadedTMDB[key] : null;
        
        // REGRA DE OURO: Para o HeroBanner, a mídia PRECISA ter uma imagem panorâmica (backdrop).
        // Se entrar mídias que só têm capa (thumbnail), o sistema injeta o fallback (Unsplash),
        // frustrando o usuário. Só giramos filmes que sabidamente têm TMDB Backdrop ou backdrop local válido.
        const hasTMDBBackdrop = Boolean(metadata?.backdrop);
        const hasDistinctLocalBackdrop = Boolean(
          item.backdrop && 
          item.backdrop !== item.thumbnail && 
          item.backdrop.trim().length > 0
        );

        return hasTMDBBackdrop || hasDistinctLocalBackdrop;
      }),
    [heroCandidates, heroPreloadedTMDB],
  );

  const heroSelectionCandidates = useMemo(() => {
    if (heroReadyCandidates.length > 0) {
      return heroReadyCandidates;
    }

    // Fallback rÃ¡pido: permite rotaÃ§Ã£o inicial com backdrops locais distintos
    // enquanto o preload de metadados TMDB ainda estÃ¡ aquecendo.
    const localBackdropCandidates = heroCandidates.filter(hasDistinctBackdrop);
    if (localBackdropCandidates.length > 0) {
      return localBackdropCandidates;
    }

    // Ãšltimo fallback para evitar Hero travado sem rotaÃ§Ã£o.
    return heroCandidates;
  }, [heroCandidates, heroReadyCandidates]);
  const heroRotationCandidates = useMemo(() => heroSelectionCandidates, [heroSelectionCandidates]);

  const heroDisplayMedia = useMemo(() => {
    if (isHeroRandomFilter) {
      return heroMedia || heroSelectionCandidates[0] || null;
    }
    return filteredCategories[0]?.items[0] || null;
  }, [filteredCategories, heroMedia, heroSelectionCandidates, isHeroRandomFilter]);

  const heroDisplayTMDBData = useMemo(() => {
    const key = getHeroMediaKey(heroDisplayMedia);
    if (!key) return null;
    return heroPreloadedTMDB[key] || null;
  }, [heroDisplayMedia, heroPreloadedTMDB]);
  const liveItemsCount = useMemo(
    () =>
      catalogPreviewCategories
        .filter((category) => category.type === 'live')
        .reduce((sum, category) => sum + category.items.length, 0),
    [catalogPreviewCategories],
  );
  const movieItemsCount = useMemo(
    () =>
      catalogPreviewCategories
        .filter((category) => category.type === 'movie')
        .reduce((sum, category) => sum + category.items.length, 0),
    [catalogPreviewCategories],
  );
  const seriesItemsCount = useMemo(
    () =>
      catalogPreviewCategories
        .filter((category) => category.type === 'series')
        .reduce((sum, category) => sum + category.items.length, 0),
    [catalogPreviewCategories],
  );

  const handlePlay = useCallback((media: Media) => {
    clearAutoRotateResumeTimer();
    setPlayingMedia(media);
    setActiveVideoUrl(media.videoUrl);
    setVideoType(media.type as any);
    setIsAutoRotating(false);
    setIsDetailsVisible(false);
    setPlayerMode('fullscreen');
  }, [clearAutoRotateResumeTimer, setPlayerMode]);

  const closeActivePlayer = useCallback(() => {
    setActiveVideoUrl(null);
    setPlayingMedia(null);
    setVideoType(null);
    setPlayerMode('closed');
    scheduleHeroAutoRotateResume(layout.isTvProfile ? 9000 : 6000);
  }, [layout.isTvProfile, scheduleHeroAutoRotateResume, setPlayerMode]);

  const handleMediaPress = useCallback((media: Media) => {
    if (media.type === 'live') {
      handlePlay(media);
    } else {
      setDetailsMedia(media);
      setIsDetailsVisible(true);
    }
  }, [handlePlay]);

  const handleCategorySelect = useCallback((id: string) => {
    setActiveFilter(id);
    if (scrollRef.current) {
      const scrollAny = scrollRef.current as any;
      if (typeof scrollAny.scrollToOffset === 'function') {
        scrollAny.scrollToOffset({ offset: 0, animated: true });
      } else if (typeof scrollAny.scrollTo === 'function') {
        scrollAny.scrollTo({ top: 0, behavior: layout.isTvProfile ? 'auto' : 'smooth' });
      }
    }
  }, [setActiveFilter, layout.isTvProfile]);

  const handleHeroFocus = useCallback((_id: string) => {
    setIsAutoRotating(false);
    scheduleHeroAutoRotateResume(layout.isTvProfile ? 12000 : 9000);
    
    // Garantir que o Hero apareca inteiramente no topo ao ganhar foco
    if (layout.isTvProfile && scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [layout.isTvProfile, scheduleHeroAutoRotateResume]);

  const handleMainListScroll = useCallback(
    (event: any) => {
      const offsetY = Number(event?.nativeEvent?.contentOffset?.y ?? event?.currentTarget?.scrollTop ?? 0);
      // Lax visibility threshold for TV to prevent Hero unmounting
      const shouldKeepHeroPlaying = isTvProfile ? (offsetY <= 500) : (offsetY <= 32); 
      setIsHeroVisibleInList((prev) =>
        prev === shouldKeepHeroPlaying ? prev : shouldKeepHeroPlaying,
      );
    },
    [],
  );

  const handleCategoryMediaFocus = useCallback((_: Media, _id: string) => {
    setIsAutoRotating(false);
    scheduleHeroAutoRotateResume(layout.isTvProfile ? 10000 : 7000);
  }, [layout.isTvProfile, scheduleHeroAutoRotateResume]);

  useEffect(() => {
    heroPreloadedTMDBRef.current = heroPreloadedTMDB;
  }, [heroPreloadedTMDB]);

  useEffect(() => {
    if (catalogPreviewCategories.length === 0) {
      cardPreloadScopeRef.current = '';
      setCardPreloadedTMDB({});
      setCardTMDBMissedByKey({});
      setIsPreparingInitialArtwork(true);
      return;
    }

    const preloadScope = catalogPreviewCategories
      .slice(0, 10)
      .map((category) => `${category.id}:${category.items.length}:${category.type || ''}`)
      .join('|');

    if (cardPreloadScopeRef.current === preloadScope) {
      return;
    }

    cardPreloadScopeRef.current = preloadScope;
    setIsPreparingInitialArtwork(true);

    let cancelled = false;

    const preloadHomeArtwork = async () => {
      const mediaCandidates: Media[] = [];
      const criticalCandidates: Media[] = [];
      const seenMediaKeys = new Set<string>();
      const movieAndSeriesCategories = catalogPreviewCategories.filter(
        (category) => category.type === 'movie' || category.type === 'series',
      );

      for (const category of movieAndSeriesCategories) {
        for (const item of category.items) {
          const mediaKey = getHeroMediaKey(item);
          if (!mediaKey || seenMediaKeys.has(mediaKey)) continue;
          seenMediaKeys.add(mediaKey);
          mediaCandidates.push(item);
          if (mediaCandidates.length >= HOME_ARTWORK_PREFETCH_ITEM_LIMIT) break;
        }
        if (mediaCandidates.length >= HOME_ARTWORK_PREFETCH_ITEM_LIMIT) {
          break;
        }
      }

      const criticalSeenMediaKeys = new Set<string>();
      const criticalCategories = movieAndSeriesCategories.slice(0, HOME_ARTWORK_CRITICAL_CATEGORY_LIMIT);
      for (const category of criticalCategories) {
        let addedInCategory = 0;
        for (const item of category.items) {
          const mediaKey = getHeroMediaKey(item);
          if (!mediaKey || criticalSeenMediaKeys.has(mediaKey)) continue;
          criticalSeenMediaKeys.add(mediaKey);
          criticalCandidates.push(item);
          addedInCategory += 1;
          if (addedInCategory >= HOME_ARTWORK_CRITICAL_ITEMS_PER_CATEGORY) {
            break;
          }
        }
      }

      if (mediaCandidates.length === 0 || cancelled) {
        return;
      }

      const directImageUrls: string[] = [];
      const seenImageUrls = new Set<string>();

      for (const item of mediaCandidates) {
        for (const rawUrl of [item.thumbnail, item.backdrop]) {
          const normalizedUrl = String(rawUrl || '').trim();
          if (!normalizedUrl || isLikelyPlaceholderArtwork(normalizedUrl) || seenImageUrls.has(normalizedUrl)) {
            continue;
          }
          seenImageUrls.add(normalizedUrl);
          directImageUrls.push(normalizedUrl);
          if (directImageUrls.length >= HOME_ARTWORK_DIRECT_IMAGE_LIMIT) break;
        }
        if (directImageUrls.length >= HOME_ARTWORK_DIRECT_IMAGE_LIMIT) break;
      }

      await runWithConcurrency(
        directImageUrls,
        HOME_ARTWORK_PREFETCH_CONCURRENCY,
        async (url) => {
          if (cancelled) return;
          await preloadImageUrl(url);
        },
      );

      if (cancelled || !isTMDBConfigured()) {
        if (!cancelled) {
          setCardTMDBMissedByKey({});
        }
        return;
      }

      const tmdbPrefetchMap: Record<string, TMDBData> = {};
      const tmdbMissedByKey: Record<string, true> = {};
      const tmdbProcessedKeys = new Set<string>();

      const shouldFetchTMDBMetadata = (item: Media): boolean =>
        normalizeTMDBType(item.type as unknown as string) !== null;

      const processTMDBCandidate = async (item: Media, respectDeadline: boolean) => {
        if (cancelled) return;
        if (respectDeadline && Date.now() > deadline) return;

        const mediaKey = getHeroMediaKey(item);
        const tmdbType = normalizeTMDBType(item.type as unknown as string);
        if (!mediaKey || !tmdbType || tmdbProcessedKeys.has(mediaKey)) return;

        tmdbProcessedKeys.add(mediaKey);

        try {
          const metadata = await fetchTMDBMetadata(item.title, tmdbType, {
            includeDetails: false,
          });
          if (!metadata || cancelled) {
            tmdbMissedByKey[mediaKey] = true;
            return;
          }

          tmdbPrefetchMap[mediaKey] = metadata;
          await Promise.allSettled([
            preloadImageUrl(metadata.thumbnail),
            preloadImageUrl(metadata.backdrop),
          ]);
        } catch {
          tmdbMissedByKey[mediaKey] = true;
        }
      };

      const startTime = Date.now();
      const deadline = startTime + HOME_ARTWORK_PREFETCH_TIMEOUT_MS;

      const criticalTMDBCandidates = criticalCandidates.filter((item) => shouldFetchTMDBMetadata(item));
      await runWithConcurrency(
        criticalTMDBCandidates,
        HOME_ARTWORK_PREFETCH_CONCURRENCY,
        async (item) => {
          await processTMDBCandidate(item, false);
        },
      );

      const tmdbCandidates = mediaCandidates.filter((item) => shouldFetchTMDBMetadata(item));
      await runWithConcurrency(
        tmdbCandidates,
        HOME_ARTWORK_PREFETCH_CONCURRENCY,
        async (item) => {
          await processTMDBCandidate(item, true);
        },
      );

      if (cancelled) return;
      setCardPreloadedTMDB(tmdbPrefetchMap);
      setCardTMDBMissedByKey(tmdbMissedByKey);
    };

    void preloadHomeArtwork().finally(() => {
      if (!cancelled) {
        setIsPreparingInitialArtwork(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [catalogPreviewCategories]);

  useEffect(() => {
    if (!isHeroRandomFilter || heroCandidates.length === 0 || !isTMDBConfigured()) {
      return;
    }

    let cancelled = false;
    const candidates = [...heroCandidates];

    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const preloadTargets = candidates.slice(0, HERO_TMDB_PRELOAD_LIMIT);

    const preloadTMDBForHero = async () => {
      for (const candidate of preloadTargets) {
        if (cancelled) return;

        const key = getHeroMediaKey(candidate);
        if (!key || heroPreloadedTMDBRef.current[key]) {
          continue;
        }

        const tmdbType = normalizeTMDBType(candidate.type as unknown as string);
        if (!tmdbType) continue;

        try {
          const metadata = await fetchTMDBMetadata(candidate.title, tmdbType);
          if (cancelled) continue;
          if (!metadata) {
            console.warn(`[HeroTMDB] Sem correspondencia no TMDB para: ${candidate.title}`);
            continue;
          }
          // Aceita metadata com pelo menos thumbnail OU backdrop
          if (!metadata.backdrop && !metadata.thumbnail) {
            console.warn(`[HeroTMDB] Metadata sem artwork util para: ${candidate.title}`);
            continue;
          }

          setHeroPreloadedTMDB((prev) => {
            if (prev[key]) return prev;
            return { ...prev, [key]: metadata };
          });
        } catch (tmdbError) {
          const errorLabel =
            tmdbError instanceof Error
              ? `${tmdbError.name}: ${tmdbError.message}`
              : String(tmdbError);
          console.warn('[HeroTMDB] Falha no preload de metadata:', errorLabel);
        }
      }
    };

    void preloadTMDBForHero();

    return () => {
      cancelled = true;
    };
  }, [heroCandidates, isHeroRandomFilter]);

  useEffect(() => {
    if (!isHeroRandomFilter) {
      setHeroMedia(null);
      return;
    }

    if (heroSelectionCandidates.length === 0) {
      setHeroMedia(null);
      return;
    }

    setHeroMedia((current) => {
      if (current) {
        const currentKey = getHeroMediaKey(current);
        const stillAvailable = heroSelectionCandidates.some(
          (candidate) => getHeroMediaKey(candidate) === currentKey,
        );
        if (stillAvailable) {
          return current;
        }
      }
      return pickRandomHeroMedia(heroSelectionCandidates, current);
    });
  }, [activeFilter, heroSelectionCandidates, isHeroRandomFilter]);

  useEffect(() => {
    if (!isHeroRandomFilter || !isAutoRotating || heroSelectionCandidates.length < 2) {
      return;
    }

    const hasTrailer = Boolean(heroDisplayTMDBData?.trailerKey);
    const intervalTime = hasTrailer
      ? (layout.isTvProfile ? 22000 : 20000)
      : (layout.isTvProfile ? 12000 : 8000);

    const intervalId = setInterval(() => {
      setHeroMedia((current) => pickRandomHeroMedia(heroSelectionCandidates, current));
    }, intervalTime);

    return () => clearInterval(intervalId);
  }, [heroSelectionCandidates, isAutoRotating, isHeroRandomFilter, heroDisplayTMDBData?.trailerKey, layout.isTvProfile]);

  useEffect(() => {
    if (!isHeroRandomFilter) {
      return;
    }

    if (activeVideoUrl) {
      clearAutoRotateResumeTimer();
      wasPlayingRef.current = true;
      setIsAutoRotating(false);
      return;
    }

    if (wasPlayingRef.current) {
      setIsAutoRotating(true);
      wasPlayingRef.current = false;
    }
  }, [activeVideoUrl, clearAutoRotateResumeTimer, isHeroRandomFilter]);

  useEffect(() => {
    return () => {
      clearAutoRotateResumeTimer();
    };
  }, [clearAutoRotateResumeTimer]);

  const categoriesWithCoverCards = useMemo(() => {
    if (activeFilter === 'live') {
      return filteredCategories;
    }

    return filteredCategories
      .map((category) => {
        const coveredItems = category.items.filter((item) => {
          if (item.type === 'live') return true;
          const mediaKey = getHeroMediaKey(item);
          const preloaded = mediaKey ? cardPreloadedTMDB[mediaKey] : null;
          return (
            hasUsefulArtworkUrl(item.thumbnail)
            || hasUsefulArtworkUrl(item.backdrop)
            || hasUsefulArtworkUrl(preloaded?.thumbnail)
            || hasUsefulArtworkUrl(preloaded?.backdrop)
          );
        });

        const sourceItems = coveredItems.length > 0 ? coveredItems : category.items;

        const rankedItems = sourceItems
          .map((item, originalIndex) => {
            const mediaKey = getHeroMediaKey(item);
            const metadata = mediaKey ? cardPreloadedTMDB[mediaKey] : null;
            return {
              item,
              originalIndex,
              rankScore: getTMDBRankingScore(metadata),
            };
          })
          .sort((left, right) => {
            const leftScore = left.rankScore;
            const rightScore = right.rankScore;

            if (leftScore == null && rightScore == null) {
              return left.originalIndex - right.originalIndex;
            }
            if (leftScore == null) return 1;
            if (rightScore == null) return -1;

            const diff = rightScore - leftScore;
            if (Math.abs(diff) < 0.005) {
              return left.originalIndex - right.originalIndex;
            }
            return diff;
          })
          .map((entry) => entry.item);

        return {
          ...category,
          items: rankedItems,
        };
      })
      .filter((category) => category.items.length > 0);
  }, [activeFilter, cardPreloadedTMDB, filteredCategories]);

  const nextEpisode = useMemo(() => {
    if (!playingMedia || playingMedia.type !== 'series' || !playingMedia.currentEpisode) return null;
    const currentSeason = playingMedia.seasons?.find(s => s.seasonNumber === playingMedia.currentSeasonNumber);
    if (!currentSeason) return null;
    
    const currentIndex = currentSeason.episodes.findIndex(e => e.id === playingMedia.currentEpisode?.id);
    if (currentIndex !== -1 && currentIndex < currentSeason.episodes.length - 1) {
      const nextEp = currentSeason.episodes[currentIndex + 1];
      return {
        ...playingMedia,
        videoUrl: nextEp.videoUrl,
        title: `${playingMedia.title} - ${nextEp.title}`,
        currentEpisode: nextEp
      };
    }
    return null;
  }, [playingMedia]);

  const latestPlaylistLog = playlistLogs[playlistLogs.length - 1];
  const loadingMessage =
    playlistStatus === 'loading_user_info'
      ? 'Validando sua conta...'
      : isWritingDatabase
        ? 'Loading Catalog...'
        : playlistStatus === 'loading_playlist'
        ? 'Carregando catalogo IPTV...'
        : (playlistError?.message || 'Preparando sistema...');
  const loadingDetails =
    latestPlaylistLog
    || playlistError?.details
    || 'Aguarde. Estamos sincronizando seus canais e categorias.';

  const isPlaylistStillBooting =
    catalogPreviewCategories.length === 0
    && (
      loading
      || playlistStatus === 'loading_user_info'
      || playlistStatus === 'loading_playlist'
      || (!playlistError && playlistStatus === 'idle')
    );
  const hasBlockingPlaylistError =
    !!playlistError && catalogPreviewCategories.length === 0 && !isPlaylistStillBooting;
  const hasCatalogButEmptyView =
    catalogPreviewCategories.length > 0
    && !loading
    && categoriesWithCoverCards.length === 0
    && activeFilter !== 'search'
    && activeFilter !== 'mylist';

  useEffect(() => {
    console.log('[HomeScreen] Gate de render:', {
      loading,
      playlistStatus,
      hasPlaylistError: Boolean(playlistError),
      catalogPreviewCategories: catalogPreviewCategories.length,
      categoriesWithCoverCards: categoriesWithCoverCards.length,
      isPlaylistStillBooting,
      hasBlockingPlaylistError,
      hasCatalogButEmptyView,
      activeFilter,
    });
  }, [
    activeFilter,
    categoriesWithCoverCards.length,
    catalogPreviewCategories.length,
    hasBlockingPlaylistError,
    hasCatalogButEmptyView,
    isPlaylistStillBooting,
    loading,
    playlistError,
    playlistStatus,
  ]);
  if (catalogPreviewCategories.length === 0 && !hasBlockingPlaylistError) {
    return (
      <LoadingScreen
        message={loadingMessage}
        details={loadingDetails}
        progress={playlistProgress}
        logs={playlistLogs}
      />
    );
  }

  if (hasBlockingPlaylistError) {
    return (
      <View style={styles.container}>
        <View style={styles.errorStateContainer}>
          <Text style={styles.errorStateTitle}>
            {playlistError?.message || 'Falha ao carregar o catalogo'}
          </Text>
          <Text style={styles.errorStateDetails}>
            {playlistError?.details || 'Nao foi possivel carregar sua lista agora. Verifique a conexao e tente novamente.'}
          </Text>

          <View style={styles.errorStateActions}>
            <TouchableHighlight
              onPress={handleRetryPlaylist}
              underlayColor="rgba(255,255,255,0.08)"
              style={styles.errorPrimaryButton}
            >
              <View style={styles.errorButtonInner}>
                <RotateCcw size={18} color="white" />
                <Text style={styles.errorPrimaryButtonText}>Tentar Novamente</Text>
              </View>
            </TouchableHighlight>

            <TouchableHighlight
              onPress={onLogout}
              underlayColor="rgba(239,68,68,0.12)"
              style={styles.errorSecondaryButton}
            >
              <View style={styles.errorButtonInner}>
                <LogOut size={18} color="#f87171" />
                <Text style={styles.errorSecondaryButtonText}>Sair da Sessao</Text>
              </View>
            </TouchableHighlight>
          </View>
        </View>
      </View>
    );
  }

  if (hasCatalogButEmptyView) {
    return (
      <View style={styles.container}>
        <View style={styles.errorStateContainer}>
          <Text style={styles.errorStateTitle}>Catalogo carregado, mas sem itens visiveis</Text>
          <Text style={styles.errorStateDetails}>
            Nenhum conteudo foi encontrado para este filtro. Tente abrir outra secao ou recarregar a lista.
          </Text>
          <Text style={styles.catalogStatsText}>
            Total: {totalMediaItems} itens | Live: {liveItemsCount} | Filmes: {movieItemsCount} | Series: {seriesItemsCount}
          </Text>

          <View style={styles.errorStateActions}>
            <TouchableHighlight
              onPress={() => setActiveFilter('live')}
              underlayColor="rgba(255,255,255,0.08)"
              style={styles.errorPrimaryButton}
            >
              <View style={styles.errorButtonInner}>
                <Text style={styles.errorPrimaryButtonText}>Abrir Canais ao Vivo</Text>
              </View>
            </TouchableHighlight>

            <TouchableHighlight
              onPress={() => setActiveFilter('home')}
              underlayColor="rgba(255,255,255,0.08)"
              style={styles.errorSecondaryButton}
            >
              <View style={styles.errorButtonInner}>
                <Text style={styles.errorSecondaryButtonText}>Voltar para Inicio</Text>
              </View>
            </TouchableHighlight>

            <TouchableHighlight
              onPress={handleRetryPlaylist}
              underlayColor="rgba(255,255,255,0.08)"
              style={styles.errorSecondaryButton}
            >
              <View style={styles.errorButtonInner}>
                <RotateCcw size={18} color="#f87171" />
                <Text style={styles.errorSecondaryButtonText}>Recarregar Lista</Text>
              </View>
            </TouchableHighlight>
          </View>
        </View>
      </View>
    );
  }

  const isAnyOverlayActive = isDetailsVisible || !!gridCategory || isSettingsVisible;
  const centeredContentMaxWidth = layout.isTvProfile
    ? null
    : null; // No centering on TV for full-bleed Hero appearance

  return (
    <View style={styles.container}>
      {!hasBlockingPlaylistError && (
      <View 
        style={{ flex: 1, flexDirection: 'row', width: '100%', height: '100%' }}
        aria-hidden={isAnyOverlayActive}
        pointerEvents={isAnyOverlayActive ? 'none' : 'auto'}
      >
        {/* Sidebar Navigation - Fixed Rail */}
        {shouldRenderSideMenu && (
          <View style={{ width: isTvProfile ? 0 : sideMenuCollapsedWidth, height: '100%', zIndex: 250 }}>
            <SideMenu 
              onSelect={handleCategorySelect} 
              activeId={activeFilter} 
              onLogout={onLogout}
              onExpandedChange={setIsSideMenuExpanded}
            />
          </View>
        )}

        {/* Main Content Area */}
        <motion.div
          style={{ flex: 1, minWidth: 0, display: 'flex', width: '100%' }}
          animate={{ marginLeft: isTvProfile ? 0 : mainContentShift }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
        <View style={{ flex: 1 }}>
          {activeFilter === 'live' ? (
            <Suspense fallback={<LoadingScreen />}>
              <LiveTVGrid 
                categories={filteredCategories}
                onPlayFull={handlePlay} 
                layout={layout}
                externalMedia={null}
                isGlobalPlayerActive={!!activeVideoUrl}
              />
            </Suspense>
          ) : (
            <div
              ref={scrollRef as any}
              className="main-scrollview custom-scrollbar"
              onScroll={handleMainListScroll}
              style={{
                ...styles.scrollContentTv,
                flex: 1,
                overflowY: 'auto',
                overflowX: 'hidden',
                paddingLeft: 0,
                paddingRight: 0,
                paddingTop: 0,
                paddingBottom: 100,
              }}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: (layout.isTvProfile || !centeredContentMaxWidth) ? '100%' : centeredContentMaxWidth,
                  marginLeft: (layout.isTvProfile || !centeredContentMaxWidth) ? 0 : 'auto',
                  marginRight: (layout.isTvProfile || !centeredContentMaxWidth) ? 0 : 'auto',
                  paddingLeft: layout.isTvProfile ? 0 : layout.horizontalPadding,
                  paddingRight: layout.isTvProfile ? 0 : Math.max(36, layout.horizontalPadding),
                  paddingTop: layout.isTvProfile
                    ? 0
                    : layout.topHeaderPadding + (layout.isCompact ? 10 : 20),
                }}
              >
                {/* Meus Favoritos (Etapa 12) */}
                {favorites.length > 0 && (
                  <CategoryRow 
                    title="Meus Favoritos" 
                    items={favorites} 
                    rowIndex={-1} 
                  />
                )}
                {/* 
                  Otimização de Performance: 
                  Utilizamos o useVirtualizer para a lista de linhas de categorias. 
                  Isso evita que o navegador tente gerenciar milhares de nós de DOM (capas) 
                  simultaneamente, focando apenas no que está na tela.
                */}
                <RowsVirtualList 
                  categories={categoriesWithCoverCards}
                  cardPreloadedTMDB={cardPreloadedTMDB}
                  cardTMDBMissedByKey={cardTMDBMissedByKey}
                  handleCategoryMediaFocus={handleCategoryMediaFocus}
                  handleMediaPress={handleMediaPress}
                  setGridCategory={setGridCategory}
                  heroMedia={heroDisplayMedia}
                  heroPreloadedTMDB={heroDisplayTMDBData}
                  isHeroAutoRotating={isAutoRotating}
                  layout={layout}
                  handleHeroFocus={handleHeroFocus}
                  setIsDetailsVisible={setIsDetailsVisible}
                  setDetailsMedia={setDetailsMedia}
                  isHeroVisibleInList={isHeroVisibleInList}
                  handlePlay={handlePlay}
                  scrollRef={scrollRef}
                />
              </div>
            </div>
          )}

          {/* Header Overlay Branding */}
          {!activeVideoUrl && (
            <View style={[styles.header, { 
              top: layout.isTvProfile ? 10 : 20,
              position: 'absolute',
              height: 60,
              paddingLeft: layout.isTvProfile ? 22 : 20 
            }]}>
              <Text style={[styles.logo, { fontSize: layout.isTvProfile ? 24 : 56, letterSpacing: layout.isTvProfile ? -1.4 : -3 }]}>XANDEFLIX</Text>
            </View>
          )}
        </View>
        </motion.div>
      </View>
      )}

      {/* Overlays */}
      <AnimatePresence>
        {isDetailsVisible && detailsMedia && (
          <Suspense fallback={null}>
            <MediaDetailsPage
              key={detailsMedia.id}
              media={detailsMedia}
              onClose={() => {
                setIsDetailsVisible(false);
                setDetailsMedia(null);
              }}
              onPlay={handlePlay}
              onSelectMedia={setDetailsMedia}
            />
          </Suspense>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {activeVideoUrl && playerMode !== 'closed' && (
          <Suspense fallback={null}>
            {playerMode === 'minimized' ? (
              <motion.div
                key={`mini-${activeVideoUrl}`}
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                style={{
                  position: 'fixed',
                  right: 20,
                  bottom: 24,
                  width: 360,
                  height: 202,
                  borderRadius: 14,
                  overflow: 'hidden',
                  zIndex: 1400,
                  backgroundColor: '#000',
                  boxShadow: '0 12px 30px rgba(0,0,0,0.55)',
                  border: '1px solid rgba(255,255,255,0.14)',
                }}
              >
                <VideoPlayer
                  ref={activePlayerRef}
                  key={`${activeVideoUrl}-minimized`}
                  url={activeVideoUrl}
                  mediaType={videoType || 'live'}
                  media={playingMedia}
                  nextEpisode={nextEpisode}
                  onPlayNextEpisode={nextEpisode ? () => handlePlay(nextEpisode) : undefined}
                  onClose={closeActivePlayer}
                  isMinimized
                  isPreview
                  onPreviewRequestFullscreen={() => setPlayerMode('fullscreen')}
                  channelBrowserCategories={filteredCategories}
                  onZap={handlePlay}
                />
              </motion.div>
            ) : (
              <VideoPlayer
                ref={activePlayerRef}
                key={`${activeVideoUrl}-fullscreen`}
                url={activeVideoUrl}
                mediaType={videoType || 'live'}
                media={playingMedia}
                nextEpisode={nextEpisode}
                onPlayNextEpisode={nextEpisode ? () => handlePlay(nextEpisode) : undefined}
                onClose={closeActivePlayer}
                isMinimized={false}
                isPreview={false}
                channelBrowserCategories={filteredCategories}
                onZap={handlePlay}
              />
            )}
          </Suspense>
        )}
      </AnimatePresence>

      <Suspense fallback={null}>
        {gridCategory && (
          <CategoryGridView 
            category={gridCategory}
            onClose={() => setGridCategory(null)}
            onSelectMedia={(media) => {
              setGridCategory(null);
              handleMediaPress(media);
            }}
          />
        )}
      </Suspense>

      <SettingsModal
        isVisible={isSettingsVisible}
        onClose={() => setIsSettingsVisible(false)}
        onSave={() => {}}
        onLogout={onLogout}
        allCategories={catalogPreviewCategories}
        hiddenCategoryIds={hiddenCategoryIds}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050505',
    flexDirection: 'row',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingLeft: 20,
    paddingRight: 60,
    paddingTop: 80, // Space for logo/header
    paddingBottom: 100,
  },
  scrollContentTv: {
    paddingLeft: 0,
    paddingRight: 0,
    paddingBottom: 100,
    paddingTop: 0, 
    width: '100%',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 100,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    zIndex: 100,
    pointerEvents: 'none' as any,
  },
  logo: {
    fontSize: 56,
    fontWeight: '900',
    color: '#E50914',
    fontStyle: 'italic',
    letterSpacing: -3,
    fontFamily: 'Outfit',
  },
  emptyContainer: {
    padding: 100, 
    alignItems: 'center',
  },
  emptyText: {
    color: 'rgba(255,255,255,0.4)', 
    fontSize: 24, 
    fontWeight: 'bold',
    fontFamily: 'Outfit',
  },
  errorStateContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    maxWidth: 760,
    alignSelf: 'center',
  },
  errorStateTitle: {
    color: 'white',
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 12,
    fontFamily: 'Outfit',
  },
  errorStateDetails: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 26,
    fontFamily: 'Outfit',
  },
  catalogStatsText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 20,
    fontFamily: 'Outfit',
  },
  errorStateActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 12,
  },
  errorPrimaryButton: {
    backgroundColor: '#E50914',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  errorPrimaryButtonText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '900',
    fontFamily: 'Outfit',
  },
  errorSecondaryButton: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  errorSecondaryButtonText: {
    color: '#f87171',
    fontSize: 15,
    fontWeight: '900',
    fontFamily: 'Outfit',
  },
  errorButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});

export default HomeScreen;
