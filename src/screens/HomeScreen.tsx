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
import { Search, RotateCcw, LogOut, ChevronRight, LayoutGrid, X, Star, WifiOff, Radio } from 'lucide-react';
import { Media, Category } from '../types';
import { useVirtualizer } from '@tanstack/react-virtual';

// Custom Hooks
import { usePlaylist } from '../hooks/usePlaylist';
import { useMediaFilter } from '../hooks/useMediaFilter';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { useTvNavigation } from '../hooks/useTvNavigation';
import {
  fetchTMDBMetadata,
  fetchTMDBTrending,
  isTMDBConfigured,
  type TMDBData,
  type TMDBTrendingItem,
} from '../lib/tmdb';
import { detectTvEnvironment } from '../lib/deviceProfile';
import { searchChannelsByQuery } from '../lib/db';

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
const TMDB_HOME_HERO_LIMIT = _isTvBoot ? 16 : 24;
const TMDB_HOME_ROW_LIMIT = _isTvBoot ? 28 : 40;
const HOME_ARTWORK_PREFETCH_ITEM_LIMIT = _isTvBoot ? 24 : 60;
const HOME_ARTWORK_DIRECT_IMAGE_LIMIT = _isTvBoot ? 36 : 90;
const HOME_ARTWORK_PREFETCH_CONCURRENCY = _isTvBoot ? 3 : 6;
const HOME_ARTWORK_PREFETCH_TIMEOUT_MS = _isTvBoot ? 9000 : 18000;
const HOME_ARTWORK_CRITICAL_CATEGORY_LIMIT = _isTvBoot ? 3 : 4;
const HOME_ARTWORK_CRITICAL_ITEMS_PER_CATEGORY = _isTvBoot ? 6 : 8;
const HOME_CATEGORY_RANK_CANDIDATE_LIMIT = _isTvBoot ? 140 : 220;

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

const normalizeSearchCacheKey = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

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

const buildTMDBVirtualMediaId = (item: TMDBTrendingItem): string =>
  `tmdb-${item.mediaType}-${item.id}`;

const buildTMDBTrendingMedia = (
  item: TMDBTrendingItem,
  categoryLabel: string,
): Media => {
  const mediaType = item.mediaType === 'movie' ? 'movie' : 'series';
  return {
    id: buildTMDBVirtualMediaId(item),
    title: item.title,
    description: item.overview || 'Sinopse nao disponivel.',
    thumbnail: item.poster || item.backdrop || '',
    backdrop: item.backdrop || item.poster || '',
    videoUrl: '',
    type: mediaType as any,
    year: item.year || 0,
    rating: item.rating || '0.0',
    category: categoryLabel,
  };
};

const buildTMDBTrendingMetadata = (item: TMDBTrendingItem): TMDBData => ({
  description: item.overview || 'Sinopse nao disponivel.',
  thumbnail: item.poster || item.backdrop || null,
  backdrop: item.backdrop || item.poster || null,
  year: item.year || 0,
  rating: item.rating || '0.0',
  voteAverage: item.voteAverage,
  voteCount: item.voteCount,
  popularity: item.popularity,
  genres: [],
  trailerKey: null,
  streamingProvider: null,
  cast: [],
  matchScore: 1,
  matchedTitle: item.title,
});

