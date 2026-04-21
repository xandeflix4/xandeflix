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

const normalizeCategoryLabel = (value: string | undefined): string =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const isHeroFeaturedCategory = (categoryTitle: string | undefined): boolean => {
  const normalized = normalizeCategoryLabel(categoryTitle);
  if (!normalized) return false;

  const isLancamentos =
    normalized.includes('lancamentos')
    || normalized.includes('lancamento');
  const isRecemAdicionado =
    normalized.includes('recem adicionado')
    || normalized.includes('recem adicionados')
    || normalized.includes('recentemente adicionado');
  // Alguns provedores nomeiam "recém adicionado" como "novidades do/de mês".
  const isNovidadesDoMes =
    normalized.includes('novidades de m')
    || normalized.includes('novidades do mes')
    || normalized.includes('novidades mes');

  return isLancamentos || isRecemAdicionado || isNovidadesDoMes;
};

const getHomeCategoryPriority = (categoryTitle: string | undefined): number => {
  const normalized = normalizeCategoryLabel(categoryTitle);
  if (!normalized) return 99;

  const isLancamentos =
    normalized.includes('lancamentos')
    || normalized.includes('lancamento');
  if (isLancamentos) return 0;

  const isNovidadesDoMes =
    normalized.includes('novidades de m')
    || normalized.includes('novidades do mes')
    || normalized.includes('novidades mes')
    || normalized.includes('recem adicionado')
    || normalized.includes('recem adicionados')
    || normalized.includes('recentemente adicionado');
  if (isNovidadesDoMes) return 1;

  return 99;
};

