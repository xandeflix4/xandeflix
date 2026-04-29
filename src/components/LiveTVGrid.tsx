import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableHighlight, Image, Dimensions } from 'react-native';
import { Radio, ChevronRight, Search, Heart, Activity, RotateCcw } from 'lucide-react';
import { Category, Media } from '../types';
import { VideoPlayer } from './VideoPlayer';
import { useStore } from '../store/useStore';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { NetworkDiagnostic } from './NetworkDiagnostic';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DISK_CATEGORY_PAGE_SIZE, useDiskCategory } from '../hooks/useDiskCategory';
import { getChannelCountByCategory, searchChannelsByQuery } from '../lib/db';

interface LiveItemThumbnailProps {
  uri: string;
}

const LiveItemThumbnail: React.FC<LiveItemThumbnailProps> = ({ uri }) => {
  const [loaded, setLoaded] = useState(false);
  return (
    <View style={[{ width: '100%', height: '100%', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 4, overflow: 'hidden' }, !loaded && { backgroundColor: '#1a1a1a' }]}>
      <Image
        source={{ uri }}
        style={[{ width: '100%', height: '100%', opacity: 0 }, loaded && { opacity: 1 }]}
        onLoad={() => setLoaded(true)}
      />
      {!loaded && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,255,255,0.05)' }]} />
      )}
    </View>
  );
};

interface LiveTVGridProps {
  categories: Category[];
  onPlayFull: (media: Media) => void;
  layout: any;
  externalMedia?: Media | null;
  isGlobalPlayerActive?: boolean;
  section?: string;
  isCatalogSyncing?: boolean;
}

const ChannelProgramDisplay = React.memo(({
  programs,
  now
}: {
  programs: any[],
  now: number
}) => {
  const currentProgram = useMemo(
    () => programs.find((program) => now >= program.start && now < program.stop) || null,
    [now, programs]
  );

  if (!currentProgram) return null;

  return (
    <Text style={styles.channelProgram} numberOfLines={1}>
      {currentProgram.title}
    </Text>
  );
});

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
type LiveTvFocusColumn = 'groups' | 'channels' | 'preview';
type LivePreviewPoolEntry = {
  media: Media;
  categoryId: string;
};

const GROUP_SELECTION_THROTTLE_MS = 180;
const LIVE_CHANNEL_ROW_ESTIMATE = 88;

const normalizeLiveSearchKey = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const normalizeLiveCategoryKey = (value: string): string =>
  normalizeLiveSearchKey(value)
    .replace(/^canais\s*\|\s*/i, '')
    .replace(/^canais\s+/i, '')
    .trim();

interface GroupItemProps {
  category: Category;
  index: number;
  itemCount: number;
  isSelected: boolean;
  onPress: (category: Category, index: number) => void;
}

const GroupItem = React.memo(({
  category,
  index,
  itemCount,
  isSelected,
  onPress,
  registerNode,
  applyCategorySelection,
  setFocusColumn,
  focusGroupByIndex,
  focusedGroupIndexRef,
}: GroupItemProps & {
  registerNode: any,
  applyCategorySelection: any,
  setFocusColumn: any,
  focusGroupByIndex: any,
  focusedGroupIndexRef: any,
}) => {
  useEffect(() => {
    return registerNode(`tv-group-${category.id}`, null, 'body', {
      onFocus: () => {
        // P0/P2: Foco visual via CSS nativo.
        applyCategorySelection(category.id);
        focusedGroupIndexRef.current = index;
      },
      onEnter: () => {
        applyCategorySelection(category.id, { immediate: true, resetChannelIndex: true });
        setFocusColumn('channels');
      },
      onUp: () => focusGroupByIndex(index - 1),
      onDown: () => focusGroupByIndex(index + 1),
    });
  }, [category.id, index, registerNode, applyCategorySelection, setFocusColumn, focusGroupByIndex, focusedGroupIndexRef]);

  return (
    <TouchableHighlight
      id={`tv-group-${category.id}`}
      data-nav-id={`tv-group-${category.id}`}
      onPress={() => onPress(category, index)}
      underlayColor="rgba(255,255,255,0.05)"
      style={[
        styles.groupItem,
        isSelected && styles.groupItemActive,
      ]}
    >
      <View style={styles.groupItemInner}>
        <Text style={[styles.groupText, isSelected && styles.groupTextActive]}>
          {category.title.replace(/CANAIS\s*\|\s*/i, '').trim()}
        </Text>
        {isSelected && <ChevronRight size={16} color="#E50914" />}
      </View>
    </TouchableHighlight>
  );
}, (prev, next) => (
  prev.category.id === next.category.id
  && prev.isSelected === next.isSelected
));

interface ChannelItemProps {
  media: Media;
  index: number;
  isSelected: boolean;
  isFavorite: boolean;
  now: number;
  programs: any[];
  onPress: (media: Media, index: number) => void;
  onFocusMedia?: (media: Media, index: number) => void;
  onMoveToSearch?: () => void;
}

const ChannelItem = React.memo(({
  media,
  index,
  isSelected,
  isFavorite,
  now,
  programs,
  onPress,
  onFocusMedia,
  onMoveToSearch,
  registerNode,
  setFocusedId,
  focusChannelByIndex,
  previewMedia,
  selectedCatId,
  liveCategories,
  focusedChannelIndexRef,
  focusGroupByIndex,
}: ChannelItemProps & {
  registerNode: any,
  setFocusedId: any,
  focusChannelByIndex: any,
  previewMedia: any,
  selectedCatId: any,
  liveCategories: any[],
  focusedChannelIndexRef: any,
  focusGroupByIndex: any,
}) => {
  useEffect(() => {
    return registerNode(`tv-channel-${media.id}`, null, 'body', {
      onFocus: () => {
        // P0: Foco visual via CSS nativo.
        focusedChannelIndexRef.current = index;
        onFocusMedia?.(media, index);
      },
      onEnter: () => {
        onPress(media, index);
      },
      onUp: () => {
        if (index <= 0) {
          onMoveToSearch?.();
          return;
        }
        focusChannelByIndex(index - 1);
      },
      onDown: () => focusChannelByIndex(index + 1),
      onLeft: () => {
        const targetGroupId = selectedCatId || liveCategories[0]?.id;
        if (!targetGroupId) return;
        const targetIndex = liveCategories.findIndex((category) => category.id === targetGroupId);
        focusGroupByIndex(targetIndex >= 0 ? targetIndex : 0);
      },
      onRight: () => {
        if (!previewMedia) return;
        setFocusedId('tv-preview-player');
      },
    });
  }, [focusChannelByIndex, focusGroupByIndex, focusedChannelIndexRef, index, liveCategories, media, onFocusMedia, onMoveToSearch, onPress, previewMedia, registerNode, selectedCatId, setFocusedId]);

  return (
    <TouchableHighlight
      id={`tv-channel-${media.id}`}
      data-nav-id={`tv-channel-${media.id}`}
      onPress={() => onPress(media, index)}
      underlayColor="rgba(255,255,255,0.05)"
      style={[
        styles.channelItem,
        isSelected && styles.channelItemActive,
      ]}
    >
      <View style={styles.channelItemInner}>
        <View style={styles.itemThumbnailContainer}>
          <LiveItemThumbnail uri={media.thumbnail} />
          {isFavorite && (
            <View style={styles.favoriteBadge}>
              <Heart size={11} color="#ffffff" fill="#E50914" />
            </View>
          )}
          {isSelected && (
            <View style={styles.playingIndicator}>
              <View style={styles.pulse} />
            </View>
          )}
        </View>
        <View style={styles.channelInfo}>
          <Text style={[styles.channelTitle, isSelected && styles.channelTitleActive]} numberOfLines={1}>
            {media.title}
          </Text>
          <ChannelProgramDisplay programs={programs} now={now} />
        </View>
      </View>
    </TouchableHighlight>
  );
}, (prev, next) => (
  prev.media.id === next.media.id
  && prev.isSelected === next.isSelected
  && prev.isFavorite === next.isFavorite
  && prev.programs === next.programs
  && prev.now === next.now
));