const dedupeTMDBTrendingMedia = (items: Media[]): Media[] => {
  const seen = new Set<string>();
  const deduped: Media[] = [];
  for (const item of items) {
    const key = String(item.id || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
};

const normalizeTitleLookup = (value: string): string =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\bs\d{1,2}\s*e\d{1,2}\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildTitleLookupKeys = (title: string): string[] => {
  const raw = normalizeTitleLookup(title);
  if (!raw) return [];
  const compact = raw
    .replace(/\b(hd|fhd|uhd|sd|dublado|legendado|dual audio|h265|hevc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(new Set([raw, compact].filter(Boolean)));
};

const buildPlayableCatalogLookup = (categories: Category[]): Map<string, Media[]> => {
  const lookup = new Map<string, Media[]>();
  const seenByBucket = new Map<string, Set<string>>();

  for (const category of categories) {
    for (const item of category.items) {
      const mediaType = normalizeTMDBType(item.type as unknown as string);
      if (!mediaType) continue;
      if (!String(item.videoUrl || '').trim()) continue;

      const titleKeys = buildTitleLookupKeys(item.title);
      for (const titleKey of titleKeys) {
        const bucketKey = `${mediaType}:${titleKey}`;
        const existing = lookup.get(bucketKey) || [];
        const seenIds = seenByBucket.get(bucketKey) || new Set<string>();
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        seenByBucket.set(bucketKey, seenIds);
        existing.push(item);
        lookup.set(bucketKey, existing);
      }
    }
  }

  return lookup;
};

const selectBestPlayableMatch = (
  candidates: Media[],
  trendingItem: TMDBTrendingItem,
): Media | null => {
  if (candidates.length === 0) return null;
  const trendingKeys = buildTitleLookupKeys(trendingItem.title);
  const primaryTrendingKey = trendingKeys[0] || '';

  const scored = candidates
    .map((candidate, originalIndex) => {
      const candidateKeys = buildTitleLookupKeys(candidate.title);
      const candidatePrimary = candidateKeys[0] || '';
      const yearScore =
        trendingItem.year > 0 && Number(candidate.year || 0) === trendingItem.year ? 1.2 : 0;
      const exactScore = candidatePrimary && candidatePrimary === primaryTrendingKey ? 2 : 0;
      const partialScore = candidateKeys.some((key) => trendingKeys.includes(key)) ? 0.9 : 0;
      const artworkScore =
        (String(candidate.backdrop || '').trim() ? 0.2 : 0)
        + (String(candidate.thumbnail || '').trim() ? 0.2 : 0);

      return {
        candidate,
        originalIndex,
        score: exactScore + partialScore + yearScore + artworkScore,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.originalIndex - b.originalIndex;
    });

  return scored[0]?.candidate || null;
};

const mergeTrendingWithPlayableMedia = (
  playable: Media,
  trendingItem: TMDBTrendingItem,
  fallbackCategoryLabel: string,
): Media => ({
  ...playable,
  title: playable.title || trendingItem.title,
  description: playable.description || trendingItem.overview || 'Sinopse nao disponivel.',
  thumbnail: playable.thumbnail || trendingItem.poster || trendingItem.backdrop || '',
  backdrop: playable.backdrop || trendingItem.backdrop || trendingItem.poster || '',
  year: trendingItem.year || playable.year || 0,
  rating: playable.rating || trendingItem.rating || '0.0',
  category: playable.category || fallbackCategoryLabel,
});

const resolvePlayableMatchFromTrending = (
  trendingItem: TMDBTrendingItem,
  catalogLookup: Map<string, Media[]>,
): Media | null => {
  const typeKey = trendingItem.mediaType === 'movie' ? 'movie' : 'series';
  const candidateKeys = buildTitleLookupKeys(trendingItem.title);
  const collected: Media[] = [];
  const seen = new Set<string>();

  for (const titleKey of candidateKeys) {
    const bucket = catalogLookup.get(`${typeKey}:${titleKey}`) || [];
    for (const candidate of bucket) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      collected.push(candidate);
    }
  }

  return selectBestPlayableMatch(collected, trendingItem);
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
  handleHeroInfo: (media: Media) => void;
}

// RowsVirtualList agora é apenas apresentacional, recebendo o virtualizer do pai
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
  handleHeroInfo,
  rowVirtualizer, // Recebido do pai
}: RowsVirtualListProps & { rowVirtualizer: any }) => {
  return (
    <div
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow: any) => {
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
                onInfo={handleHeroInfo}
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
            data-home-row-index={virtualRow.index}
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
  const setIsChannelBrowserOpen = useStore((state) => state.setIsChannelBrowserOpen);

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
  const isSideMenuExpandedRef = useRef(false);
  const handleSideMenuExpandedChange = useCallback((expanded: boolean) => {
    isSideMenuExpandedRef.current = expanded;
    // No state update — the sidebar CSS transition handles the visual change.
    // This ref is read only by the back-handler and the MediaDetailsPage offset.
  }, []);
  const [lastClosedLiveMedia, setLastClosedLiveMedia] = useState<Media | null>(null);
  const [heroPreloadedTMDB, setHeroPreloadedTMDB] = useState<Record<string, TMDBData>>({});
  const [cardPreloadedTMDB, setCardPreloadedTMDB] = useState<Record<string, TMDBData>>({});
  const [cardTMDBMissedByKey, setCardTMDBMissedByKey] = useState<Record<string, true>>({});
  const [isPreparingInitialArtwork, setIsPreparingInitialArtwork] = useState(true);
  const [failedTrailerIds, setFailedTrailerIds] = useState<Record<string, true>>({});
  const [searchKeyboardMode, setSearchKeyboardMode] = useState<'abnt2' | 'special'>('abnt2');
  const [searchKeyboardShift, setSearchKeyboardShift] = useState(true);
  const [searchCatalogItems, setSearchCatalogItems] = useState<Media[]>([]);
  const [isSearchCatalogLoading, setIsSearchCatalogLoading] = useState(false);
  const [homeTMDBHeroItems, setHomeTMDBHeroItems] = useState<Media[]>([]);
  const [homeTMDBMoviesWeekCategory, setHomeTMDBMoviesWeekCategory] = useState<Category | null>(null);
  const [homeTMDBSeriesWeekCategory, setHomeTMDBSeriesWeekCategory] = useState<Category | null>(null);
  const [homeTMDBMoviesComingSoonCategory, setHomeTMDBMoviesComingSoonCategory] = useState<Category | null>(null);
  const [homeTMDBSeriesComingSoonCategory, setHomeTMDBSeriesComingSoonCategory] = useState<Category | null>(null);
  const [homeTMDBMetadataByKey, setHomeTMDBMetadataByKey] = useState<Record<string, TMDBData>>({});
  const heroPreloadedTMDBRef = useRef<Record<string, TMDBData>>({});
  const cardPreloadScopeRef = useRef<string>('');
  const searchCatalogRequestRef = useRef(0);
  const searchResultsCacheRef = useRef<Map<string, Media[]>>(new Map());

  const handleTrailerError = useCallback((media: Media) => {
    console.warn(`[Trailer] Video indisponivel para ${media.title}. Removendo do Hero.`);
    setFailedTrailerIds(prev => ({ ...prev, [media.id]: true }));
    // Forçar rotação para o próximo item
    setHeroMedia(null);
  }, []);

  // TV Navigation — active only in TV mode AND when no overlay is stealing focus
  // CRITICAL: Must disable when activeFilter is 'live' because LiveTVGrid has its own useTvNavigation
  const isHomeNavActive = isTvMode && !isDetailsVisible && !gridCategory && !isSettingsVisible && !playingMedia && activeFilter !== 'live' && activeFilter !== 'sports';
  const isChannelBrowserOpen = useStore((state) => state.isChannelBrowserOpen);
  const { registerNode, setFocusedId, focusedId } = useTvNavigation({ isActive: isHomeNavActive, subscribeFocused: true });

  // Global Back Handler
  useEffect(() => {
    const handleGlobalBack = (e: KeyboardEvent) => {
      const key = e.key;
      const isBack = key === 'Escape' || key === 'Back' || (e as any).keyCode === 4;

      if (import.meta.env.DEV && isBack) {
        console.log(`[HomeScreen] Comando de Back detectado: ${key}`);
      }

      if (!isBack) return;

      if (playingMedia) {
        // Se o navegador de canais (sidebar) estiver aberto, o VideoPlayer cuidará do fechamento via stopImmediatePropagation.
        // Como rede de segurança aqui, também verificamos o estado global.
        if (isChannelBrowserOpen) {
          return;
        }
        setIsChannelBrowserOpen(false);
        setFocusedId(null);
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

      if (isSideMenuExpandedRef.current) {
        handleSideMenuExpandedChange(false);
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
  }, [playingMedia, isDetailsVisible, gridCategory, isSettingsVisible, setPlayerMode, setIsSettingsVisible, activeFilter, setActiveFilter, handleSideMenuExpandedChange, isTvMode, setFocusedId, isChannelBrowserOpen, setIsChannelBrowserOpen]);

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

    if (!initialFocusSetRef.current && isInterfaceReadyForFocus && isHomeNavActive) {
      // Pequeno delay para garantir que o React e a FlatList comitaram os nós no DOM (paint)
      const timeoutId = setTimeout(() => {
        const activeNavId = (document.activeElement as HTMLElement | null)?.dataset?.navId;
        if (!activeNavId) {
          setFocusedId('hero-play');
        }
      }, 150);

      initialFocusSetRef.current = true;
      return () => clearTimeout(timeoutId);
    }
  }, [isTvMode, isInterfaceReadyForFocus, isHomeNavActive, setFocusedId]);

  const layout = useResponsiveLayout();
  const { isTvProfile } = layout;
  const sideMenuCollapsedWidth = layout.sideRailCollapsedWidth || SIDEMENU_COLLAPSED_WIDTH;
  const shouldRenderSideMenu = !layout.isMobile || layout.isTvProfile;
  const isFullscreenPlayerActive = Boolean(activeVideoUrl && playerMode === 'fullscreen');
  const shouldKeepLiveSessionOnClose = false;
  const shouldShowSideMenu = shouldRenderSideMenu && !isFullscreenPlayerActive;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activePlayerRef = useRef<VideoPlayerHandle | null>(null);
  const hasRequestedInitialPlaylistRef = useRef(false);
  const wasPlayingRef = useRef(false);
  const autoRotateResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref estável para o rowVirtualizer — permite uso em callbacks declarados antes da criação do virtualizer
  const rowVirtualizerRef = useRef<any>(null);
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

  const playableCatalogLookup = useMemo(
    () => buildPlayableCatalogLookup(catalogPreviewCategories),
    [catalogPreviewCategories],
  );

  useEffect(() => {
    searchResultsCacheRef.current.clear();
  }, [catalogPreviewCategories.length]);

  useEffect(() => {
    if (!isTMDBConfigured()) {
      setHomeTMDBHeroItems([]);
      setHomeTMDBMoviesWeekCategory(null);
      setHomeTMDBSeriesWeekCategory(null);
      setHomeTMDBMoviesComingSoonCategory(null);
      setHomeTMDBSeriesComingSoonCategory(null);
      setHomeTMDBMetadataByKey({});
      return;
    }

    let cancelled = false;

    const loadTMDBHomeFeed = async () => {
      try {
        const [moviesWeek, seriesWeek, mixedDay] = await Promise.all([
          fetchTMDBTrending('movie', 'week', { limit: TMDB_HOME_ROW_LIMIT }),
          fetchTMDBTrending('tv', 'week', { limit: TMDB_HOME_ROW_LIMIT }),
          fetchTMDBTrending('all', 'day', { limit: TMDB_HOME_HERO_LIMIT * 2 }),
        ]);

        if (cancelled) return;

        const metadataByKey: Record<string, TMDBData> = {};

        const mapTrendingCollection = (
          source: TMDBTrendingItem[],
          categoryLabel: string,
        ) => {
          const playable: Media[] = [];
          const comingSoon: Media[] = [];

          for (const trendingItem of source) {
            const matched = resolvePlayableMatchFromTrending(trendingItem, playableCatalogLookup);
            const merged = matched
              ? mergeTrendingWithPlayableMedia(matched, trendingItem, categoryLabel)
              : buildTMDBTrendingMedia(trendingItem, categoryLabel);

            metadataByKey[merged.id] = buildTMDBTrendingMetadata(trendingItem);
            if (matched) {
              playable.push(merged);
            } else {
              comingSoon.push(merged);
            }
          }

          return {
            playable: dedupeTMDBTrendingMedia(playable),
            comingSoon: dedupeTMDBTrendingMedia(comingSoon),
          };
        };

        const movieMapped = mapTrendingCollection(moviesWeek, 'TMDB - Filmes em tendencia');
        const seriesMapped = mapTrendingCollection(seriesWeek, 'TMDB - Series em tendencia');
        const heroDayMapped = mapTrendingCollection(mixedDay, 'TMDB - Em alta hoje');

        const movieItems = movieMapped.playable.slice(0, TMDB_HOME_ROW_LIMIT);
        const seriesItems = seriesMapped.playable.slice(0, TMDB_HOME_ROW_LIMIT);
        const targetYear = 2026;
        const movieItems2026 = movieMapped.playable
          .filter((item) => Number(item.year || 0) === targetYear)
          .slice(0, TMDB_HOME_ROW_LIMIT);
        const seriesItems2026 = seriesMapped.playable
          .filter((item) => Number(item.year || 0) === targetYear)
          .slice(0, TMDB_HOME_ROW_LIMIT);
        const movieItemsPrimary = movieItems2026.length > 0 ? movieItems2026 : movieItems;
        const seriesItemsPrimary = seriesItems2026.length > 0 ? seriesItems2026 : seriesItems;

        const movieComingSoonItems = movieMapped.comingSoon.slice(0, TMDB_HOME_ROW_LIMIT);
        const seriesComingSoonItems = seriesMapped.comingSoon.slice(0, TMDB_HOME_ROW_LIMIT);

        const heroPlayableItems = heroDayMapped.playable.slice(0, TMDB_HOME_HERO_LIMIT);
        const heroFallbackPlayable = dedupeTMDBTrendingMedia([...movieItems, ...seriesItems]).slice(0, TMDB_HOME_HERO_LIMIT);
        const heroComingSoonFallback = heroDayMapped.comingSoon.slice(0, Math.min(6, TMDB_HOME_HERO_LIMIT));

        const heroItems =
          heroPlayableItems.length > 0
            ? heroPlayableItems
            : heroFallbackPlayable.length > 0
              ? heroFallbackPlayable
              : heroComingSoonFallback;

        setHomeTMDBHeroItems(heroItems);
        setHomeTMDBMoviesWeekCategory(
          movieItemsPrimary.length > 0
            ? {
                id: 'home-tmdb-trending-movies-week',
                title: 'Filmes em Tendencia (2026)',
                type: 'movie',
                items: movieItemsPrimary,
              }
            : null,
        );
        setHomeTMDBSeriesWeekCategory(
          seriesItemsPrimary.length > 0
            ? {
                id: 'home-tmdb-trending-series-week',
                title: 'Series em Tendencia (2026)',
                type: 'series',
                items: seriesItemsPrimary,
              }
            : null,
        );
        setHomeTMDBMoviesComingSoonCategory(
          movieComingSoonItems.length > 0
            ? {
                id: 'home-tmdb-coming-soon-movies-week',
                title: 'Lançamentos - Breve',
                type: 'movie',
                items: movieComingSoonItems,
              }
            : null,
        );
        setHomeTMDBSeriesComingSoonCategory(
          seriesComingSoonItems.length > 0
            ? {
                id: 'home-tmdb-coming-soon-series-week',
                title: 'Séries - Breve',
                type: 'series',
                items: seriesComingSoonItems,
              }
            : null,
        );
        setHomeTMDBMetadataByKey(metadataByKey);
      } catch (error) {
        if (cancelled) return;
        console.warn('[HomeScreen][TMDB] Falha ao carregar tendencias:', error);
        setHomeTMDBHeroItems([]);
        setHomeTMDBMoviesWeekCategory(null);
        setHomeTMDBSeriesWeekCategory(null);
        setHomeTMDBMoviesComingSoonCategory(null);
        setHomeTMDBSeriesComingSoonCategory(null);
        setHomeTMDBMetadataByKey({});
      }
    };

    void loadTMDBHomeFeed();

    return () => {
      cancelled = true;
    };
  }, [catalogPreviewCategories.length, playableCatalogLookup]);

  const heroCandidates = useMemo(() => {
    if (!isHeroRandomFilter) return [];

    if (activeFilter === 'home' && homeTMDBHeroItems.length > 0) {
      return homeTMDBHeroItems;
    }

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
  }, [activeFilter, filteredCategories, homeTMDBHeroItems, isHeroRandomFilter]);

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
    return heroPreloadedTMDB[key] || homeTMDBMetadataByKey[key] || null;
  }, [heroDisplayMedia, heroPreloadedTMDB, homeTMDBMetadataByKey]);

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
    const playableUrl = String(media.videoUrl || '').trim();
    if (!playableUrl) {
      setDetailsMedia(media);
      setIsDetailsVisible(true);
      return;
    }

    clearAutoRotateResumeTimer();
    setIsChannelBrowserOpen(false);
    setFocusedId(null);
    if (media.type === 'live') {
      setLastClosedLiveMedia(media);
    } else {
      setLastClosedLiveMedia(null);
    }
    setPlayingMedia(media);
    setActiveVideoUrl(playableUrl);
    setVideoType(media.type as any);
    setIsAutoRotating(false);
    setIsDetailsVisible(false);
    setPlayerMode('fullscreen');
  }, [clearAutoRotateResumeTimer, setFocusedId, setIsChannelBrowserOpen, setDetailsMedia, setPlayerMode]);

  const closeActivePlayer = useCallback(() => {
    const closedLiveMedia = videoType === 'live' ? playingMedia : null;
    setIsChannelBrowserOpen(false);
    setFocusedId(null);
    setActiveVideoUrl(null);
    setPlayingMedia(null);
    setVideoType(null);
    if (closedLiveMedia) {
      setLastClosedLiveMedia(closedLiveMedia);
    }
    setPlayerMode('closed');
    scheduleHeroAutoRotateResume(layout.isTvProfile ? 9000 : 6000);
  }, [layout.isTvProfile, playingMedia, scheduleHeroAutoRotateResume, setFocusedId, setIsChannelBrowserOpen, setPlayerMode, videoType]);

  const handleMediaPress = useCallback((media: Media) => {
    if (media.type === 'live') {
      handlePlay(media);
    } else {
      setDetailsMedia(media);
      setIsDetailsVisible(true);
    }
  }, [handlePlay]);

  const closeGridCategory = useCallback(() => {
    setGridCategory(null);
  }, []);

  const handleGridSelectMedia = useCallback((media: Media) => {
    setGridCategory(null);
    handleMediaPress(media);
  }, [handleMediaPress]);

  const handleHeroInfo = useCallback((media: Media) => {
    setDetailsMedia(media);
    setIsDetailsVisible(true);
  }, []);

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
      scrollRef.current.scrollTo({ top: 0, behavior: 'auto' });
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

  const handleCategoryMediaFocus = useCallback((_: Media, id: string) => {
    setIsAutoRotating(false);
    scheduleHeroAutoRotateResume(layout.isTvProfile ? 10000 : 7000);

    if (!layout.isTvProfile || typeof document === 'undefined') return;

    const virtualizer = rowVirtualizerRef.current;
    if (!virtualizer) return;

    // Extrair o rowIndex do navId (ex: "item-2-5" -> 2)
    const match = id.match(/item-(\d+)-/);
    if (match) {
      const rowIndex = parseInt(match[1], 10);
      // No rowVirtualizer, o index 0 é o Hero, então as categorias começam em 1.
      virtualizer.scrollToIndex(rowIndex + 1, { 
        align: 'center',
        behavior: 'auto' 
      });
    }
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

  // Removed onHeroSideNavigate to allow normal D-Pad navigation between Hero buttons

  const handleHeroPrev = useCallback(() => moveHeroSelection('prev'), [moveHeroSelection]);
  const handleHeroNext = useCallback(() => moveHeroSelection('next'), [moveHeroSelection]);

  useEffect(() => {
    return () => {
      clearAutoRotateResumeTimer();
    };
  }, [clearAutoRotateResumeTimer]);

  const preparedCategoriesWithArtwork = useMemo(
    () =>
      filteredCategories
        .map((category) => {
          const candidateItems = category.items.slice(0, HOME_CATEGORY_RANK_CANDIDATE_LIMIT);
          const rankedItems = candidateItems
          .map((item, originalIndex) => {
            const mediaKey = getHeroMediaKey(item);
            const metadata = mediaKey ? cardPreloadedTMDB[mediaKey] : null;
            const hasArtwork =
              item.type === 'live'
              || hasUsefulArtworkUrl(item.thumbnail)
              || hasUsefulArtworkUrl(item.backdrop)
              || hasUsefulArtworkUrl(metadata?.thumbnail)
              || hasUsefulArtworkUrl(metadata?.backdrop);
            return {
              item,
              originalIndex,
              rankScore: getTMDBRankingScore(metadata),
              hasArtwork,
            };
          })
          .sort((left, right) => {
            if (left.hasArtwork !== right.hasArtwork) {
              return Number(right.hasArtwork) - Number(left.hasArtwork);
            }

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
        .filter((category) => category.items.length > 0),
    [cardPreloadedTMDB, filteredCategories],
  );

  const categoriesWithCoverCards = useMemo(() => {
    if (activeFilter === 'live' || activeFilter === 'search') {
      return filteredCategories;
    }

    const preparedCategories = preparedCategoriesWithArtwork;
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
  }, [activeFilter, filteredCategories, preparedCategoriesWithArtwork]);

  const categoriesForRows = useMemo(() => {
    if (activeFilter !== 'home') {
      return categoriesWithCoverCards;
    }

    const tmdbWeeklyRows: Category[] = [
      homeTMDBMoviesWeekCategory,
      homeTMDBSeriesWeekCategory,
      homeTMDBMoviesComingSoonCategory,
      homeTMDBSeriesComingSoonCategory,
    ].filter((category): category is Category => Boolean(category && category.items.length > 0));

    const categoriesBase = categoriesWithCoverCards.filter((category) => {
      const normalizedTitle = normalizeCategoryLabel(category.title);
      return (
        category.id !== 'home-favorites'
        && category.id !== 'home-top-rated-lancamentos'
        && category.id !== 'home-tmdb-trending-movies-week'
        && category.id !== 'home-tmdb-trending-series-week'
        && category.id !== 'home-tmdb-coming-soon-movies-week'
        && category.id !== 'home-tmdb-coming-soon-series-week'
        && normalizedTitle !== 'meus favoritos'
        && normalizedTitle !== 'mais conceituados tmdb lancamentos'
      );
    });

    let withFavorites = [...tmdbWeeklyRows, ...categoriesBase];
    if (favoriteItems.length > 0) {
      const favoritesCategory: Category = {
        id: 'home-favorites',
        title: 'Meus Favoritos',
        type: 'movie',
        items: favoriteItems,
      };
      const favoritesInsertIndex = Math.min(
        Math.max(tmdbWeeklyRows.length, 2),
        withFavorites.length,
      );
      withFavorites = [
        ...withFavorites.slice(0, favoritesInsertIndex),
        favoritesCategory,
        ...withFavorites.slice(favoritesInsertIndex),
      ];
    }

    const mergedMetadataByKey: Record<string, TMDBData> = {
      ...cardPreloadedTMDB,
      ...heroPreloadedTMDB,
      ...homeTMDBMetadataByKey,
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

    const topRatedInsertIndex = Math.min(
      Math.max(3, tmdbWeeklyRows.length + (favoriteItems.length > 0 ? 1 : 0)),
      withFavorites.length,
    );
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
    homeTMDBMetadataByKey,
    homeTMDBMoviesComingSoonCategory,
    homeTMDBMoviesWeekCategory,
    homeTMDBSeriesComingSoonCategory,
    homeTMDBSeriesWeekCategory,
    heroPreloadedTMDB,
  ]);

  // P0/Otimização: Virtualizador de linhas movido para o nível do HomeScreen
  // para permitir controle centralizado de scroll via D-Pad (scrollToIndex).
  const viewportWidth = Math.max(layout.contentMaxWidth || layout.width, layout.width);
  const baseHeroEstimatedHeight = Math.round(
    Math.min(
      layout.heroHeightMax,
      Math.max(layout.heroMinHeight, viewportWidth * layout.heroHeightRatio),
    ),
  );
  const heroEstimatedHeight = layout.isTvProfile
    ? Math.max(420, Math.min(baseHeroEstimatedHeight, Math.round(layout.height * 0.92)))
    : baseHeroEstimatedHeight;

  // P0: Calcula o tamanho EXATO de cada linha para evitar "pulos" de reajuste do virtualizador.
  // Utiliza a exata mesma lógica do componente CategoryRow.tsx para garantir 100% de precisão.
  const getExactRowHeight = useCallback((index: number) => {
    if (index === 0) return heroEstimatedHeight;
    const category = categoriesForRows[index - 1];
    if (!category) return layout.isTvProfile ? 460 : 360;

    const titleLower = category.title.toLowerCase();
    const isLiveRow = category.type === 'live' || titleLower.includes('canais') || titleLower.includes('ao vivo');
    
    const cardWidth = layout.isTvProfile
      ? (isLiveRow ? 360 : 240)
      : (layout.isCompact ? (isLiveRow ? 320 : 210) : (isLiveRow ? 360 : 230));
      
    const cardHeight = isLiveRow ? Math.round(cardWidth * (9 / 16)) : Math.round(cardWidth * 1.5);
    const rowHeight = cardHeight + (layout.isTvProfile ? 100 : 140);
    
    return rowHeight;
  }, [categoriesForRows, heroEstimatedHeight, layout]);

  const rowVirtualizer = useVirtualizer({
    count: categoriesForRows.length + 1, // +1 for Hero
    getScrollElement: () => scrollRef.current,
    estimateSize: getExactRowHeight,
    overscan: layout.isTvProfile ? 30 : 10,
  });
  // Sincroniza ref para uso em callbacks declarados antes desta linha
  rowVirtualizerRef.current = rowVirtualizer;

  const searchResultCount = useMemo(
    () => categoriesForRows.reduce((acc, category) => acc + category.items.length, 0),
    [categoriesForRows],
  );
  const searchInsetLeft = (shouldRenderSideMenu ? sideMenuCollapsedWidth : 0) + (layout.isTvProfile ? 24 : 20);
  const searchInsetRight = layout.isTvProfile ? 28 : 20;
  const virtualKeyboardRows = useMemo(
    () => {
      const rows =
        searchKeyboardMode === 'abnt2'
          ? [
              ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
              ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ç'],
              ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '?'],
              ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
            ]
          : [
              ['á', 'à', 'â', 'ã', 'é', 'ê', 'í', 'ó', 'ô', 'õ'],
              ['ú', 'ü', 'ç', '!', '?', '@', '#', '$', '%', '&'],
              ['(', ')', '[', ']', '{', '}', '/', '\\', '+', '='],
              ['-', '_', '"', '\'', ';', ':', ',', '.', '~', '`'],
            ];

      if (searchKeyboardMode !== 'abnt2' || !searchKeyboardShift) {
        return rows;
      }

      return rows.map((row) =>
        row.map((keyLabel) => (/^[a-zç]$/.test(keyLabel) ? keyLabel.toLocaleUpperCase('pt-BR') : keyLabel)),
      );
    },
    [searchKeyboardMode, searchKeyboardShift],
  );

  const appendSearchCharacter = useCallback((character: string) => {
    setSearchQuery(`${searchQuery}${character}`);
  }, [searchQuery, setSearchQuery]);

  const removeLastSearchCharacter = useCallback(() => {
    setSearchQuery(searchQuery.slice(0, -1));
  }, [searchQuery, setSearchQuery]);
  const toggleSearchKeyboardMode = useCallback(() => {
    setSearchKeyboardMode((previousMode) => (previousMode === 'abnt2' ? 'special' : 'abnt2'));
  }, []);
  const toggleSearchKeyboardShift = useCallback(() => {
    if (searchKeyboardMode !== 'abnt2') return;
    setSearchKeyboardShift((previousShift) => !previousShift);
  }, [searchKeyboardMode]);
  const searchQueryNormalized = searchQuery.trim();
  const searchCacheKey = useMemo(
    () => normalizeSearchCacheKey(searchQueryNormalized),
    [searchQueryNormalized],
  );

  useEffect(() => {
    if (activeFilter !== 'search') {
      setSearchCatalogItems([]);
      setIsSearchCatalogLoading(false);
      return;
    }

    if (!searchCacheKey) {
      setSearchCatalogItems([]);
      setIsSearchCatalogLoading(false);
      return;
    }

    const cached = searchResultsCacheRef.current.get(searchCacheKey);
    if (cached) {
      setSearchCatalogItems(cached);
      setIsSearchCatalogLoading(false);
      return;
    }

    const requestId = searchCatalogRequestRef.current + 1;
    searchCatalogRequestRef.current = requestId;
    setIsSearchCatalogLoading(true);

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const isTvProfile = layout.isTvProfile;
          const results = await searchChannelsByQuery(searchQueryNormalized, {
            limit: isTvProfile ? 1200 : 4000,
            types: ['movie', 'series'],
            yieldEveryRows: isTvProfile ? 700 : 2600,
            shouldAbort: () => searchCatalogRequestRef.current !== requestId,
          });
          if (searchCatalogRequestRef.current !== requestId) return;

          const nextCache = searchResultsCacheRef.current;
          nextCache.set(searchCacheKey, results);
          if (nextCache.size > 24) {
            const oldestKey = nextCache.keys().next().value;
            if (oldestKey) nextCache.delete(oldestKey);
          }
          setSearchCatalogItems(results);
        } catch (error) {
          if (searchCatalogRequestRef.current !== requestId) return;
          console.warn('[Search] Falha ao consultar catalogo completo:', error);
          setSearchCatalogItems([]);
        } finally {
          if (searchCatalogRequestRef.current === requestId) {
            setIsSearchCatalogLoading(false);
          }
        }
      })();
    }, layout.isTvProfile ? 210 : 130);

    return () => window.clearTimeout(timeoutId);
  }, [
    activeFilter,
    isBackgroundSyncing,
    isWritingDatabase,
    layout.isTvProfile,
    searchCacheKey,
    searchQueryNormalized,
  ]);

  const searchFilteredItems = useMemo(() => {
    if (!searchQueryNormalized) return [];
    return searchCatalogItems;
  }, [searchCatalogItems, searchQueryNormalized]);
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
  const searchRawItems = searchQueryNormalized.length > 0 ? searchFilteredItems : searchPreviewItems;
  const searchRenderLimit = layout.isTvProfile ? 220 : 520;
  const searchDisplayItems = useMemo(
    () => searchRawItems.slice(0, searchRenderLimit),
    [searchRawItems, searchRenderLimit],
  );
  const searchDisplayCount = searchRawItems.length;
  const isSearchDisplayTruncated = searchDisplayItems.length < searchDisplayCount;

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
    if (!import.meta.env.DEV) return;
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

  // Foco inicial quando a interface carrega ou troca de categoria.
  // Sempre rouba o foco para o conteúdo principal para fechar/desativar a sidebar automaticamente.
  useEffect(() => {
    if (!loading && isTvMode && isHomeNavActive) {
      // Tenta focar imediatamente e depois com delay para garantir que o componente montou
      const focusHero = () => {
        if (activeFilter === 'live' || activeFilter === 'sports') {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        } else {
          setFocusedId('hero-play');
        }
      };

      focusHero();
      const initTimer = setTimeout(focusHero, 800);
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
    const isSourceOffline = playlistError?.message?.includes('Fonte de Sinal') 
      || playlistError?.details?.includes('não respondeu')
      || playlistError?.details?.includes('tempo limite')
      || playlistError?.details?.includes('Tempo limite');
    
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#050505',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          padding: 24,
        }}
      >
        {/* Glow background */}
        <div
          style={{
            position: 'absolute',
            width: '50vw',
            height: '50vw',
            background: isSourceOffline
              ? 'radial-gradient(circle, rgba(239,68,68,0.08) 0%, transparent 70%)'
              : 'radial-gradient(circle, rgba(229,9,20,0.1) 0%, transparent 70%)',
            filter: 'blur(100px)',
            zIndex: 0,
          }}
        />

        <div
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            maxWidth: 520,
            width: '100%',
          }}
        >
          {/* Icon */}
          <motion.div
            animate={{
              scale: [1, 1.08, 1],
              opacity: [0.6, 1, 0.6],
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
            style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              background: isSourceOffline
                ? 'linear-gradient(135deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05))'
                : 'linear-gradient(135deg, rgba(229,9,20,0.15), rgba(229,9,20,0.05))',
              border: `2px solid ${isSourceOffline ? 'rgba(239,68,68,0.25)' : 'rgba(229,9,20,0.25)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 24,
            }}
          >
            {isSourceOffline ? (
              <WifiOff size={36} color="#f87171" strokeWidth={2} />
            ) : (
              <Radio size={36} color="#E50914" strokeWidth={2} />
            )}
          </motion.div>

          {/* Title */}
          <h1
            style={{
              margin: 0,
              fontSize: 28,
              fontWeight: 900,
              fontFamily: 'Outfit, sans-serif',
              color: 'white',
              textAlign: 'center',
              letterSpacing: -0.5,
            }}
          >
            {isSourceOffline ? 'Fonte de Sinal Indisponível' : (playlistError?.message || 'Falha ao Carregar Catálogo')}
          </h1>

          {/* Subtitle */}
          <p
            style={{
              margin: '12px 0 0',
              fontSize: 15,
              fontFamily: 'Outfit, sans-serif',
              color: 'rgba(255,255,255,0.55)',
              textAlign: 'center',
              lineHeight: '22px',
              maxWidth: 440,
            }}
          >
            {isSourceOffline
              ? 'O servidor do seu provedor IPTV não respondeu. Isso geralmente indica que a fonte está fora do ar ou em manutenção temporária.'
              : (playlistError?.details || 'Não foi possível carregar sua lista agora. Verifique a conexão e tente novamente.')}
          </p>

          {/* Technical details card */}
          {playlistError?.details && (
            <div
              style={{
                marginTop: 20,
                width: '100%',
                maxWidth: 440,
                backgroundColor: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 12,
                padding: '12px 16px',
              }}
            >
              <span
                style={{
                  display: 'block',
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: 'Outfit, sans-serif',
                  color: 'rgba(255,255,255,0.3)',
                  textTransform: 'uppercase',
                  letterSpacing: 1.5,
                  marginBottom: 6,
                }}
              >
                Detalhes Técnicos
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontFamily: 'monospace',
                  color: 'rgba(255,255,255,0.45)',
                  lineHeight: '17px',
                  wordBreak: 'break-word',
                }}
              >
                {playlistError.details}
              </span>
            </div>
          )}

          {/* Action Buttons — D-Pad Navigable */}
          <div
            style={{
              marginTop: 32,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              width: '100%',
              maxWidth: 340,
            }}
          >
            <button
              data-nav-id="error-retry"
              tabIndex={0}
              autoFocus
              onClick={handleRetryPlaylist}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || (e as any).keyCode === 23 || (e as any).keyCode === 66) {
                  e.preventDefault();
                  handleRetryPlaylist();
                }
              }}
              style={{
                backgroundColor: '#E50914',
                borderRadius: 12,
                padding: '14px 24px',
                border: '2px solid transparent',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'white'; e.currentTarget.style.transform = 'scale(1.03)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}
            >
              <RotateCcw size={18} color="white" />
              <span style={{ color: 'white', fontSize: 16, fontWeight: 800, fontFamily: 'Outfit, sans-serif' }}>
                Tentar Novamente
              </span>
            </button>

            <button
              data-nav-id="error-logout"
              tabIndex={0}
              onClick={onLogout}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || (e as any).keyCode === 23 || (e as any).keyCode === 66) {
                  e.preventDefault();
                  onLogout?.();
                }
              }}
              style={{
                backgroundColor: 'rgba(255,255,255,0.06)',
                borderRadius: 12,
                padding: '14px 24px',
                border: '2px solid rgba(255,255,255,0.1)',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#f87171'; e.currentTarget.style.transform = 'scale(1.03)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.transform = 'scale(1)'; }}
            >
              <LogOut size={18} color="#f87171" />
              <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 15, fontWeight: 700, fontFamily: 'Outfit, sans-serif' }}>
                Sair da Sessão
              </span>
            </button>
          </div>

          {/* Brand footer */}
          <span
            style={{
              marginTop: 40,
              fontSize: 10,
              fontFamily: 'Outfit, sans-serif',
              color: 'rgba(255,255,255,0.15)',
              fontWeight: 900,
              textTransform: 'uppercase',
              letterSpacing: 3,
              fontStyle: 'italic',
            }}
          >
            XANDEFLIX
          </span>
        </div>
      </div>
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
  const shouldBlockBaseInteractions = isDetailsVisible || !!gridCategory || isSettingsVisible;
  const shouldDisableSideMenu = isSettingsVisible;
  const centeredContentMaxWidth = layout.isTvProfile
    ? null
    : null; // No centering on TV for full-bleed Hero appearance
  const isDetailsPageMode = Boolean(isDetailsVisible && detailsMedia);
  const homeLogoSize = layout.isTvProfile
    ? Math.max(24, Math.min(34, Math.round(layout.width * 0.021)))
    : 22;
  const shouldHideBaseContent = isFullscreenPlayerActive;

  return (
    <View style={styles.container}>
      {!hasBlockingPlaylistError && (
      <View
        style={{ flex: 1, flexDirection: 'row', width: '100%', height: '100%' }}
      >
        {/* Sidebar Navigation - Fixed Rail */}
        {shouldShowSideMenu && (
          <div
            aria-hidden={shouldDisableSideMenu}
            style={{ pointerEvents: shouldDisableSideMenu ? 'none' : 'auto' }}
          >
            <SideMenu
              onSelect={handleCategorySelect}
              activeId={activeFilter}
              onLogout={onLogout}
              onExpandedChange={handleSideMenuExpandedChange}
            />
          </div>
        )}

        {/* Main Content Area */}
        <div
          aria-hidden={shouldBlockBaseInteractions || shouldHideBaseContent}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            marginLeft: 0,
            pointerEvents: shouldBlockBaseInteractions || shouldHideBaseContent ? 'none' : 'auto',
            visibility: shouldHideBaseContent ? 'hidden' : 'visible',
          }}
        >
        <View style={{ flex: 1 }}>
          {activeFilter === 'live' || activeFilter === 'sports' ? (
            <Suspense fallback={<LoadingScreen />}>
              <LiveTVGrid
                categories={filteredCategories}
                onPlayFull={handlePlay}
                layout={layout}
                externalMedia={playingMedia?.type === 'live' ? playingMedia : lastClosedLiveMedia}
                isGlobalPlayerActive={!!activeVideoUrl}
                section={activeFilter}
                isCatalogSyncing={isWritingDatabase || isBackgroundSyncing}
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
                          {row.map((keyLabel, keyIndex) => (
                            <button
                              key={`vk-key-${rowIndex}-${keyIndex}-${keyLabel}`}
                              ref={(el) => registerNode(`search-key-${rowIndex}-${keyIndex}`, el, 'body', {
                                onEnter: () => appendSearchCharacter(keyLabel)
                              })}
                              data-nav-id={`search-key-${rowIndex}-${keyIndex}`}
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
                              {keyLabel}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 10 }}>
                      <button
                        ref={(el) => registerNode(`search-key-mode`, el, 'body', { onEnter: toggleSearchKeyboardMode })}
                        data-nav-id="search-key-mode"
                        onClick={toggleSearchKeyboardMode}
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
                        {searchKeyboardMode === 'abnt2' ? '#+=' : 'ABC'}
                      </button>
                      <button
                        ref={(el) => registerNode(`search-key-shift`, el, 'body', { onEnter: toggleSearchKeyboardShift })}
                        data-nav-id="search-key-shift"
                        onClick={toggleSearchKeyboardShift}
                        style={{
                          height: 36,
                          borderRadius: 8,
                          border: '1px solid rgba(255,255,255,0.15)',
                          background: searchKeyboardMode === 'abnt2' && searchKeyboardShift
                            ? 'rgba(229,9,20,0.22)'
                            : 'rgba(255,255,255,0.1)',
                          color: 'white',
                          fontWeight: 800,
                          cursor: searchKeyboardMode === 'abnt2' ? 'pointer' : 'not-allowed',
                          opacity: searchKeyboardMode === 'abnt2' ? 1 : 0.55,
                        }}
                      >
                        Shift
                      </button>
                      <button
                        ref={(el) => registerNode(`search-key-backspace`, el, 'body', { onEnter: removeLastSearchCharacter })}
                        data-nav-id="search-key-backspace"
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
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginTop: 8 }}>
                      <button
                        ref={(el) => registerNode(`search-key-space`, el, 'body', { onEnter: () => appendSearchCharacter(' ') })}
                        data-nav-id="search-key-space"
                        onClick={() => appendSearchCharacter(' ')}
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
                        Espaço
                      </button>
                      <button
                        ref={(el) => registerNode(`search-key-clear`, el, 'body', { onEnter: () => setSearchQuery('') })}
                        data-nav-id="search-key-clear"
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
                        {isSearchDisplayTruncated
                          ? `${searchDisplayItems.length} de ${searchDisplayCount} itens`
                          : `${searchDisplayCount} itens`}
                      </span>
                    </div>

                    {searchDisplayCount === 0 ? (
                      <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 15 }}>
                        {searchQueryNormalized.length > 0 && isSearchCatalogLoading
                          ? 'Buscando em todo o acervo de filmes e séries...'
                          : 'Nenhum conteúdo encontrado.'}
                      </div>
                    ) : (
                      <>
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
                              ref={(el) => registerNode(`search-grid-${item.id}-${index}`, el, 'body', {
                                onEnter: () => handleMediaPress(item)
                              })}
                              data-nav-id={`search-grid-${item.id}-${index}`}
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
                        {isSearchDisplayTruncated && (
                          <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 12, marginTop: 12 }}>
                            Mostrando os primeiros resultados para manter a navegacao fluida neste dispositivo.
                          </div>
                        )}
                      </>
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
                  isHeroVisibleInList={isHeroVisibleInList && !isDetailsVisible && !gridCategory && !isSettingsVisible && !isFullscreenPlayerActive}
                  handlePlay={handlePlay}
                  onHeroPrev={handleHeroPrev}
                  onHeroNext={handleHeroNext}
                  heroPaginationIndex={heroPaginationState.index}
                  heroPaginationTotal={heroPaginationState.total}
                  canHeroPaginate={heroSelectionCandidates.length > 1}
                  onTrailerError={handleTrailerError}
                  handleHeroInfo={handleHeroInfo}
                  rowVirtualizer={rowVirtualizer}
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
              <Text style={[styles.logo, { fontSize: homeLogoSize, letterSpacing: layout.isTvProfile ? -1.2 : -1, opacity: 0.92 }]}>XANDEFLIX</Text>
            </View>
          )}
        </View>
        </div>
      </View>
     )}

      <AnimatePresence>
        {isDetailsPageMode && detailsMedia && (
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
              sideMenuOffset={
                shouldShowSideMenu
                  ? sideMenuCollapsedWidth
                  : 0
              }
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
              <motion.div
                key={`fullscreen-${activeVideoUrl}`}
                initial={{ opacity: 0, scale: 0.99 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.99 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1600,
                  backgroundColor: '#000',
                  overflow: 'hidden',
                }}
              >
                <VideoPlayer
                  ref={activePlayerRef}
                  url={activeVideoUrl}
                  mediaType={videoType || 'live'}
                media={playingMedia}
                nextEpisode={nextEpisode}
                onPlayNextEpisode={nextEpisode ? () => handlePlay(nextEpisode) : undefined}
                  onClose={closeActivePlayer}
                  suppressNativePreviewExitOnUnmount={shouldKeepLiveSessionOnClose}
                  isMinimized={false}
                  isPreview={false}
                  isBrowseMode={videoType === 'live'}
                  showChannelSidebar={videoType === 'live'}
                  channelBrowserCategories={filteredCategories}
                  onZap={handlePlay}
                />
              </motion.div>
            )}
          </Suspense>
        )}
      </AnimatePresence>

      <Suspense fallback={null}>
        {gridCategory && (
          <CategoryGridView
            category={gridCategory}
            onClose={closeGridCategory}
            onSelectMedia={handleGridSelectMedia}
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