const isLancamentosCategory = (categoryTitle: string | undefined): boolean => {
  const normalized = normalizeCategoryLabel(categoryTitle);
  return normalized.includes('lancamentos') || normalized.includes('lancamento');
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
  onHeroPrev: () => void;
  onHeroNext: () => void;
  heroPaginationIndex: number | null;
  heroPaginationTotal: number;
  canHeroPaginate: boolean;
  onTrailerError: (media: Media) => void;
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
  onHeroPrev,
  onHeroNext,
  heroPaginationIndex,
  heroPaginationTotal,
  canHeroPaginate,
  onTrailerError,
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

  // Virtualization is ALWAYS enabled to prevent OOM on TVs with 198k items
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
                onPrev={onHeroPrev}
                onNext={onHeroNext}
                paginationIndex={heroPaginationIndex}
                paginationTotal={heroPaginationTotal}
                canPaginate={canHeroPaginate}
                onTrailerError={onTrailerError}
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
  const setSearchQuery = useStore((state) => state.setSearchQuery);
  const isSettingsVisible = useStore((state) => state.isSettingsVisible);
  const setIsSettingsVisible = useStore((state) => state.setIsSettingsVisible);
  const hiddenCategoryIds = useStore((state) => state.hiddenCategoryIds);
  const setHiddenCategoryIds = useStore((state) => state.setHiddenCategoryIds);
  const setActiveFilter = useStore((state) => state.setActiveFilter);
  const isTvMode = useStore((state) => state.isTvMode);
  const playerMode = useStore((state) => state.playerMode);
  const setPlayerMode = useStore((state) => state.setPlayerMode);
  const favorites = useStore((state) => state.favorites);
  const lastPlaylistUrl = useStore((state) => state.lastPlaylistUrl);
  const fetchPlaylistAction = useStore((state) => state.fetchPlaylist);

  // Video Player Global State
  const activeVideoUrl = useStore((state) => state.activeVideoUrl);
  const setActiveVideoUrl = useStore((state) => state.setActiveVideoUrl);
  const videoType = useStore((state) => state.videoType);
  const setVideoType = useStore((state) => state.setVideoType);
  const playingMedia = useStore((state) => state.playingMedia);
  const setPlayingMedia = useStore((state) => state.setPlayingMedia);

  // Local UI State
  const [isAutoRotating, setIsAutoRotating] = useState(true);
  const detailsMedia = useStore((state) => state.selectedMedia);
  const setDetailsMedia = useStore((state) => state.setSelectedMedia);
  const [isDetailsVisible, setIsDetailsVisible] = useState(false); // Manteremos a visibilidade local para animação, mas a mídia no store
  const [gridCategory, setGridCategory] = useState<Category | null>(null);
  const [heroMedia, setHeroMedia] = useState<Media | null>(null);
  const [isHeroVisibleInList, setIsHeroVisibleInList] = useState(true);
  const [isSideMenuExpanded, setIsSideMenuExpanded] = useState(false);
  const [heroPreloadedTMDB, setHeroPreloadedTMDB] = useState<Record<string, TMDBData>>({});
  const [cardPreloadedTMDB, setCardPreloadedTMDB] = useState<Record<string, TMDBData>>({});
  const [cardTMDBMissedByKey, setCardTMDBMissedByKey] = useState<Record<string, true>>({});
  const [isPreparingInitialArtwork, setIsPreparingInitialArtwork] = useState(true);
  const [failedTrailerIds, setFailedTrailerIds] = useState<Record<string, true>>({});
  const heroPreloadedTMDBRef = useRef<Record<string, TMDBData>>({});
  const cardPreloadScopeRef = useRef<string>('');
  
  const handleTrailerError = useCallback((media: Media) => {
    console.warn(`[Trailer] Video indisponivel para ${media.title}. Removendo do Hero.`);
    setFailedTrailerIds(prev => ({ ...prev, [media.id]: true }));
    // Forçar rotação para o próximo item
    setHeroMedia(null);
  }, []);

  // TV Navigation — active only in TV mode AND when no overlay is stealing focus
  // CRITICAL: Must disable when activeFilter is 'live' because LiveTVGrid has its own useTvNavigation
  const isHomeNavActive = isTvMode && !isDetailsVisible && !gridCategory && !isSettingsVisible && !playingMedia && activeFilter !== 'live' && activeFilter !== 'sports';
  const { setFocusedId, focusedId } = useTvNavigation({ isActive: isHomeNavActive, subscribeFocused: true });

  // Global Back Handler
  useEffect(() => {
    const handleGlobalBack = (e: KeyboardEvent) => {
      const key = e.key;
      const isBack = key === 'Escape' || key === 'Back' || (e as any).keyCode === 4;
      
      if (isBack) {
        console.log(`[HomeScreen] Comando de Back detectado: ${key}`);
      }
      
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
        return;
      }

      if (isSideMenuExpanded) {
        setIsSideMenuExpanded(false);
        e.preventDefault();
        return;
      }

      if (isTvMode) {
        const activeElement = document.activeElement as HTMLElement | null;
        const currentNavId = activeElement?.dataset?.navId || activeElement?.closest('[data-nav-id]')?.getAttribute('data-nav-id');
        const isFocusedOnMenu = currentNavId && currentNavId.startsWith('menu-');

        if (!isFocusedOnMenu) {
          setFocusedId(`menu-${activeFilter || 'home'}`);
          e.preventDefault();
          return;
        }
      }

      // Se já estiver focado no menu (ou for mobile), e não estiver na Home, volta pra Home como última rede de segurança antes de sair.
      if (activeFilter !== 'home') {
        setActiveFilter('home');
        e.preventDefault();
        return;
      }
    };

    window.addEventListener('keydown', handleGlobalBack);
    return () => window.removeEventListener('keydown', handleGlobalBack);
  }, [playingMedia, isDetailsVisible, gridCategory, isSettingsVisible, setPlayerMode, setIsSettingsVisible, activeFilter, setActiveFilter, isSideMenuExpanded, setIsSideMenuExpanded, isTvMode, setFocusedId]);

  const {
    fetchPlaylist,
    loading,
    playlistError,
    playlistStatus,
    playlistProgress,
    playlistLogs,
    catalogPreviewCategories,
    isWritingDatabase,
    isBackgroundSyncing,
  } = usePlaylist();
  const { filteredCategories } = useMediaFilter(catalogPreviewCategories);

  // Filtra itens favoritos das categorias visíveis
  const favoriteItems = useMemo(() => {
    if (favorites.length === 0) return [];
    const seenIds = new Set<string>();
    const items: Media[] = [];
    
    for (const cat of filteredCategories) {
      for (const item of cat.items) {
        if (seenIds.has(item.id)) continue;
        const isFav = favorites.includes(item.id) || favorites.includes(item.videoUrl || `media:${item.id}`);
        if (isFav) {
          seenIds.add(item.id);
          items.push(item);
        }
      }
    }
    
    return items;
  }, [favorites, filteredCategories]);

  // Controle de foco inicial seguro contra Race Conditions
  const initialFocusSetRef = useRef(false);
  
  // A interface está pronta para foco assim que o catálogo existir; prefetch roda em background.
  const isInterfaceReadyForFocus = catalogPreviewCategories.length > 0;

  useEffect(() => {
    if (isTvMode && !isInterfaceReadyForFocus) {
      return;
    }

    // REMOVIDO TEMPORARIAMENTE: Se temos uma mídia selecionada persistida, abrir o modal automaticamente
    // if (detailsMedia && !isDetailsVisible) {
    //   setIsDetailsVisible(true);
    // }

    if (!initialFocusSetRef.current && isInterfaceReadyForFocus) {
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
  const shouldRenderSideMenu = !layout.isMobile || layout.isTvProfile;
  const isFullscreenPlayerActive = Boolean(activeVideoUrl && playerMode === 'fullscreen');
  const shouldShowSideMenu = shouldRenderSideMenu && !isFullscreenPlayerActive;
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
    let candidates = filteredCategories
      .filter((category) => {
        if (!isHeroFeaturedCategory(category.title)) return false;
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

    // Se não encontrou nada nas categorias em destaque, pega itens normais (fallback para séries)
    if (candidates.length === 0 && filteredCategories.length > 0) {
      candidates = filteredCategories
        .slice(0, 5) // Pega as primeiras 5 categorias para não pesar
        .flatMap((category) => category.items)
        .filter((item) => allowedTypes.has(String(item.type).toLowerCase()))
        .filter((item) => {
          const key = getHeroMediaKey(item);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }

    return candidates;
  }, [activeFilter, filteredCategories, isHeroRandomFilter]);

  const heroReadyCandidates = useMemo(
    () =>
      heroCandidates.filter((item) => {
        const key = getHeroMediaKey(item);
        if (failedTrailerIds[key]) return false;

        const metadata = key ? heroPreloadedTMDB[key] : null;
        
        // ESTRATEGIA: Para estar no Hero, precisa ter BACKDROP e TRAILER confirmados.
        const hasTMDBBackdrop = Boolean(metadata?.backdrop);
        const hasTrailer = Boolean(metadata?.trailerKey);
        const hasDistinctLocalBackdrop = Boolean(
          item.backdrop && 
          item.backdrop !== item.thumbnail && 
          item.backdrop.trim().length > 0
        );

        return (hasTMDBBackdrop || hasDistinctLocalBackdrop) && hasTrailer;
      }).sort((a, b) => {
        const scoreA = getTMDBRankingScore(heroPreloadedTMDB[getHeroMediaKey(a)]) || 0;
        const scoreB = getTMDBRankingScore(heroPreloadedTMDB[getHeroMediaKey(b)]) || 0;
        return scoreB - scoreA; // Ordem decrescente de avaliao
      }),
    [heroCandidates, heroPreloadedTMDB, failedTrailerIds],
  );

  const heroSelectionCandidates = useMemo(() => {
    const nonFailedCandidates = heroCandidates.filter((item) => {
      const key = getHeroMediaKey(item);
      return key ? !failedTrailerIds[key] : true;
    });

    if (heroReadyCandidates.length > 0) {
      return heroReadyCandidates;
    }

    // Fallback rÃ¡pido: permite rotaÃ§Ã£o inicial com backdrops locais distintos
    // enquanto o preload de metadados TMDB ainda estÃ¡ aquecendo.
    const localBackdropCandidates = nonFailedCandidates.filter(hasDistinctBackdrop);
    if (localBackdropCandidates.length > 0) {
      return localBackdropCandidates;
    }

    // Ãšltimo fallback para evitar Hero travado sem rotaÃ§Ã£o.
    return nonFailedCandidates;
  }, [heroCandidates, heroReadyCandidates, failedTrailerIds]);

  const heroDisplayMedia = useMemo(() => {
    if (isHeroRandomFilter) {
      return heroMedia || heroSelectionCandidates[0] || filteredCategories[0]?.items[0] || null;
    }
    return filteredCategories[0]?.items[0] || null;
  }, [filteredCategories, heroMedia, heroSelectionCandidates, isHeroRandomFilter]);

  const heroDisplayTMDBData = useMemo(() => {
    const key = getHeroMediaKey(heroDisplayMedia);
    if (!key) return null;
    return heroPreloadedTMDB[key] || null;
  }, [heroDisplayMedia, heroPreloadedTMDB]);

  const heroPaginationState = useMemo(() => {
    if (!isHeroRandomFilter) return { index: null as number | null, total: 0 };
    if (!heroDisplayMedia || heroSelectionCandidates.length < 2) {
      return { index: null as number | null, total: heroSelectionCandidates.length };
    }

    const currentKey = getHeroMediaKey(heroDisplayMedia);
    const currentIndex = heroSelectionCandidates.findIndex(
      (candidate) => getHeroMediaKey(candidate) === currentKey,
    );
    if (currentIndex < 0) {
      return { index: null as number | null, total: heroSelectionCandidates.length };
    }

    return { index: currentIndex, total: heroSelectionCandidates.length };
  }, [heroDisplayMedia, heroSelectionCandidates, isHeroRandomFilter]);
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
    // Sidebar deve sempre navegar imediatamente para a seção escolhida.
    // Se houver overlays ativos (detalhes/grid/config), fechamos primeiro
    // para evitar "duas telas ativas" e navegação atrasada.
    setIsDetailsVisible(false);
    setDetailsMedia(null);
    setGridCategory(null);
    setIsSettingsVisible(false);

    if (id === 'profile') {
      setIsSettingsVisible(true);
      return;
    }

    setActiveFilter(id);
    if (scrollRef.current) {
      const scrollAny = scrollRef.current as any;
      if (typeof scrollAny.scrollToOffset === 'function') {
        scrollAny.scrollToOffset({ offset: 0, animated: true });
      } else if (typeof scrollAny.scrollTo === 'function') {
        scrollAny.scrollTo({ top: 0, behavior: layout.isTvProfile ? 'auto' : 'smooth' });
      }
    }
  }, [setActiveFilter, layout.isTvProfile, setIsSettingsVisible]);

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
    [isTvProfile],
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
      const launchCategories = movieAndSeriesCategories.filter((category) => isLancamentosCategory(category.title));
      const nonLaunchCategories = movieAndSeriesCategories.filter((category) => !isLancamentosCategory(category.title));
      const prioritizedCategories = [...launchCategories, ...nonLaunchCategories];

      for (const category of prioritizedCategories) {
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
      const criticalCategories = prioritizedCategories.slice(0, HOME_ARTWORK_CRITICAL_CATEGORY_LIMIT);
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
            categoryHint: item.category,
          });
          if (!metadata || cancelled) {
            tmdbMissedByKey[mediaKey] = true;
            return;
          }

          tmdbPrefetchMap[mediaKey] = metadata;
          await Promise.allSettled([
            preloadImageUrl(metadata.thumbnail || ''),
            preloadImageUrl(metadata.backdrop || ''),
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
    const isPremium = (c: any) => {
      const cat = String(c.category || c.groupTitle || '').toLowerCase();
      return cat.includes('lançamento') || cat.includes('cinema') || cat.includes('novo') || cat.includes('recent') || cat.includes('2024') || cat.includes('2025');
    };

    let pool = candidates.filter(isPremium);
    // Se não tiver categorias de lançamentos suficientes, usa o catálogo inteiro como plano B
    if (pool.length < HERO_TMDB_PRELOAD_LIMIT) {
      pool = candidates;
    }

    // Embaralha apenas o pool escolhido
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const preloadTargets = pool.slice(0, HERO_TMDB_PRELOAD_LIMIT);
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
          const metadata = await fetchTMDBMetadata(candidate.title, tmdbType, { includeDetails: true, categoryHint: candidate.category });
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

  const moveHeroSelection = useCallback((direction: 'prev' | 'next') => {
    if (!isHeroRandomFilter || heroSelectionCandidates.length < 2) return;

    clearAutoRotateResumeTimer();
    setIsAutoRotating(false);

    setHeroMedia((current) => {
      const pool = heroSelectionCandidates;
      const currentMedia = current || heroDisplayMedia || pool[0];
      const currentKey = getHeroMediaKey(currentMedia);
      const currentIndex = pool.findIndex((candidate) => getHeroMediaKey(candidate) === currentKey);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const delta = direction === 'next' ? 1 : -1;
      const nextIndex = (safeIndex + delta + pool.length) % pool.length;
      return pool[nextIndex];
    });

    scheduleHeroAutoRotateResume(layout.isTvProfile ? 12000 : 9000);
  }, [
    clearAutoRotateResumeTimer,
    heroDisplayMedia,
    heroSelectionCandidates,
    isHeroRandomFilter,
    layout.isTvProfile,
    scheduleHeroAutoRotateResume,
  ]);

  useEffect(() => {
    if (!isHomeNavActive || heroSelectionCandidates.length < 2) return;

    const isHeroFocused = typeof focusedId === 'string' && focusedId.startsWith('hero-');
    if (!isHeroFocused) return;

    const onHeroSideNavigate = (event: KeyboardEvent) => {
      const keyCode = (event as KeyboardEvent & { keyCode?: number; which?: number }).keyCode
        ?? (event as KeyboardEvent & { which?: number }).which
        ?? 0;
      const key = event.key;
      const isLeft = key === 'ArrowLeft' || key === 'Left' || keyCode === 21;
      const isRight = key === 'ArrowRight' || key === 'Right' || keyCode === 22;
      if (!isLeft && !isRight) return;

      const activeFocused = (document.activeElement as HTMLElement | null)?.dataset?.navId || focusedId;
      if (!activeFocused || !String(activeFocused).startsWith('hero-')) return;

      event.preventDefault();
      event.stopPropagation();
      (event as any).stopImmediatePropagation?.();
      moveHeroSelection(isLeft ? 'prev' : 'next');
    };

    window.addEventListener('keydown', onHeroSideNavigate, true);
    return () => window.removeEventListener('keydown', onHeroSideNavigate, true);
  }, [focusedId, heroSelectionCandidates.length, isHomeNavActive, moveHeroSelection]);

  const handleHeroPrev = useCallback(() => moveHeroSelection('prev'), [moveHeroSelection]);
  const handleHeroNext = useCallback(() => moveHeroSelection('next'), [moveHeroSelection]);

  useEffect(() => {
    return () => {
      clearAutoRotateResumeTimer();
    };
  }, [clearAutoRotateResumeTimer]);

  const categoriesWithCoverCards = useMemo(() => {
    if (activeFilter === 'live') {
      return filteredCategories;
    }

    const preparedCategories = filteredCategories
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
          .slice(0, 40)
          .map((entry) => entry.item);

        return {
          ...category,
          items: rankedItems,
        };
      })
      .filter((category) => category.items.length > 0);

    if (activeFilter !== 'home') {
      return preparedCategories;
    }

    return preparedCategories
      .map((category, originalIndex) => ({
        category,
        originalIndex,
        priority: getHomeCategoryPriority(category.title),
      }))
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return left.priority - right.priority;
        }
        return left.originalIndex - right.originalIndex;
      })
      .map((entry) => entry.category);
  }, [activeFilter, cardPreloadedTMDB, filteredCategories]);

  const categoriesForRows = useMemo(() => {
    if (activeFilter !== 'home') {
      return categoriesWithCoverCards;
    }

    const categoriesBase = categoriesWithCoverCards.filter((category) => {
      const normalizedTitle = normalizeCategoryLabel(category.title);
      return (
        category.id !== 'home-favorites'
        && category.id !== 'home-top-rated-lancamentos'
        && normalizedTitle !== 'meus favoritos'
        && normalizedTitle !== 'mais conceituados tmdb lancamentos'
      );
    });

    let withFavorites = categoriesBase;
    if (favoriteItems.length > 0) {
      const favoritesCategory: Category = {
        id: 'home-favorites',
        title: 'Meus Favoritos',
        type: 'movie',
        items: favoriteItems,
      };
      const favoritesInsertIndex = Math.min(2, withFavorites.length);
      withFavorites = [
        ...withFavorites.slice(0, favoritesInsertIndex),
        favoritesCategory,
        ...withFavorites.slice(favoritesInsertIndex),
      ];
    }

    const mergedMetadataByKey: Record<string, TMDBData> = {
      ...cardPreloadedTMDB,
      ...heroPreloadedTMDB,
    };

    const topRatedLaunchItems = filteredCategories
      .filter((category) => isLancamentosCategory(category.title))
      .flatMap((category) => category.items)
      .map((item, originalIndex) => {
        const mediaKey = getHeroMediaKey(item);
        const metadata = mediaKey ? mergedMetadataByKey[mediaKey] : null;
        const voteAverageRaw =
          Number.isFinite(metadata?.voteAverage as number)
            ? Number(metadata?.voteAverage)
            : Number.parseFloat(String(metadata?.rating || '0'));
        const voteAverage = Number.isFinite(voteAverageRaw) ? voteAverageRaw : 0;
        const voteCount = Number(metadata?.voteCount || 0);
        const popularity = Number(metadata?.popularity || 0);
        return {
          item,
          originalIndex,
          voteAverage,
          voteCount,
          popularity,
        };
      })
      .filter((entry) => entry.voteAverage >= 8.5)
      .sort((left, right) => {
        if (right.voteAverage !== left.voteAverage) return right.voteAverage - left.voteAverage;
        if (right.voteCount !== left.voteCount) return right.voteCount - left.voteCount;
        if (right.popularity !== left.popularity) return right.popularity - left.popularity;
        return left.originalIndex - right.originalIndex;
      })
      .reduce((acc, entry) => {
        const key = getHeroMediaKey(entry.item);
        if (!key || acc.seen.has(key)) return acc;
        acc.seen.add(key);
        acc.items.push(entry.item);
        return acc;
      }, { seen: new Set<string>(), items: [] as Media[] })
      .items
      .slice(0, 40);

    if (topRatedLaunchItems.length === 0) {
      return withFavorites;
    }

    const topRatedCategory: Category = {
      id: 'home-top-rated-lancamentos',
      title: 'Mais Conceituados TMDB (Lançamentos)',
      type: 'movie',
      items: topRatedLaunchItems,
    };

    const topRatedInsertIndex = Math.min(3, withFavorites.length);
    return [
      ...withFavorites.slice(0, topRatedInsertIndex),
      topRatedCategory,
      ...withFavorites.slice(topRatedInsertIndex),
    ];
  }, [
    activeFilter,
    cardPreloadedTMDB,
    categoriesWithCoverCards,
    favoriteItems,
    filteredCategories,
    heroPreloadedTMDB,
  ]);

  const searchResultCount = useMemo(
    () => categoriesForRows.reduce((acc, category) => acc + category.items.length, 0),
    [categoriesForRows],
  );
  const searchInsetLeft = (shouldRenderSideMenu ? sideMenuCollapsedWidth : 0) + (layout.isTvProfile ? 24 : 20);
  const searchInsetRight = layout.isTvProfile ? 28 : 20;
  const virtualKeyboardRows = useMemo(
    () => [
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
      ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'],
      ['U', 'V', 'W', 'X', 'Y', 'Z', '0', '1', '2', '3'],
      ['4', '5', '6', '7', '8', '9', ' ', '-', "'"],
    ],
    [],
  );

  const appendSearchCharacter = useCallback((character: string) => {
    setSearchQuery(`${searchQuery}${character}`);
  }, [searchQuery, setSearchQuery]);

  const removeLastSearchCharacter = useCallback(() => {
    setSearchQuery(searchQuery.slice(0, -1));
  }, [searchQuery, setSearchQuery]);
  const searchQueryNormalized = searchQuery.trim();
  const searchFilteredItems = useMemo(() => {
    const seen = new Set<string>();
    const flat = categoriesForRows.flatMap((category) => category.items);
    return flat.filter((item) => {
      const key = item.id || item.videoUrl;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [categoriesForRows]);
  const searchPreviewItems = useMemo(() => {
    const seen = new Set<string>();
    return catalogPreviewCategories
      .filter((category) => category.type === 'movie' || category.type === 'series')
      .flatMap((category) => category.items)
      .filter((item) => {
        const key = item.id || item.videoUrl;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 60);
  }, [catalogPreviewCategories]);
  const searchDisplayItems = searchQueryNormalized.length > 0 ? searchFilteredItems : searchPreviewItems;
  const searchDisplayCount = searchDisplayItems.length;

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
    && categoriesForRows.length === 0
    && activeFilter !== 'search'
    && activeFilter !== 'mylist';

  useEffect(() => {
    console.log('[HomeScreen] Gate de render:', JSON.stringify({
      loading,
      playlistStatus,
      hasPlaylistError: Boolean(playlistError),
      catalogPreviewCategories: catalogPreviewCategories.length,
      categoriesWithCoverCards: categoriesForRows.length,
      isPlaylistStillBooting,
      hasBlockingPlaylistError,
      hasCatalogButEmptyView,
      activeFilter,
      activeVideoUrl: !!activeVideoUrl,
      playerMode,
    }));
  }, [
    activeFilter,
    categoriesForRows.length,
    catalogPreviewCategories.length,
    hasBlockingPlaylistError,
    hasCatalogButEmptyView,
    isPlaylistStillBooting,
    loading,
    playlistError,
    playlistStatus,
  ]);

  // Foco inicial quando a interface carrega.
  // Isso evita que a Engine de TV pegue o "SideBar" (primeiro node da DOM)
  // e inicie abrindo a lateral da TV sem o usuário ter pedido.
  useEffect(() => {
    if (!loading && isTvMode && isHomeNavActive && activeFilter !== 'live' && activeFilter !== 'sports') {
      const initTimer = setTimeout(() => {
        try {
          if (!document.activeElement?.closest('.side-menu-panel')) {
             setFocusedId('hero-play'); 
          }
        } catch (error) {
          void error;
        }
      }, 500);
      return () => clearTimeout(initTimer);
    }
  }, [loading, isTvMode, isHomeNavActive, activeFilter, setFocusedId]);

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
  const shouldBlockBaseInteractions = !!gridCategory || isSettingsVisible;
  const centeredContentMaxWidth = layout.isTvProfile
    ? null
    : null; // No centering on TV for full-bleed Hero appearance

  return (
    <View style={styles.container}>
      {!hasBlockingPlaylistError && (
      <View 
        style={{ flex: 1, flexDirection: 'row', width: '100%', height: '100%' }}
        aria-hidden={shouldBlockBaseInteractions}
        pointerEvents={shouldBlockBaseInteractions ? 'none' : 'auto'}
      >
        {/* Sidebar Navigation - Fixed Rail */}
        {shouldShowSideMenu && (
          <SideMenu 
            onSelect={handleCategorySelect} 
            activeId={activeFilter} 
            onLogout={onLogout}
            onExpandedChange={setIsSideMenuExpanded}
          />
        )}

        {/* Main Content Area */}
        <div
          style={{ 
            flex: 1, 
            minWidth: 0, 
            display: 'flex', 
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            marginLeft: 0,
            transition: 'margin-left 200ms ease-out',
            willChange: 'margin-left'
          }}
        >
        <View style={{ flex: 1 }}>
          {activeFilter === 'live' || activeFilter === 'sports' ? (
            <Suspense fallback={<LoadingScreen />}>
              <LiveTVGrid 
                key={activeFilter}
                categories={filteredCategories}
                onPlayFull={handlePlay} 
                layout={layout}
                externalMedia={null}
                isGlobalPlayerActive={!!activeVideoUrl}
                section={activeFilter}
              />
            </Suspense>
          ) : activeFilter === 'search' ? (
            <div
              ref={scrollRef as any}
              className="main-scrollview custom-scrollbar"
              style={{
                width: '100%',
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
                  paddingLeft: searchInsetLeft,
                  paddingRight: searchInsetRight,
                  paddingTop: layout.isTvProfile ? 26 : 88,
                  paddingBottom: 30,
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: layout.isTvProfile ? '300px 1fr' : '1fr',
                    gap: layout.isTvProfile ? 24 : 16,
                    alignItems: 'start',
                  }}
                >
                  <div
                    style={{
                      position: layout.isTvProfile ? 'sticky' : 'relative',
                      top: layout.isTvProfile ? 16 : 0,
                      alignSelf: 'start',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 14,
                      padding: 14,
                      background: 'rgba(12,12,12,0.9)',
                    }}
                  >
                    <h2 style={{ margin: 0, color: '#fff', fontSize: 22, fontWeight: 900, letterSpacing: -0.4 }}>
                      Busca
                    </h2>
                    <div
                      style={{
                        marginTop: 10,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        border: '1px solid rgba(255,255,255,0.14)',
                        borderRadius: 10,
                        padding: '10px 12px',
                        background: 'rgba(0,0,0,0.35)',
                      }}
                    >
                      <Search size={16} color="rgba(255,255,255,0.6)" />
                      <input
                        data-nav-id="search-input"
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="Digite para buscar"
                        style={{
                          flex: 1,
                          border: 'none',
                          outline: 'none',
                          background: 'transparent',
                          color: 'white',
                          fontSize: 16,
                          fontWeight: 700,
                        }}
                      />
                    </div>

                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {virtualKeyboardRows.map((row, rowIndex) => (
                        <div key={`vk-row-${rowIndex}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(10, minmax(0, 1fr))', gap: 6 }}>
                          {row.map((keyLabel) => (
                            <button
                              key={`vk-key-${rowIndex}-${keyLabel}`}
                              onClick={() => appendSearchCharacter(keyLabel)}
                              style={{
                                height: 34,
                                borderRadius: 8,
                                border: '1px solid rgba(255,255,255,0.15)',
                                background: 'rgba(255,255,255,0.07)',
                                color: 'white',
                                fontSize: 13,
                                fontWeight: 800,
                                cursor: 'pointer',
                              }}
                            >
                              {keyLabel === ' ' ? '_' : keyLabel}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                      <button
                        onClick={removeLastSearchCharacter}
                        style={{
                          height: 36,
                          borderRadius: 8,
                          border: '1px solid rgba(255,255,255,0.15)',
                          background: 'rgba(255,255,255,0.1)',
                          color: 'white',
                          fontWeight: 800,
                          cursor: 'pointer',
                        }}
                      >
                        Apagar
                      </button>
                      <button
                        onClick={() => setSearchQuery('')}
                        style={{
                          height: 36,
                          borderRadius: 8,
                          border: '1px solid rgba(255,255,255,0.15)',
                          background: 'rgba(229,9,20,0.22)',
                          color: 'white',
                          fontWeight: 800,
                          cursor: 'pointer',
                        }}
                      >
                        Limpar
                      </button>
                    </div>
                  </div>

                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <h1 style={{ margin: 0, color: 'white', fontSize: layout.isTvProfile ? 34 : 26, fontWeight: 900, letterSpacing: -0.8 }}>
                        {searchQueryNormalized.length > 0 ? `"${searchQueryNormalized}"` : 'Sugestões para você'}
                      </h1>
                      <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' }}>
                        {searchDisplayCount} itens
                      </span>
                    </div>

                    {searchDisplayCount === 0 ? (
                      <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 15 }}>
                        Nenhum conteúdo encontrado.
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                          gap: 12,
                        }}
                      >
                        {searchDisplayItems.map((item, index) => (
                          <div
                            key={`search-grid-${item.id}-${index}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => handleMediaPress(item)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') handleMediaPress(item);
                            }}
                            style={{
                              cursor: 'pointer',
                              borderRadius: 12,
                              overflow: 'hidden',
                              background: '#101827',
                              border: '1px solid rgba(255,255,255,0.1)',
                              position: 'relative',
                              minHeight: 280,
                            }}
                          >
                            <img
                              src={item.thumbnail || item.backdrop || ''}
                              alt={item.title}
                              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                            />
                            <div
                              style={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                bottom: 0,
                                padding: '12px 10px',
                                background: 'linear-gradient(to top, rgba(0,0,0,0.95), rgba(0,0,0,0.05))',
                              }}
                            >
                              <div
                                style={{
                                  color: '#fff',
                                  fontSize: 14,
                                  fontWeight: 800,
                                  lineHeight: 1.2,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {item.title}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div
              ref={scrollRef as any}
              className="main-scrollview custom-scrollbar"
              onScroll={handleMainListScroll}
              style={{
                width: '100%',
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
                  paddingLeft: 0,
                  paddingRight: 0,
                  paddingTop: 0,
                  }}
                >
                {/* 
                  Otimização de Performance: 
                  Utilizamos o useVirtualizer para a lista de linhas de categorias. 
                  Isso evita que o navegador tente gerenciar milhares de nós de DOM (capas) 
                  simultaneamente, focando apenas no que está na tela.
                */}
                <RowsVirtualList 
                  categories={categoriesForRows}
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
                  onHeroPrev={handleHeroPrev}
                  onHeroNext={handleHeroNext}
                  heroPaginationIndex={heroPaginationState.index}
                  heroPaginationTotal={heroPaginationState.total}
                  canHeroPaginate={heroSelectionCandidates.length > 1}
                  onTrailerError={handleTrailerError}
                  scrollRef={scrollRef as any}
                />
              </div>
            </div>
          )}

          {/* Header Overlay Branding */}
          {!activeVideoUrl && (
            <View style={[styles.header, { 
              top: layout.isTvProfile ? 24 : 16,
              right: layout.isTvProfile ? 40 : 24,
              left: 'auto',
              position: 'absolute',
              zIndex: 50,
            }]}>
              {isBackgroundSyncing && (
                <View 
                  style={{ 
                    marginRight: 16, 
                    flexDirection: 'row', 
                    alignItems: 'center', 
                    gap: 8, 
                    backgroundColor: 'rgba(0,0,0,0.6)', 
                    paddingVertical: 6,
                    paddingHorizontal: 14, 
                    borderRadius: 24, 
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.08)' 
                  }}
                >
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#E50914' }} />
                  <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: layout.isTvProfile ? 10 : 12, fontWeight: '600' }}>
                    Sincronizando {playlistProgress}%
                  </Text>
                </View>
              )}
              <Text style={[styles.logo, { fontSize: layout.isTvProfile ? 11 : 22, letterSpacing: -1, opacity: 0.8 }]}>XANDEFLIX</Text>
            </View>
          )}
        </View>
        </div>
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
                  url={activeVideoUrl}
                  mediaType={videoType || 'live'}
                media={playingMedia}
                nextEpisode={nextEpisode}
                onPlayNextEpisode={nextEpisode ? () => handlePlay(nextEpisode) : undefined}
                  onClose={closeActivePlayer}
                  isMinimized={false}
                  isPreview={false}
                  isBrowseMode={videoType === 'live'}
                  showChannelSidebar={videoType === 'live'}
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
        onSave={(_url, hiddenIds) => setHiddenCategoryIds(hiddenIds)}
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
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
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