export const LiveTVGrid: React.FC<LiveTVGridProps> = ({
  categories,
  onPlayFull,
  layout,
  externalMedia,
  isGlobalPlayerActive,
  section = 'live',
  isCatalogSyncing = false,
}) => {
  const favorites = useStore((state) => state.favorites);
  const epgData = useStore((state) => state.epgData);
  const setSelectedCategoryName = useStore((state) => state.setSelectedCategoryName);
  const setVisibleItems = useStore((state) => state.setVisibleItems);
  const lastLiveChannel = useStore((state) => state.lastLiveChannel);
  const setLastLiveChannel = useStore((state) => state.setLastLiveChannel);
  const fetchEPG = useStore((state) => state.fetchEPG);
  const lastEpgUrl = useStore((state) => state.lastEpgUrl);
  const isLoadingEPG = useStore((state) => state.isLoadingEPG);
  // As categorias ja chegam filtradas pelo useMediaFilter (live, sports, etc.)
  // Nao filtrar novamente por type para suportar categorias de esportes e outras
  const liveCategories = useMemo(
    () => categories,
    [categories],
  );

  // Sincronizar estado inicial com o último canal salvo imediatamente
  const initialSavedEntry = useMemo(() => {
    if (lastLiveChannel && lastLiveChannel.section === section) {
      for (const cat of categories) {
        const item = cat.items.find((i) => i.id === lastLiveChannel.mediaId);
        if (item) return { media: item, categoryId: cat.id };
      }
    }
    return null;
  }, [categories, lastLiveChannel, section]);

  const [selectedCatId, setSelectedCatId] = useState<string | null>(initialSavedEntry?.categoryId || null);
  const [page, setPage] = useState(0);
  const [categoryItems, setCategoryItems] = useState<Media[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(initialSavedEntry?.media.id || null);
  const [previewMedia, setPreviewMedia] = useState<Media | null>(initialSavedEntry?.media || null);
  const [inspectedMedia, setInspectedMedia] = useState<Media | null>(initialSavedEntry?.media || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [globalSearchItems, setGlobalSearchItems] = useState<Media[]>([]);
  const [isSearchingAllChannels, setIsSearchingAllChannels] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const openingFullscreenRef = useRef(false);
  const activePreviewChannelIdRef = useRef<string | null>(null);
  const [focusColumn, setFocusColumn] = useState<LiveTvFocusColumn>('groups');
  const [focusedGroupIndex, setFocusedGroupIndex] = useState(0);
  const [focusedChannelIndex, setFocusedChannelIndex] = useState(0);
  const focusedGroupIndexRef = useRef(0);
  const focusedChannelIndexRef = useRef(0);
  const [isDiagnosticFocused, setIsDiagnosticFocused] = useState(false);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [diskReloadToken, setDiskReloadToken] = useState(0);
  const [activeTab, setActiveTab] = useState<'epg' | 'info'>('epg');
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const previewFailureCountRef = useRef(0);
  const previousGlobalPlayerActiveRef = useRef(Boolean(isGlobalPlayerActive));
  const lastSyncedExternalMediaIdRef = useRef<string | null>(null);
  const lastSyncedExternalCategoryMediaIdRef = useRef<string | null>(null);

  // Sincronizar estado interno quando a seção muda sem unmount (Live <-> Sports)
  useEffect(() => {
    if (initialSavedEntry) {
      setSelectedCatId(initialSavedEntry.categoryId);
      setSelectedMediaId(initialSavedEntry.media.id);
      setInspectedMedia(initialSavedEntry.media);
      if (!previewMedia) {
        setPreviewMedia(initialSavedEntry.media);
      }
    } else if (liveCategories.length > 0) {
      const firstCat = liveCategories[0];
      setSelectedCatId(firstCat.id);
      setSelectedMediaId(null);
      setInspectedMedia(null);
    }

    setFocusedGroupIndex(0);
    setFocusedChannelIndex(0);
    setFocusColumn('groups');
    lastSyncedExternalMediaIdRef.current = null;
    lastSyncedExternalCategoryMediaIdRef.current = null;
    hasAppliedInitialFocusRef.current = false;
  }, [section]);
  const previewTriedKeysRef = useRef<Set<string>>(new Set());
  const previewArmRef = useRef<{ mediaId: string | null; armedAt: number }>({ mediaId: null, armedAt: 0 });
  const previewActivationGuardRef = useRef<{ mediaId: string | null; at: number }>({ mediaId: null, at: 0 });
  const hasAppliedInitialFocusRef = useRef(false);
  const wasCatalogSyncingRef = useRef<boolean>(Boolean(isCatalogSyncing));
  const groupsListRef = useRef<HTMLDivElement | null>(null);
  const channelsListRef = useRef<HTMLDivElement | null>(null);
  const groupSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestIdRef = useRef(0);
  const searchResultsCacheRef = useRef<Map<string, Media[]>>(new Map());
  const selectedCategory = useMemo(
    () => liveCategories.find((c) => c.id === selectedCatId) || null,
    [liveCategories, selectedCatId],
  );
  const normalizeChannelKey = useCallback((value: string | null | undefined) => {
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

  // OTIMIZAÇÃO FASE 3: Dicionário EPG pré-processado para busca O(1)
  const epgLookupMap = useMemo(() => {
    if (!epgData) return new Map<string, any[]>();
    const map = new Map<string, any[]>();

    Object.entries(epgData).forEach(([key, programs]) => {
      if (!programs || programs.length === 0) return;

      // 1. Chave original (ID ou Nome vindo do XML)
      const directKey = key.trim().toLowerCase();
      if (!map.has(directKey)) map.set(directKey, programs);

      // 2. Chave normalizada (Regex para remover "Canal", "HD", etc)
      const normalized = normalizeChannelKey(key);
      if (normalized && !map.has(normalized)) map.set(normalized, programs);
    });

    return map;
  }, [epgData, normalizeChannelKey]);

  const resolveProgramsForMedia = useCallback((media: Media) => {
    if (!epgData || epgLookupMap.size === 0) return [];

    // Busca direta por tvgId
    if (media.tvgId) {
      const byId = epgLookupMap.get(media.tvgId.toLowerCase());
      if (byId) return byId;
    }

    // Busca direta por tvgName
    if (media.tvgName) {
      const byName = epgLookupMap.get(media.tvgName.toLowerCase());
      if (byName) return byName;
    }

    // Busca por título normalizado (Fast O(1) lookup)
    const normalizedTitle = normalizeChannelKey(media.title);
    if (normalizedTitle) {
      const byTitle = epgLookupMap.get(normalizedTitle);
      if (byTitle) return byTitle;
    }

    return [];
  }, [epgData, epgLookupMap, normalizeChannelKey]);
  const guideMedia = inspectedMedia || previewMedia;
  const guidePrograms = useMemo(() => {
    if (!guideMedia) return [];
    return resolveProgramsForMedia(guideMedia);
  }, [guideMedia, resolveProgramsForMedia]);
  const currentPreviewProgram = useMemo(
    () => guidePrograms.find((program) => now >= program.start && now < program.stop) || null,
    [guidePrograms, now],
  );
  const upcomingPreviewPrograms = useMemo(
    () => {
      const dedupedUpcoming: any[] = [];
      const seenUpcomingKeys = new Set<string>();
      const orderedFuturePrograms = [...guidePrograms]
        .filter((program) => program.start > now)
        .sort((a, b) => a.start - b.start);

      for (const program of orderedFuturePrograms) {
        const normalizedTitle = String(program.title || '').trim().toLowerCase();
        const key = `${program.start}::${program.stop}::${normalizedTitle}`;
        if (seenUpcomingKeys.has(key)) continue;
        seenUpcomingKeys.add(key);
        dedupedUpcoming.push(program);
        if (dedupedUpcoming.length >= 4) break;
      }

      return dedupedUpcoming;
    },
    [guidePrograms, now],
  );

  const formatProgramTime = useCallback((timestamp: number) => {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }, []);
  const { items: pageItems, loading: pageLoading, hasMore: hasMorePages } = useDiskCategory(
    selectedCategory?.title || null,
    page,
    DISK_CATEGORY_PAGE_SIZE,
    diskReloadToken,
  );

  const loadMoreChannels = useCallback(() => {
    if (pageLoading || !hasMorePages) return;
    setPage((prev) => prev + 1);
  }, [hasMorePages, pageLoading]);

  const applyCategorySelection = useCallback((categoryId: string, options?: { immediate?: boolean; resetChannelIndex?: boolean }) => {
    const commit = () => {
      setSelectedCatId((previous) => (previous === categoryId ? previous : categoryId));
      setSearchQuery('');
      if (options?.resetChannelIndex) {
        setFocusedChannelIndex(0);
      }
    };

    if (options?.immediate) {
      if (groupSelectionTimerRef.current) {
        clearTimeout(groupSelectionTimerRef.current);
        groupSelectionTimerRef.current = null;
      }
      commit();
      return;
    }

    if (groupSelectionTimerRef.current) {
      clearTimeout(groupSelectionTimerRef.current);
    }
    groupSelectionTimerRef.current = setTimeout(() => {
      groupSelectionTimerRef.current = null;
      commit();
    }, GROUP_SELECTION_THROTTLE_MS);
  }, []);

  useEffect(() => () => {
    if (groupSelectionTimerRef.current) {
      clearTimeout(groupSelectionTimerRef.current);
      groupSelectionTimerRef.current = null;
    }
  }, []);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, []);

  // Sincronizar com media externa (vindo de "minimizar" o player global)
  useEffect(() => {
    if (!externalMedia) {
      lastSyncedExternalMediaIdRef.current = null;
      lastSyncedExternalCategoryMediaIdRef.current = null;
      return;
    }

    if (lastSyncedExternalMediaIdRef.current !== externalMedia.id) {
      setPreviewMedia(externalMedia);
      setSelectedMediaId(externalMedia.id);
      setInspectedMedia(externalMedia);
      activePreviewChannelIdRef.current = externalMedia.id;
      lastSyncedExternalMediaIdRef.current = externalMedia.id;
      lastSyncedExternalCategoryMediaIdRef.current = null;
    }

    if (lastSyncedExternalCategoryMediaIdRef.current === externalMedia.id) {
      return;
    }

    // Auto selecionar a categoria apenas uma vez por media externa.
    const catId = liveCategories.find(
      (c) =>
        c.title === externalMedia.category
        || c.items.some((i) => i.id === externalMedia.id),
    )?.id;
    if (catId) {
      setSelectedCatId(catId);
      lastSyncedExternalCategoryMediaIdRef.current = externalMedia.id;
    }
  }, [externalMedia, liveCategories]);

  useEffect(() => {
    if (selectedCatId || liveCategories.length === 0) {
      return;
    }

    // Se tivermos restaurado o initialSavedEntry, ele já será o selectedCatId na inicialização
    setSelectedCatId(liveCategories[0].id);
    setFocusedGroupIndex(0);
  }, [liveCategories, selectedCatId]);

  useEffect(() => {
    if (!selectedCategory) {
      setPage(0);
      setCategoryItems([]);
      setSelectedCategoryName(null);
      setVisibleItems([]);
      return;
    }

    setPage(0);
    setCategoryItems([]);
    setSelectedCategoryName(selectedCategory.title);
  }, [selectedCategory, setSelectedCategoryName, setVisibleItems]);

  useEffect(() => {
    const isCurrentlySyncing = Boolean(isCatalogSyncing);
    const wasSyncing = wasCatalogSyncingRef.current;
    if (wasSyncing && !isCurrentlySyncing) {
      // Quando a sincronizacao termina, forca recarga da lista para sair do preview parcial.
      setDiskReloadToken((prev) => prev + 1);
    }
    wasCatalogSyncingRef.current = isCurrentlySyncing;
  }, [isCatalogSyncing]);

  useEffect(() => {
    if (diskReloadToken <= 0) return;
    setCategoryItems([]);
  }, [diskReloadToken]);

  useEffect(() => {
    searchResultsCacheRef.current.clear();
  }, [diskReloadToken, liveCategories.length]);

  useEffect(() => {
    setCategoryItems((previous) => {
      const base = page === 0 ? [] : previous;
      const seen = new Set(base.map((item) => `${item.id}::${item.videoUrl}`));
      const merged = [...base];

      for (const item of pageItems) {
        const key = `${item.id}::${item.videoUrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }

      return merged;
    });
  }, [page, pageItems]);

  useEffect(() => {
    setVisibleItems(categoryItems.slice(0, 80));
  }, [categoryItems, setVisibleItems]);

  const normalizedSearchQuery = useMemo(
    () => normalizeLiveSearchKey(searchQuery),
    [searchQuery],
  );

  const allowedLiveCategoryKeys = useMemo(() => {
    const set = new Set<string>();
    for (const category of liveCategories) {
      const rawKey = normalizeLiveSearchKey(category.title);
      const normalizedKey = normalizeLiveCategoryKey(category.title);
      if (rawKey) set.add(rawKey);
      if (normalizedKey) set.add(normalizedKey);
    }
    return set;
  }, [liveCategories]);

  useEffect(() => {
    if (!normalizedSearchQuery) {
      setGlobalSearchItems([]);
      setIsSearchingAllChannels(false);
      return;
    }

    const cached = searchResultsCacheRef.current.get(normalizedSearchQuery);
    if (cached) {
      setGlobalSearchItems(cached);
      setIsSearchingAllChannels(false);
      return;
    }

    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setIsSearchingAllChannels(true);

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const rawResults = await searchChannelsByQuery(normalizedSearchQuery, {
            limit: layout.isTvProfile ? 1400 : 3200,
            types: ['live'],
            yieldEveryRows: layout.isTvProfile ? 700 : 2500,
            shouldAbort: () => searchRequestIdRef.current !== requestId,
          });
          if (searchRequestIdRef.current !== requestId) return;

          const filteredByScope = rawResults.filter((item) => {
            const rawCategoryKey = normalizeLiveSearchKey(item.category);
            const normalizedCategoryKey = normalizeLiveCategoryKey(item.category);
            return (
              allowedLiveCategoryKeys.has(rawCategoryKey)
              || allowedLiveCategoryKeys.has(normalizedCategoryKey)
            );
          });

          const nextCache = searchResultsCacheRef.current;
          nextCache.set(normalizedSearchQuery, filteredByScope);
          if (nextCache.size > 24) {
            const oldestKey = nextCache.keys().next().value;
            if (oldestKey) nextCache.delete(oldestKey);
          }

          setGlobalSearchItems(filteredByScope);
        } catch (error) {
          if (searchRequestIdRef.current !== requestId) return;
          console.warn('[LiveTVGrid] Falha na busca global de canais ao vivo:', error);
          setGlobalSearchItems([]);
        } finally {
          if (searchRequestIdRef.current === requestId) {
            setIsSearchingAllChannels(false);
          }
        }
      })();
    }, layout.isTvProfile ? 210 : 120);

    return () => window.clearTimeout(timeoutId);
  }, [allowedLiveCategoryKeys, layout.isTvProfile, normalizedSearchQuery]);

  useEffect(() => {
    let disposed = false;
    if (liveCategories.length === 0) {
      setCategoryCounts({});
      return;
    }

    const loadCategoryCounts = async () => {
      // P4: Adiar a contagem para liberar a Main Thread durante o mount
      await new Promise(r => setTimeout(r, 1500));

      const nextMap: Record<string, number> = {};

      // Carregar em lotes pequenos para nao travar o I/O
      const BATCH_SIZE = 12;
      for (let i = 0; i < liveCategories.length; i += BATCH_SIZE) {
        if (disposed) return;
        const batch = liveCategories.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (category) => {
          try {
            const fromCatalog = await getChannelCountByCategory(category.title);
            nextMap[category.id] = Number.isFinite(fromCatalog) && fromCatalog > 0
              ? fromCatalog
              : category.items.length;
          } catch {
            nextMap[category.id] = category.items.length;
          }
        }));

        // Atualizar parcial para feedback visual progressivo
        setCategoryCounts(prev => ({ ...prev, ...nextMap }));
        await new Promise(r => setTimeout(r, 100)); // Pequena pausa entre lotes
      }
    };

    void loadCategoryCounts();
    return () => {
      disposed = true;
    };
  }, [diskReloadToken, liveCategories]);

  const globalPreviewPool = useMemo<LivePreviewPoolEntry[]>(() => {
    // OTIMIZAÇÃO: Limitar o tamanho do pool de preview para evitar travamentos em listas massivas
    const seen = new Set<string>();
    const pool: LivePreviewPoolEntry[] = [];

    const addItem = (item: Media, categoryId: string) => {
      if (!item.videoUrl) return;
      const key = `${item.id}::${item.videoUrl}`;
      if (seen.has(key)) return;
      seen.add(key);
      pool.push({ media: item, categoryId });
    };

    // Prioridade 1: Itens já carregados na página atual (disco)
    if (selectedCatId && categoryItems.length > 0) {
      for (const item of categoryItems) {
        addItem(item, selectedCatId);
      }
    }

    // Prioridade 2: Primeiros itens das categorias passadas
    // Limitamos a iteração para evitar O(N) pesado em cada re-render
    const MAX_POOL_CATEGORIES = 15;
    const MAX_ITEMS_PER_CAT = 10;

    for (let i = 0; i < Math.min(liveCategories.length, MAX_POOL_CATEGORIES); i++) {
      const category = liveCategories[i];
      const itemsToIterate = category.items || [];
      for (let j = 0; j < Math.min(itemsToIterate.length, MAX_ITEMS_PER_CAT); j++) {
        addItem(itemsToIterate[j], category.id);
      }
      if (pool.length > 100) break; // Já temos o suficiente para o auto-preview
    }

    return pool;
  }, [categoryItems, liveCategories, selectedCatId]);

  useEffect(() => {
    console.info(
      `[LiveTVGrid] Contexto live: grupos=${liveCategories.length} canaisNoPool=${globalPreviewPool.length} filtroAtual=${selectedCatId || 'none'}`,
    );
  }, [globalPreviewPool.length, liveCategories.length, selectedCatId]);

  // Auto-preview: ao entrar na grade, restaurar o último canal visitado ou iniciar um aleatório
  const hasAutoPreviewedRef = useRef<string | null>(null);
  const autoPreviewActiveRef = useRef(false);
  const autoPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (globalPreviewPool.length === 0) {
      return;
    }
    if (externalMedia) return;

    if (hasAutoPreviewedRef.current) return;
    hasAutoPreviewedRef.current = 'done';

    // RESTAURAR ÚLTIMO CANAL: Se o usuário já visitou um canal nesta seção antes
    // Como inicializamos no useState (initialSavedEntry), apenas pulamos se tiver sucesso
    if (initialSavedEntry) {
       console.info(
         `[LiveTVGrid] Último canal já restaurado de forma síncrona: "${initialSavedEntry.media.title}"`,
       );
       activePreviewChannelIdRef.current = initialSavedEntry.media.id;
       autoPreviewActiveRef.current = false;
       previewTriedKeysRef.current = new Set([`${initialSavedEntry.media.id}::${initialSavedEntry.media.videoUrl}`]);
       setFocusColumn('channels');
       return;
    }

    // FALLBACK: se não há canal salvo, selecionar aleatório
    const randomEntry = globalPreviewPool[Math.floor(Math.random() * globalPreviewPool.length)];
    if (!randomEntry?.media?.videoUrl) {
      return;
    }
    const randomItem = randomEntry.media;
    const randomCategoryId = randomEntry.categoryId || selectedCatId || 'default';

    if (autoPreviewTimerRef.current) clearTimeout(autoPreviewTimerRef.current);
    autoPreviewTimerRef.current = setTimeout(() => {
      autoPreviewTimerRef.current = null;
      previewFailureCountRef.current = 0;

      if (randomCategoryId && randomCategoryId !== selectedCatId) {
        setSelectedCatId(randomCategoryId);
      }
      activePreviewChannelIdRef.current = randomItem.id;
      autoPreviewActiveRef.current = true;
      previewTriedKeysRef.current = new Set([`${randomItem.id}::${randomItem.videoUrl}`]);
      setSelectedMediaId(randomItem.id);
      setInspectedMedia(randomItem);
      setPreviewMedia(randomItem);
    }, 1500); // Mais conservador no auto-preview inicial

    return () => {
      if (autoPreviewTimerRef.current) {
        clearTimeout(autoPreviewTimerRef.current);
        autoPreviewTimerRef.current = null;
      }
    };
    // Auto-preview: EXECUTAR APENAS UMA VEZ ao entrar na grade ou se a pool mudar radicalmente (ex: carga inicial)
  }, [externalMedia, globalPreviewPool, lastLiveChannel, section]); // Removido selectedCatId para evitar re-trigger ao navegar grupos

  const filteredItems = useMemo(() => {
    if (!normalizedSearchQuery) return categoryItems;
    return globalSearchItems;
  }, [categoryItems, globalSearchItems, normalizedSearchQuery]);

  const channelVirtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => channelsListRef.current,
    estimateSize: () => LIVE_CHANNEL_ROW_ESTIMATE,
    overscan: 8,
  });
  const virtualChannels = channelVirtualizer.getVirtualItems();
  const channelsInnerHeight = channelVirtualizer.getTotalSize();

  // P4: Virtualizacao da coluna de grupos (categorias)
  const groupVirtualizer = useVirtualizer({
    count: liveCategories.length,
    getScrollElement: () => groupsListRef.current,
    estimateSize: () => 54, // Altura aproximada do GroupItem
    overscan: 10,
  });
  const virtualGroups = groupVirtualizer.getVirtualItems();
  const groupsInnerHeight = groupVirtualizer.getTotalSize();

  const handlePreviewPlaybackFailed = useCallback((failedUrl: string) => {
    if (isGlobalPlayerActive) return;

    const pool = globalPreviewPool;
    if (pool.length <= 1) return;

    const currentPreview = previewMedia;
    const currentEntry = pool.find(({ media: item }) =>
      currentPreview
        ? item.id === currentPreview.id || item.videoUrl === currentPreview.videoUrl
        : item.videoUrl === failedUrl,
    );
    const currentCategoryId = currentEntry?.categoryId || selectedCatId || null;
    const currentKey = currentPreview ? `${currentPreview.id}::${currentPreview.videoUrl}` : null;

    let candidatePool = pool.filter(({ media }) => {
      const key = `${media.id}::${media.videoUrl}`;
      if (currentKey && key === currentKey) return false;
      return !previewTriedKeysRef.current.has(key);
    });

    if (candidatePool.length === 0) {
      previewTriedKeysRef.current.clear();
      candidatePool = pool.filter(({ media }) => {
        const key = `${media.id}::${media.videoUrl}`;
        return !currentKey || key !== currentKey;
      });
    }

    const differentGroupCandidates =
      currentCategoryId
        ? candidatePool.filter((entry) => entry.categoryId !== currentCategoryId)
        : candidatePool;
    const effectiveCandidates =
      differentGroupCandidates.length > 0 ? differentGroupCandidates : candidatePool;

    if (effectiveCandidates.length === 0) {
      return;
    }

    const nextEntry = effectiveCandidates[Math.floor(Math.random() * effectiveCandidates.length)];
    const nextMedia = nextEntry?.media;
    if (!nextMedia || (currentPreview && nextMedia.id === currentPreview.id)) {
      return;
    }

    previewFailureCountRef.current += 1;

    // Se o usuário selecionou manualmente, não pulamos para outro canal automaticamente.
    // O VideoPlayer mostrará o overlay de "Sem Sinal" e o usuário decide o que fazer.
    if (!autoPreviewActiveRef.current) {
      console.warn(`[LiveTVGrid] Falha no canal selecionado manualmente. Mantendo seleção para diagnóstico.`);
      return;
    }

    const maxFailures = 0; // Para auto-preview, falhou uma vez, já pula.

    if (previewFailureCountRef.current > maxFailures) {
      console.warn(
        `[LiveTVGrid] Auto-preview interrompido. Falhas: ${previewFailureCountRef.current}.`,
      );
      return;
    }

    console.warn(
      `[LiveTVGrid] Preview falhou para url="${failedUrl}". Tentando canal alternativo "${nextMedia.title}" (${nextMedia.id}) grupo=${nextEntry.categoryId}.`,
    );
    previewTriedKeysRef.current.add(`${nextMedia.id}::${nextMedia.videoUrl}`);
    if (nextEntry.categoryId && nextEntry.categoryId !== selectedCatId) {
      setSelectedCatId(nextEntry.categoryId);
    }
    activePreviewChannelIdRef.current = nextMedia.id;
    autoPreviewActiveRef.current = true;
    setSelectedMediaId(nextMedia.id);
    setInspectedMedia(nextMedia);
    setPreviewMedia(nextMedia);
  }, [globalPreviewPool, isGlobalPlayerActive, previewMedia, selectedCatId]); // Mantém a categoria atual no filtro de fallback

  useEffect(() => {
    if (!selectedCatId) {
      return;
    }

    const catIndex = liveCategories.findIndex((cat) => cat.id === selectedCatId);
    if (catIndex >= 0) {
      setFocusedGroupIndex(catIndex);
      focusedGroupIndexRef.current = catIndex;
      groupVirtualizer.scrollToIndex(catIndex, { align: 'center' });
    }
  }, [groupVirtualizer, liveCategories, selectedCatId]);

  useEffect(() => {
    if (filteredItems.length === 0) {
      setFocusedChannelIndex(0);
      return;
    }

    setFocusedChannelIndex((prev) => Math.min(prev, filteredItems.length - 1));
  }, [filteredItems]);

  useEffect(() => {
    if (normalizedSearchQuery) return;
    if (filteredItems.length === 0) return;
    if (focusColumn !== 'channels') return;
    if (focusedChannelIndex >= Math.max(0, filteredItems.length - 6)) {
      loadMoreChannels();
    }
  }, [filteredItems.length, focusColumn, focusedChannelIndex, loadMoreChannels, normalizedSearchQuery]);

  useEffect(() => {
    if (focusColumn !== 'channels') return;
    if (focusedChannelIndex < 0 || focusedChannelIndex >= filteredItems.length) return;
    channelVirtualizer.scrollToIndex(focusedChannelIndex, { align: 'center' });
  }, [channelVirtualizer, focusColumn, focusedChannelIndex, filteredItems.length]);

  useEffect(() => {
    if (focusedGroupIndex < 0 || focusedGroupIndex >= liveCategories.length) {
      return;
    }

    groupVirtualizer.scrollToIndex(focusedGroupIndex, { align: 'center' });
  }, [focusedGroupIndex, groupVirtualizer, liveCategories.length]);

  const openFullScreen = useCallback((media: Media) => {
    console.warn(`[LiveTVGrid] openFullScreen INICIADO para: ${media.title}. lock=${openingFullscreenRef.current}`);
    if (openingFullscreenRef.current) {
      console.warn('[LiveTVGrid] openFullScreen ABORTADO: Lock já está ativo!');
      return;
    }

    previewArmRef.current = { mediaId: null, armedAt: 0 };
    openingFullscreenRef.current = true;
    activePreviewChannelIdRef.current = media.id;
    setSelectedMediaId(media.id);
    setInspectedMedia(media);

    console.warn('[LiveTVGrid] openFullScreen: Disparando onPlayFull imediatamente');
    onPlayFull(media);
  }, [onPlayFull, setSelectedMediaId]);

  const handlePreviewClose = useCallback(() => {
    openingFullscreenRef.current = false;
    previewArmRef.current = { mediaId: null, armedAt: 0 };
    previewActivationGuardRef.current = { mediaId: null, at: 0 };
  }, []);
  const handlePreviewFullscreen = useCallback(() => {
    if (previewMedia) {
      void openFullScreen(previewMedia);
    }
  }, [openFullScreen, previewMedia]);

  const handleMediaClick = useCallback((media: Media) => {
    // Evita disparos duplicados do MESMO pressionamento físico (onEnter + onPress).
    // Mantemos a janela mínima possível para não engolir o 2º clique intencional.
    const duplicateActivationWindowMs = 120;
    const isSameChannel = activePreviewChannelIdRef.current === media.id;
    const now = Date.now();
    const isDuplicatedPhysicalActivation =
      previewActivationGuardRef.current.mediaId === media.id
      && now - previewActivationGuardRef.current.at < duplicateActivationWindowMs;

    if (isDuplicatedPhysicalActivation) {
      return;
    }

    if (openingFullscreenRef.current) {
      console.warn('[LiveTVGrid] handleMediaClick BLOQUEADO: Abrindo fullscreen em andamento...');
      return;
    }

    previewActivationGuardRef.current = { mediaId: media.id, at: now };
    const isArmedForThisChannel = previewArmRef.current.mediaId === media.id;
    const armElapsedMs = now - previewArmRef.current.armedAt;
    
    const isSecondIntentionalActivation =
      isSameChannel
      && isArmedForThisChannel
      && armElapsedMs >= duplicateActivationWindowMs;

    console.warn(`[LiveTVGrid] handleMediaClick: ${media.id} - ${media.title}. isGlobalPlayerActive=${isGlobalPlayerActive}. isSameChannel=${isSameChannel}. armElapsedMs=${armElapsedMs}. 2nd=${isSecondIntentionalActivation}`);

    if (isSecondIntentionalActivation) {
      previewArmRef.current = { mediaId: null, armedAt: 0 };
      void openFullScreen(media);
      return;
    }

    // BLOQUEIO: Se o player já está em tela cheia, ignoramos cliques simples que trocariam o preview
    // Isso evita que a navegação na sidebar do player dispare trocas no fundo.
    if (isGlobalPlayerActive) {
      return;
    }

    if (autoPreviewTimerRef.current) {
      clearTimeout(autoPreviewTimerRef.current);
      autoPreviewTimerRef.current = null;
    }

    openingFullscreenRef.current = false;
    setFocusColumn('channels');
    activePreviewChannelIdRef.current = media.id;
    autoPreviewActiveRef.current = false;
    previewFailureCountRef.current = 0;
    previewTriedKeysRef.current = new Set([`${media.id}::${media.videoUrl}`]);
    setSelectedMediaId(media.id);
    setInspectedMedia(media);
    setPreviewMedia(media);
    previewArmRef.current = { mediaId: media.id, armedAt: now };

    // PERSISTIR último canal selecionado
    setLastLiveChannel({
      categoryId: selectedCatId || '',
      mediaId: media.id,
      mediaTitle: media.title,
      section,
      timestamp: Date.now(),
    });
  }, [isGlobalPlayerActive, openFullScreen, selectedCatId, section, setLastLiveChannel]);

  const { registerNode, setFocusedId } = useTvNavigation({
    isActive: !showDiagnostic && !isGlobalPlayerActive,
  });

  const focusNavIdWhenMounted = useCallback((navId: string, attempts = 6) => {
    if (typeof window === 'undefined') {
      setFocusedId(navId);
      return;
    }

    let remainingAttempts = attempts;
    const tryFocus = () => {
      const element = document.getElementById(navId)
        || Array.from(document.querySelectorAll<HTMLElement>('[data-nav-id]'))
          .find((node) => node.dataset.navId === navId);

      if (element) {
        setFocusedId(navId);
        return;
      }

      if (remainingAttempts <= 0) {
        return;
      }

      remainingAttempts -= 1;
      window.setTimeout(tryFocus, 32);
    };

    window.requestAnimationFrame(tryFocus);
  }, [setFocusedId]);

  useEffect(() => {
    const wasGlobalPlayerActive = previousGlobalPlayerActiveRef.current;
    previousGlobalPlayerActiveRef.current = Boolean(isGlobalPlayerActive);

    if (isGlobalPlayerActive) {
      return;
    }

    // Só resetar estado de "abertura em andamento" quando houve transição
    // real de fullscreen -> grade. Se resetarmos em TODO render da grade,
    // o segundo clique nunca encontra o canal "armado".
    if (!wasGlobalPlayerActive) {
      return;
    }

    openingFullscreenRef.current = false;
    previewArmRef.current = { mediaId: null, armedAt: 0 };
    previewActivationGuardRef.current = { mediaId: null, at: 0 };

    hasAppliedInitialFocusRef.current = false;
    setIsDiagnosticFocused(false);

    // Ao voltar do fullscreen, manter o foco no MESMO botão de canal que abriu o player.
    const targetChannelId =
      selectedMediaId
      || previewMedia?.id
      || activePreviewChannelIdRef.current;
    if (targetChannelId) {
      setFocusColumn('channels');
      setSelectedMediaId(targetChannelId);
      activePreviewChannelIdRef.current = targetChannelId;

      const targetChannelIndex = filteredItems.findIndex((item) => item.id === targetChannelId);
      if (targetChannelIndex >= 0) {
        focusedChannelIndexRef.current = targetChannelIndex;
        setFocusedChannelIndex(targetChannelIndex);
        channelVirtualizer.scrollToIndex(targetChannelIndex, { align: 'center' });
      } else {
        const targetCategoryId = liveCategories.find((category) =>
          category.items.some((item) => item.id === targetChannelId),
        )?.id;
        if (targetCategoryId && targetCategoryId !== selectedCatId) {
          setSelectedCatId(targetCategoryId);
        }
      }

      hasAppliedInitialFocusRef.current = true;
      window.requestAnimationFrame(() => {
        focusNavIdWhenMounted(`tv-channel-${targetChannelId}`, 20);
      });
      return;
    }

    if (selectedCatId) {
      setFocusColumn('groups');
      hasAppliedInitialFocusRef.current = true;
      window.requestAnimationFrame(() => {
        focusNavIdWhenMounted(`tv-group-${selectedCatId}`);
      });
    }
  }, [
    focusNavIdWhenMounted,
    filteredItems,
    channelVirtualizer,
    isGlobalPlayerActive,
    liveCategories,
    previewMedia?.id,
    selectedCatId,
    selectedMediaId,
    setFocusedChannelIndex,
    setFocusColumn,
    setIsDiagnosticFocused,
    setSelectedCatId,
    setSelectedMediaId,
  ]);

  const focusChannelByIndex = useCallback((targetIndex: number) => {
    if (filteredItems.length === 0) {
      return;
    }

    if (targetIndex >= filteredItems.length) {
      setFocusColumn('channels');
      setIsDiagnosticFocused(true);
      focusNavIdWhenMounted('tv-btn-diagnostic');
      return;
    }

    const safeIndex = Math.max(0, Math.min(targetIndex, filteredItems.length - 1));
    focusedChannelIndexRef.current = safeIndex;

    if (safeIndex >= Math.max(0, filteredItems.length - 6)) {
      loadMoreChannels();
    }

    const nextChannel = filteredItems[safeIndex];
    // P1: Usar scroll do virtualizador
    channelVirtualizer.scrollToIndex(safeIndex, { align: 'center' });

    if (nextChannel) {
      focusNavIdWhenMounted(`tv-channel-${nextChannel.id}`);
    }
  }, [channelVirtualizer, filteredItems, focusNavIdWhenMounted, loadMoreChannels, setFocusColumn, setIsDiagnosticFocused]);

  const focusGroupByIndex = useCallback((targetIndex: number) => {
    if (liveCategories.length === 0) {
      return;
    }

    const safeIndex = Math.max(0, Math.min(targetIndex, liveCategories.length - 1));
    focusedGroupIndexRef.current = safeIndex;

    // P1: Usar scroll virtualizado
    groupVirtualizer.scrollToIndex(safeIndex, { align: 'center' });

    const targetGroup = liveCategories[safeIndex];
    if (targetGroup) {
      focusNavIdWhenMounted(`tv-group-${targetGroup.id}`);
    }
  }, [focusNavIdWhenMounted, groupVirtualizer, liveCategories]);

  const handleGroupPress = useCallback((category: Category, index: number) => {
    setFocusColumn('groups');
    setFocusedGroupIndex(index);
    setIsDiagnosticFocused(false);
    applyCategorySelection(category.id, { immediate: true, resetChannelIndex: true });

    if (layout.isTvProfile) {
      focusNavIdWhenMounted(`tv-group-${category.id}`);
    }
  }, [applyCategorySelection, focusNavIdWhenMounted, layout.isTvProfile]);

  const handleChannelPress = useCallback((media: Media, index: number) => {
    setFocusColumn('channels');
    setFocusedChannelIndex(index);
    setIsDiagnosticFocused(false);

    // Sempre chamar handleMediaClick, tanto no modo TV (D-Pad Enter) quanto em touch/mobile.
    // Antes, este bloco não chamava handleMediaClick no modo TV, confiando
    // apenas no onEnter do registerNode. Porém, quando isGlobalPlayerActive
    // desativava o useTvNavigation, nenhum clique funcionava.
    handleMediaClick(media);

    focusNavIdWhenMounted(`tv-channel-${media.id}`);
  }, [focusNavIdWhenMounted, handleMediaClick, layout.isTvMode, layout.isTvProfile]);

  const handleChannelFocus = useCallback((media: Media, index: number) => {
    setFocusColumn('channels');
    setFocusedChannelIndex(index);
    setIsDiagnosticFocused(false);
    setInspectedMedia((previous) => (previous?.id === media.id ? previous : media));
  }, []);

  const focusSearchInput = useCallback(() => {
    setFocusColumn('channels');
    setIsDiagnosticFocused(false);
    focusNavIdWhenMounted('tv-search-input');
  }, [focusNavIdWhenMounted]);

  // Register Global/Static UI Nodes
  useEffect(() => {
    const unregisterList: (() => void)[] = [];

    // Preview Player registration
    if (previewMedia) {
      unregisterList.push(registerNode('tv-preview-player', null, 'body', {
        onFocus: () => {
          setFocusColumn('preview');
          setIsDiagnosticFocused(false);
        },
        onEnter: () => openFullScreen(previewMedia),
      }));
    }

    // Register Search Input
    unregisterList.push(registerNode('tv-search-input', null, 'body', {
      onFocus: () => {
        setFocusColumn('channels');
        setIsDiagnosticFocused(false);
      },
      onDown: () => {
        if (filteredItems.length === 0) {
          setIsDiagnosticFocused(true);
          focusNavIdWhenMounted('tv-btn-diagnostic');
          return;
        }
        setIsDiagnosticFocused(false);
        setFocusColumn('channels');
        focusChannelByIndex(focusedChannelIndexRef.current);
      },
      onLeft: () => {
        const targetGroupId = selectedCatId || liveCategories[0]?.id;
        if (!targetGroupId) return;
        const targetGroupIndex = liveCategories.findIndex((category) => category.id === targetGroupId);
        focusGroupByIndex(targetGroupIndex >= 0 ? targetGroupIndex : 0);
      },
      onRight: () => {
        setIsDiagnosticFocused(true);
        focusNavIdWhenMounted('tv-btn-diagnostic');
      },
    }));

    // Register Diagnostic Button
    unregisterList.push(registerNode('tv-btn-diagnostic', null, 'body', {
      onFocus: () => {
        setFocusColumn('channels');
        setIsDiagnosticFocused(true);
      },
      onEnter: () => setShowDiagnostic(true),
      onUp: () => {
        setIsDiagnosticFocused(false);
        focusNavIdWhenMounted('tv-search-input');
      },
      onDown: () => {
        if (filteredItems.length === 0) return;
        setIsDiagnosticFocused(false);
        setFocusColumn('channels');
        focusChannelByIndex(focusedChannelIndexRef.current);
      },
      onLeft: () => {
        setIsDiagnosticFocused(false);
        focusNavIdWhenMounted('tv-search-input');
      },
      onRight: () => {
        if (!previewMedia) return;
        setFocusColumn('preview');
        setFocusedId('tv-preview-player');
      },
    }));

    return () => unregisterList.forEach((unregister) => unregister());
  }, [
    filteredItems.length,
    openFullScreen,
    focusNavIdWhenMounted,
    focusChannelByIndex,
    focusGroupByIndex,
    liveCategories,
    previewMedia,
    registerNode,
    selectedCatId,
    setFocusedId,
    setFocusColumn,
  ]);

  useEffect(() => {
    if (liveCategories.length === 0) {
      return;
    }
    if (hasAppliedInitialFocusRef.current) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      const activeNavId = (document.activeElement as HTMLElement | null)?.dataset?.navId || '';
      const isAlreadyInsideLiveGrid =
        activeNavId.startsWith('tv-group-')
        || activeNavId.startsWith('tv-channel-')
        || activeNavId === 'tv-preview-player'
        || activeNavId === 'tv-search-input'
        || activeNavId === 'tv-btn-diagnostic';

      if (isAlreadyInsideLiveGrid) {
        hasAppliedInitialFocusRef.current = true;
        return;
      }

      const fallbackGroupId = liveCategories[0]?.id || null;
      const targetGroupId = selectedCatId || fallbackGroupId;
      if (!targetGroupId) {
        return;
      }

      const targetIndex = Math.max(
        0,
        liveCategories.findIndex((category) => category.id === targetGroupId),
      );

      setFocusColumn('groups');
      setFocusedGroupIndex(targetIndex);
      focusedGroupIndexRef.current = targetIndex;
      groupVirtualizer.scrollToIndex(targetIndex, { align: 'center' });
      focusNavIdWhenMounted(`tv-group-${targetGroupId}`);
      hasAppliedInitialFocusRef.current = true;
    }, 120);

    return () => window.clearTimeout(focusTimer);
  }, [focusNavIdWhenMounted, groupVirtualizer, liveCategories, selectedCatId]);

  if (liveCategories.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Nenhum canal ao vivo encontrado.</Text>
      </View>
    );
  }

  const shouldRenderSideMenu = (!layout.isMobile || layout.isTvProfile);
  const sideMenuOffset = shouldRenderSideMenu ? layout.sideRailCollapsedWidth : 0;

  return (
    <>
    <View style={[styles.container, { paddingLeft: sideMenuOffset }]}>
      {/* Groups Column */}
      <View style={styles.groupsColumn}>
        <View style={styles.columnHeader}>
          <Radio size={20} color="#E50914" />
          <Text style={styles.columnTitle}>GRUPOS</Text>
        </View>
        <div
          ref={groupsListRef as React.RefObject<HTMLDivElement>}
          style={{ flex: 1, overflowY: 'auto', overflowX: 'visible', paddingBottom: 72, paddingInline: 6, position: 'relative' }}
        >
          <div style={{ height: groupsInnerHeight, position: 'relative', width: '100%' }}>
            {virtualGroups.map((virtualGroup) => {
              const cat = liveCategories[virtualGroup.index];
              if (!cat) return null;

              return (
                <div
                  key={virtualGroup.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translate3d(0, ${virtualGroup.start}px, 0)`,
                  }}
                >
                  <GroupItem
                    category={cat}
                    index={virtualGroup.index}
                    itemCount={categoryCounts[cat.id] || 0}
                    isSelected={selectedCatId === cat.id}
                    onPress={handleGroupPress}
                    registerNode={registerNode}
                    applyCategorySelection={applyCategorySelection}
                    setFocusColumn={setFocusColumn}
                    focusGroupByIndex={focusGroupByIndex}
                    focusedGroupIndexRef={focusedGroupIndexRef}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </View>

      {/* Channels Column */}
      <View style={styles.channelsColumn}>
        <View style={styles.columnHeader}>
          <View style={styles.searchContainer}>
            <Search size={16} color="rgba(255,255,255,0.4)" />
            <input
              id="tv-search-input"
              data-nav-id="tv-search-input"
              style={styles.searchInput}
              placeholder="Buscar canal..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </View>
          <TouchableHighlight
            id="tv-btn-diagnostic"
            data-nav-id="tv-btn-diagnostic"
            onPress={() => setShowDiagnostic(true)}
            underlayColor="rgba(255,255,255,0.05)"
            style={[
              styles.diagnosticButton,
              isDiagnosticFocused && styles.diagnosticButtonFocused
            ]}
          >
            <View style={styles.diagnosticButtonInner}>
              <Activity size={16} color={isDiagnosticFocused ? '#ffffff' : 'rgba(255,255,255,0.6)'} />
              <Text style={[styles.diagnosticButtonText, isDiagnosticFocused && styles.diagnosticButtonTextFocused]}>Diagnóstico</Text>
            </View>
          </TouchableHighlight>
        </View>
        <div
          ref={channelsListRef as React.RefObject<HTMLDivElement>}
          style={{ flex: 1, overflowY: 'auto', overflowX: 'visible', paddingTop: 8, paddingBottom: 40, paddingInline: 6 }}
          onScroll={(e) => {
            if (normalizedSearchQuery) return;
            const node = e.currentTarget;
            if (node.scrollTop + node.clientHeight >= node.scrollHeight - 260) {
              loadMoreChannels();
            }
          }}
        >
          {filteredItems.length === 0 ? (
            <View style={styles.channelListLoading}>
              <Text style={styles.channelListLoadingText}>
                {normalizedSearchQuery && isSearchingAllChannels
                  ? 'Buscando em todos os canais ao vivo...'
                  : 'Nenhum canal encontrado.'}
              </Text>
            </View>
          ) : (
            <div style={{ height: channelsInnerHeight, position: 'relative' }}>
              {virtualChannels.map((virtualChannel) => {
                const media = filteredItems[virtualChannel.index];
                if (!media) return null;

                return (
                  <div
                    key={virtualChannel.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translate3d(0, ${virtualChannel.start}px, 0)`,
                    }}
                  >
                    <ChannelItem
                      key={`${media.id}-${virtualChannel.index}`}
                      media={media}
                      index={virtualChannel.index}
                      isSelected={selectedMediaId === media.id}
                      isFavorite={favoriteSet.has(media.id)}
                      now={now}
                      programs={resolveProgramsForMedia(media)}
                      onPress={handleChannelPress}
                      onFocusMedia={handleChannelFocus}
                      onMoveToSearch={focusSearchInput}
                      registerNode={registerNode}
                      setFocusedId={setFocusedId}
                      focusChannelByIndex={focusChannelByIndex}
                      previewMedia={previewMedia}
                      selectedCatId={selectedCatId}
                      liveCategories={liveCategories}
                      focusedChannelIndexRef={focusedChannelIndexRef}
                      focusGroupByIndex={focusGroupByIndex}
                    />
                  </div>
                );
              })}

              {pageLoading && (
                <View style={styles.channelListLoading}>
                  <Text style={styles.channelListLoadingText}>Carregando mais canais...</Text>
                </View>
              )}
            </div>
          )}
        </div>
      </View>

      {/* Preview Player Section */}
      <View style={styles.playerSection}>
        {!isGlobalPlayerActive ? (
          <div
            className="w-full h-full flex flex-col"
          >
            <View style={styles.previewContainer}>
                {previewMedia ? (
                  <TouchableHighlight
                    onPress={() => {
                      openFullScreen(previewMedia);
                    }}
                    id="tv-preview-player"
                    data-nav-id="tv-preview-player"
                    style={[
                      styles.playerWrapper,
                      focusColumn === 'preview' && styles.playerWrapperFocused,
                    ]}
                  >
                      <VideoPlayer
                        url={previewMedia.videoUrl}
                        mediaType="live"
                        media={previewMedia}
                        onPreviewPlaybackFailed={handlePreviewPlaybackFailed}
                        onClose={handlePreviewClose}
                        onPreviewRequestFullscreen={handlePreviewFullscreen}
                        suppressNativePreviewExitOnUnmount={false}
                        isMinimized={false}
                        isPreview={true}
                      />
                  </TouchableHighlight>
                ) : (
                  <View style={styles.playerWrapperPlaceholder}>
                    <View style={styles.placeholderIconContainer}>
                      <Radio size={44} color="rgba(255,255,255,0.08)" />
                    </View>
                    <Text style={styles.placeholderText}>Preview indisponível no momento</Text>
                  </View>
                )}
                <View style={styles.previewInfoPanel}>
                   <View style={{ flex: 1 }}>
                     <Text style={styles.previewTitleSmall}>{guideMedia?.title || 'Selecione um canal para ver detalhes'}</Text>
                   </View>
                </View>
                <View style={styles.previewEpgPanel}>
                  <Text style={styles.previewEpgTitle}>Guia de Programação</Text>
                  {!guideMedia ? (
                    <Text style={styles.previewEpgEmptyText}>Selecione um canal para carregar o guia.</Text>
                  ) : currentPreviewProgram ? (
                    <View style={styles.previewEpgCurrentCard}>
                      <Text style={styles.previewEpgCurrentLabel}>Agora</Text>
                      <Text style={styles.previewEpgCurrentName} numberOfLines={1}>
                        {currentPreviewProgram.title}
                      </Text>
                      <Text style={styles.previewEpgCurrentTime}>
                        {formatProgramTime(currentPreviewProgram.start)} - {formatProgramTime(currentPreviewProgram.stop)}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.previewEpgEmptyText}>Sem programa atual disponível no EPG.</Text>
                  )}
                  {upcomingPreviewPrograms.length > 0 && (
                    <View style={styles.previewEpgUpcomingList}>
                      {upcomingPreviewPrograms.map((program) => (
                        <View key={program.id} style={styles.previewEpgUpcomingItem}>
                          <Text style={styles.previewEpgUpcomingTime}>{formatProgramTime(program.start)}</Text>
                          <Text style={styles.previewEpgUpcomingName} numberOfLines={1}>
                            {program.title}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
            </View>
          </div>
        ) : (
          <View style={styles.playerPlaceholder}>
            <View style={styles.placeholderIconContainer}>
              <Radio size={64} color="rgba(255,255,255,0.05)" />
            </View>
            <Text style={styles.placeholderText}>Selecione um canal para visualizar</Text>
          </View>
        )}
      </View>
    </View>
    {showDiagnostic && (
      <NetworkDiagnostic
        onClose={() => setShowDiagnostic(false)}
        testUrl={previewMedia?.videoUrl}
      />
    )}
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'transparent',
    gap: 0,
    overflow: 'visible',
    height: '100%',
  },
  groupsColumn: {
    flex: 0.16,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.06)',
  },
  channelsColumn: {
    flex: 0.24,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.015)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.06)',
  },
  playerSection: {
    flex: 0.60,
    padding: 16,
    paddingLeft: 0,
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    backgroundColor: '#000',
  },
  columnHeader: {
    padding: 20,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    marginBottom: 8,
  },
  columnTitle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2.5,
    fontFamily: 'Outfit',
    textTransform: 'uppercase',
  },
  groupItem: {
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 10,
    marginHorizontal: 8,
    marginTop: 3,
    marginBottom: 7,
    borderRadius: 12,
    overflow: 'visible',
  },
  groupItemActive: {
    backgroundColor: 'rgba(229,9,20,0.12)',
  },
  groupItemFocused: {
    borderWidth: 1.5,
    borderColor: 'rgba(59,130,246,0.7)',
    backgroundColor: 'rgba(59,130,246,0.08)',
  },
  groupItemInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 24,
    paddingRight: 8,
    paddingTop: 4,
    paddingBottom: 6,
    gap: 14,
  },
  groupText: {
    flex: 1,
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Outfit',
    letterSpacing: 0.3,
  },
  groupTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  itemCount: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.2)',
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  diagnosticButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  diagnosticButtonFocused: {
    backgroundColor: '#E50914',
    borderColor: '#E50914',
  },
  diagnosticButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  diagnosticButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.5)',
    letterSpacing: 0.5,
  },
  diagnosticButtonTextFocused: {
    color: '#ffffff',
  },
  searchInput: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 0,
    color: 'white',
    fontSize: 16,
    fontFamily: 'Outfit',
    outlineStyle: 'none',
  } as any,
  channelListLoading: {
    paddingVertical: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelListLoadingText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Outfit',
  },
  channelItem: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginHorizontal: 8,
    marginVertical: 2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'transparent',
    overflow: 'visible',
  },
  channelItemActive: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.08)',
  },
  channelItemFocused: {
    borderWidth: 1,
    borderColor: 'rgba(229,9,20,0.55)',
    backgroundColor: 'rgba(229,9,20,0.08)',
    shadowColor: '#E50914',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    boxShadow: '0 0 4px rgba(229,9,20,0.18)',
  },
  channelItemInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 24,
    paddingRight: 8,
    paddingVertical: 2,
    gap: 20,
  },
  itemThumbnailContainer: {
    width: 48,
    aspectRatio: '1/1',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  itemThumbnail: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  },
  favoriteBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderWidth: 1.5,
    borderColor: '#E50914',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  channelInfo: {
    flex: 1,
    gap: 0,
  },
  channelTitle: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'Outfit',
    letterSpacing: 0.2,
  },
  channelTitleActive: {
    color: '#60a5fa',
  },
  channelSubtitle: {
    color: 'rgba(255,255,255,0.28)',
    fontSize: 13,
    fontFamily: 'Outfit',
    letterSpacing: 0.3,
  },
  channelProgram: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Outfit',
  },
  playingIndicator: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(229,9,20,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E50914',
    shadowColor: '#E50914',
    shadowOpacity: 1,
    shadowRadius: 12,
  },
  previewContainer: {
    flex: 1,
    width: '100%',
    backgroundColor: '#000',
    overflow: 'hidden',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
  },
  playerWrapper: {
    width: '100%',
    aspectRatio: 16 / 9,
    maxHeight: SCREEN_HEIGHT * 0.70,
    backgroundColor: '#000',
    zIndex: 1,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  playerWrapperFocused: {
    borderColor: '#E50914',
    shadowColor: '#E50914',
    shadowOpacity: 0.8,
    shadowRadius: 10,
  },
  playerWrapperPlaceholder: {
    width: '100%',
    aspectRatio: 16 / 9,
    maxHeight: SCREEN_HEIGHT * 0.70,
    backgroundColor: '#050505',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  playerPlaceholder: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    backgroundColor: '#000',
  },
  placeholderIconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255,255,255,0.02)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  placeholderText: {
    color: 'rgba(255,255,255,0.2)',
    fontSize: 16,
    fontWeight: 'bold',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 100,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 18,
  },
  previewInfoPanel: {
    marginTop: 14,
    marginHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    paddingLeft: 42,
    paddingRight: 42,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  } as any,
  previewEpgPanel: {
    marginTop: 10,
    marginHorizontal: 20,
    marginBottom: 12,
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 42,
    paddingRight: 42,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 10,
  } as any,
  previewEpgTitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    fontFamily: 'Outfit',
  },
  previewEpgCurrentCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingTop: 9,
    paddingBottom: 9,
    paddingLeft: 20,
    paddingRight: 20,
    gap: 4,
  },
  previewEpgCurrentLabel: {
    color: '#E50914',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontFamily: 'Outfit',
  },
  previewEpgCurrentName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    fontFamily: 'Outfit',
  },
  previewEpgCurrentTime: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Outfit',
  },
  previewEpgUpcomingList: {
    gap: 6,
  },
  previewEpgUpcomingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 20,
    paddingRight: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  previewEpgUpcomingTime: {
    color: 'rgba(255,255,255,0.6)',
    minWidth: 44,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Outfit',
  },
  previewEpgUpcomingName: {
    flex: 1,
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Outfit',
  },
  previewEpgEmptyText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Outfit',
  },
  previewTitleSmall: {
    fontSize: 22,
    fontWeight: '800',
    color: 'white',
    fontFamily: 'Outfit',
  },
  fullScreenBtnSmall: {
    backgroundColor: 'rgba(229,9,20,0.15)',
    paddingHorizontal: 48,
    paddingVertical: 20,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'rgba(229,9,20,0.45)',
    shadowColor: '#E50914',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  fullScreenTextSmall: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 11,
    letterSpacing: 2,
    fontFamily: 'Outfit',
    textTransform: 'uppercase',
  },
  fullScreenBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
