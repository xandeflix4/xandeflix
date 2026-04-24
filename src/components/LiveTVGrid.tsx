import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableHighlight, Image, Dimensions, FlatList, ListRenderItem } from 'react-native';
import { Radio, ChevronRight, Play, Maximize2, Search, Heart, Activity, RotateCcw } from 'lucide-react';
import { Category, Media } from '../types';
import { VideoPlayer } from './VideoPlayer';
import { useStore } from '../store/useStore';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { NetworkDiagnostic } from './NetworkDiagnostic';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DISK_CATEGORY_PAGE_SIZE, useDiskCategory } from '../hooks/useDiskCategory';
import { getChannelCountByCategory } from '../lib/db';

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

// Virtualizer substituído em favor de FlatList NATIVA do React para consertar pulo-duplo direcional em Engine legada.

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
  const [searchQuery, setSearchQuery] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const openingFullscreenRef = useRef(false);
  const activePreviewChannelIdRef = useRef<string | null>(null);
  const [focusColumn, setFocusColumn] = useState<LiveTvFocusColumn>('groups');
  const [focusedGroupIndex, setFocusedGroupIndex] = useState(0);
  const [focusedChannelIndex, setFocusedChannelIndex] = useState(0);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [diskReloadToken, setDiskReloadToken] = useState(0);
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const previewFailureCountRef = useRef(0);
  const previewTriedKeysRef = useRef<Set<string>>(new Set());
  const previewArmRef = useRef<{ mediaId: string | null; armedAt: number }>({ mediaId: null, armedAt: 0 });
  const previewActivationGuardRef = useRef<{ mediaId: string | null; at: number }>({ mediaId: null, at: 0 });
  const hasAppliedInitialFocusRef = useRef(false);
  const wasCatalogSyncingRef = useRef<boolean>(Boolean(isCatalogSyncing));
  const groupsListRef = useRef<HTMLDivElement | null>(null);
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
  const previewPrograms = useMemo(() => {
    if (!previewMedia) return [];
    return resolveProgramsForMedia(previewMedia);
  }, [previewMedia, resolveProgramsForMedia]);
  const currentPreviewProgram = useMemo(
    () => previewPrograms.find((program) => now >= program.start && now < program.stop) || null,
    [now, previewPrograms],
  );
  const upcomingPreviewPrograms = useMemo(
    () => previewPrograms.filter((program) => program.start > now).slice(0, 2),
    [now, previewPrograms],
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

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, []);

  // Sincronizar com media externa (vindo de "minimizar" o player global)
  useEffect(() => {
    if (externalMedia) {
      setPreviewMedia(externalMedia);
      setSelectedMediaId(externalMedia.id);
      activePreviewChannelIdRef.current = externalMedia.id;
      
      // Auto selecionar a categoria
      const catId = liveCategories.find(
        (c) =>
          c.title === externalMedia.category
          || c.items.some((i) => i.id === externalMedia.id),
      )?.id;
      if (catId) setSelectedCatId(catId);
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

  useEffect(() => {
    let disposed = false;
    if (liveCategories.length === 0) {
      setCategoryCounts({});
      return;
    }

    const loadCategoryCounts = async () => {
      const entries = await Promise.all(
        liveCategories.map(async (category) => {
          try {
            const fromCatalog = await getChannelCountByCategory(category.title);
            const safeCount = Number.isFinite(fromCatalog) && fromCatalog > 0
              ? fromCatalog
              : category.items.length;
            return [category.id, safeCount] as const;
          } catch {
            return [category.id, category.items.length] as const;
          }
        }),
      );

      if (disposed) return;
      const nextMap: Record<string, number> = {};
      entries.forEach(([id, count]) => {
        nextMap[id] = count;
      });
      setCategoryCounts(nextMap);
    };

    void loadCategoryCounts();
    return () => {
      disposed = true;
    };
  }, [diskReloadToken, liveCategories]);

  const globalPreviewPool = useMemo<LivePreviewPoolEntry[]>(() => {
    const seen = new Set<string>();
    const pool: LivePreviewPoolEntry[] = [];

    const addItem = (item: Media, categoryId: string) => {
      if (!item.videoUrl) return;
      const key = `${item.id}::${item.videoUrl}`;
      if (seen.has(key)) return;
      seen.add(key);
      pool.push({ media: item, categoryId });
    };

    for (const category of liveCategories) {
      for (const item of category.items) {
        addItem(item, category.id);
      }
    }

    if (selectedCatId && categoryItems.length > 0) {
      for (const item of categoryItems) {
        addItem(item, selectedCatId);
      }
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
      previewFailureCountRef.current = 0;
      console.info(
        `[LiveTVGrid] Auto-preview canal selecionado categoria=${randomCategoryId} total=${globalPreviewPool.length} canal="${randomItem.title}" canalId=${randomItem.id}`,
      );
      if (randomCategoryId && randomCategoryId !== selectedCatId) {
        setSelectedCatId(randomCategoryId);
      }
      activePreviewChannelIdRef.current = randomItem.id;
      autoPreviewActiveRef.current = true;
      previewTriedKeysRef.current = new Set([`${randomItem.id}::${randomItem.videoUrl}`]);
      setSelectedMediaId(randomItem.id);
      setPreviewMedia(randomItem);
      setFocusColumn('channels');
    }, 800);
    
    return () => {
      if (autoPreviewTimerRef.current) {
        clearTimeout(autoPreviewTimerRef.current);
        autoPreviewTimerRef.current = null;
      }
    };
  }, [externalMedia, globalPreviewPool, selectedCatId, lastLiveChannel, section]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return categoryItems;
    return categoryItems.filter((i) =>
      i.title.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }, [categoryItems, searchQuery]);

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
    setPreviewMedia(nextMedia);
  }, [globalPreviewPool, isGlobalPlayerActive, previewMedia, selectedCatId]);

  useEffect(() => {
    if (!selectedCatId) {
      return;
    }

    const catIndex = liveCategories.findIndex((cat) => cat.id === selectedCatId);
    if (catIndex >= 0) {
      setFocusedGroupIndex(catIndex);
    }
  }, [liveCategories, selectedCatId]);

  useEffect(() => {
    if (filteredItems.length === 0) {
      setFocusedChannelIndex(0);
      return;
    }

    setFocusedChannelIndex((prev) => Math.min(prev, filteredItems.length - 1));
  }, [filteredItems]);

  useEffect(() => {
    if (filteredItems.length === 0) return;
    if (focusColumn !== 'channels') return;
    if (focusedChannelIndex >= Math.max(0, filteredItems.length - 6)) {
      loadMoreChannels();
    }
  }, [filteredItems.length, focusColumn, focusedChannelIndex, loadMoreChannels]);

  const flatListChannelsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusColumn !== 'channels') return;
    const list = flatListChannelsRef.current;
    if (list && focusedChannelIndex >= 0 && focusedChannelIndex < filteredItems.length) {
      try {
        const itemNode = list.children[focusedChannelIndex] as HTMLElement;
        if (itemNode) {
            itemNode.scrollIntoView({ 
              behavior: layout.isTvProfile ? 'auto' : 'smooth', 
              block: 'center' 
            });
        }
      } catch (error) {
        void error;
      }
    }
  }, [focusedChannelIndex, focusColumn, filteredItems.length]);

  useEffect(() => {
    const list = groupsListRef.current;
    if (!list || focusedGroupIndex < 0 || focusedGroupIndex >= liveCategories.length) {
      return;
    }

    try {
        const itemNode = list.children[focusedGroupIndex] as HTMLElement;
        if (itemNode) {
            itemNode.scrollIntoView({ 
              behavior: layout.isTvProfile ? 'auto' : 'smooth', 
              block: 'center' 
            });
        }
    } catch (error) {
      void error;
    }
  }, [focusedGroupIndex, liveCategories.length]);


  const openFullScreen = useCallback((media: Media) => {
    if (openingFullscreenRef.current) {
      return;
    }

    previewArmRef.current = { mediaId: null, armedAt: 0 };
    openingFullscreenRef.current = true;
    activePreviewChannelIdRef.current = media.id;
    window.setTimeout(() => {
      onPlayFull(media);
      window.setTimeout(() => {
        openingFullscreenRef.current = false;
      }, 500);
    }, 60);
  }, [onPlayFull]);

  useEffect(() => {
    if (!isGlobalPlayerActive) {
      return;
    }

    openingFullscreenRef.current = false;
  }, [isGlobalPlayerActive]);

  const handleMediaClick = useCallback((media: Media) => {
    const duplicateActivationWindowMs = 650;
    const minDelayForFullscreenMs = 900;
    const isSameChannel = activePreviewChannelIdRef.current === media.id;
    const isSamePreviewMedia = previewMedia?.id === media.id;
    const now = Date.now();
    const isDuplicatedPhysicalActivation =
      previewActivationGuardRef.current.mediaId === media.id
      && now - previewActivationGuardRef.current.at < duplicateActivationWindowMs;

    if (isDuplicatedPhysicalActivation) {
      return;
    }

    previewActivationGuardRef.current = { mediaId: media.id, at: now };
    const isArmedForThisChannel = previewArmRef.current.mediaId === media.id;
    const armElapsedMs = now - previewArmRef.current.armedAt;
    const isSecondIntentionalActivation =
      isSameChannel
      && isSamePreviewMedia
      && isArmedForThisChannel
      && armElapsedMs > minDelayForFullscreenMs;

    // Sempre respeitar "preview primeiro". Fullscreen apenas no segundo acionamento
    // intencional do MESMO canal (evita salto causado por duplo disparo do mesmo Enter/click).
    if (isSecondIntentionalActivation) {
      previewArmRef.current = { mediaId: null, armedAt: 0 };
      void openFullScreen(media);
      return;
    }

    openingFullscreenRef.current = false;
    setFocusColumn('channels');
    activePreviewChannelIdRef.current = media.id;
    autoPreviewActiveRef.current = false; // Usuario assumiu o controle
    previewFailureCountRef.current = 0;
    previewTriedKeysRef.current = new Set([`${media.id}::${media.videoUrl}`]);
    setSelectedMediaId(media.id);
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
  }, [openFullScreen, previewMedia?.id, setLastLiveChannel, selectedCatId, section]);

  const { registerNode, setFocusedId, focusedId } = useTvNavigation({ isActive: !showDiagnostic, subscribeFocused: true });

  // Register Groups and Channels
  useEffect(() => {
    const unregisterList: (() => void)[] = [];
    
    // Groups registration
    liveCategories.forEach((cat, index) => {
      unregisterList.push(registerNode(`tv-group-${cat.id}`, null, 'body', {
        onFocus: () => {
          setFocusColumn('groups');
          setFocusedGroupIndex(index);
          setSelectedCatId(cat.id);
          setSearchQuery('');
          setFocusedChannelIndex(0);
        },
        onEnter: () => setFocusColumn('channels')
      }));
    });

    // Channels registration (only for the current category to keep it efficient)
    filteredItems.forEach((media, index) => {
      unregisterList.push(registerNode(`tv-channel-${media.id}`, null, 'body', {
        onFocus: () => {
          setFocusColumn('channels');
          setFocusedChannelIndex(index);
          // Highlight só visual (cursor/seleção de borda)
          // Mas não carrega a mídia ainda (evita auto-play lagged) nem salta pra tela cheia no primeiro Enter
        },
        onEnter: () => {
          setFocusColumn('channels');
          handleMediaClick(media);
        }
      }));
    });

    // Preview Player registration
    if (previewMedia) {
      unregisterList.push(registerNode('tv-preview-player', null, 'body', {
        onFocus: () => setFocusColumn('preview'),
        onEnter: () => openFullScreen(previewMedia)
      }));
    }

    // Register Diagnostic Button
    unregisterList.push(registerNode('tv-btn-diagnostic', null, 'body', {
      onFocus: () => setFocusColumn('channels'),
      onEnter: () => setShowDiagnostic(true)
    }));

    return () => unregisterList.forEach(u => u());
  }, [liveCategories, filteredItems, registerNode, previewMedia, setFocusedId, handleMediaClick, openFullScreen]);

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
      setFocusedId(`tv-group-${targetGroupId}`);
      hasAppliedInitialFocusRef.current = true;
    }, 120);

    return () => window.clearTimeout(focusTimer);
  }, [liveCategories, selectedCatId, setFocusedId]);

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
          style={{ flex: 1, overflowY: 'auto', overflowX: 'visible', paddingBottom: 72, paddingInline: 6 }}
        >
          {liveCategories.map((cat, index) => (
            <TouchableHighlight
              key={cat.id}
              id={`tv-group-${cat.id}`}
              data-nav-id={`tv-group-${cat.id}`}
              onPress={() => {
                setFocusColumn('groups');
                setFocusedGroupIndex(index);
                setSelectedCatId(cat.id);
                setSearchQuery('');
                setFocusedChannelIndex(0);
                try {
                  setFocusedId(`tv-channel-${cat.id}`);
                } catch (error) {
                  void error;
                }
              }}
              underlayColor="rgba(255,255,255,0.05)"
              style={[
                styles.groupItem,
                focusColumn === 'groups' && focusedGroupIndex === index && styles.groupItemFocused,
                selectedCatId === cat.id && styles.groupItemActive
              ]}
            >
              <View style={styles.groupItemInner}>
                <Text style={[styles.groupText, selectedCatId === cat.id && styles.groupTextActive]}>
                  {cat.title}
                </Text>
                <Text style={styles.itemCount}>
                  {categoryCounts[cat.id] ?? cat.items.length}
                </Text>
                {selectedCatId === cat.id && <ChevronRight size={16} color="#E50914" />}
              </View>
            </TouchableHighlight>
          ))}
        </div>
      </View>

      {/* Channels Column */}
      <View style={styles.channelsColumn}>
        <View style={styles.columnHeader}>
          <View style={styles.searchContainer}>
            <Search size={16} color="rgba(255,255,255,0.4)" />
            <input 
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
              focusedId === 'tv-btn-diagnostic' && styles.diagnosticButtonFocused
            ]}
          >
            <View style={styles.diagnosticButtonInner}>
              <Activity size={16} color={focusedId === 'tv-btn-diagnostic' ? '#ffffff' : 'rgba(255,255,255,0.6)'} />
              <Text style={[styles.diagnosticButtonText, focusedId === 'tv-btn-diagnostic' && styles.diagnosticButtonTextFocused]}>Diagnóstico</Text>
            </View>
          </TouchableHighlight>
        </View>
        <div
          ref={flatListChannelsRef as React.RefObject<HTMLDivElement>}
          style={{ flex: 1, overflowY: 'auto', overflowX: 'visible', paddingBottom: 40, paddingInline: 6 }}
          onScroll={(e) => {
            const node = e.currentTarget;
            if (node.scrollTop + node.clientHeight >= node.scrollHeight - 260) {
              loadMoreChannels();
            }
          }}
        >
          {filteredItems.map((media, index) => {
            // OTIMIZAÇÃO FASE 4: Virtualização por distância de foco
            // Renderiza o card completo apenas para itens próximos ao cursor (+/- 15 itens)
            const isNearFocus = Math.abs(index - focusedChannelIndex) <= 15;
            
            if (!isNearFocus) {
              return (
                <div 
                  key={media.id} 
                  style={{ height: 110, width: '100%', backgroundColor: 'transparent' }} 
                />
              );
            }

            const isFavorite = favorites.includes(media.videoUrl || `media:${media.id}`) || favorites.includes(media.id);
            const channelPrograms = resolveProgramsForMedia(media);

            return (
              <TouchableHighlight
                key={media.id}
                id={`tv-channel-${media.id}`}
                data-nav-id={`tv-channel-${media.id}`}
                onPress={() => {
                  setFocusColumn('channels');
                  setFocusedChannelIndex(index);
                  // Em Android TV, alguns runtimes WebView podem disparar onPress
                  // durante navegação por foco (D-pad), causando troca de canal
                  // sem confirmação do usuário. Mantemos a troca somente no onEnter.
                  if (!layout.isTvMode) {
                    handleMediaClick(media);
                  }
                  try {
                    setFocusedId(`tv-channel-${media.id}`);
                  } catch (error) {
                    void error;
                  }
                }}
                underlayColor="rgba(255,255,255,0.05)"
                style={[
                  styles.channelItem,
                  selectedMediaId === media.id && styles.channelItemActive,
                  focusColumn === 'channels' && focusedChannelIndex === index && styles.channelItemFocused
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
                    {selectedMediaId === media.id && (
                      <View style={styles.playingIndicator}>
                        <View style={styles.pulse} />
                      </View>
                    )}
                  </View>
                  <View style={styles.channelInfo}>
                    <Text style={[styles.channelTitle, selectedMediaId === media.id && styles.channelTitleActive]} numberOfLines={1}>
                      {media.title}
                    </Text>
                    <ChannelProgramDisplay programs={channelPrograms} now={now} />
                  </View>
                </View>
              </TouchableHighlight>
            );
          })}
          
          {pageLoading && (
            <View style={styles.channelListLoading}>
              <Text style={styles.channelListLoadingText}>Carregando mais canais...</Text>
            </View>
          )}
        </div>
      </View>

      {/* Preview Player Section */}
      <View style={styles.playerSection}>
        {previewMedia && !isGlobalPlayerActive ? (
          <div
            key={previewMedia.id}
            className="w-full h-full flex flex-col"
          >
            <View style={styles.previewContainer}>
                <TouchableHighlight 
                  onPress={() => {
                    void openFullScreen(previewMedia);
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
                     onClose={() => {}}
                     onPreviewRequestFullscreen={() => {
                       void openFullScreen(previewMedia);
                     }}
                     suppressNativePreviewExitOnUnmount={false}
                     isMinimized={false}
                     isPreview={true}
                   />
                </TouchableHighlight>
                <View style={styles.previewInfoPanel}>
                   <View style={{ flex: 1 }}>
                     <Text style={styles.previewTitleSmall}>{previewMedia.title}</Text>
                   </View>
                   <TouchableHighlight
                     onPress={() => {
                       if (lastEpgUrl) {
                          fetchEPG(lastEpgUrl);
                       }
                     }}
                     underlayColor="#B80710"
                     style={[styles.fullScreenBtnSmall, { backgroundColor: '#E50914' }]}
                   >
                     <View style={styles.fullScreenBtnInner}>
                       {isLoadingEPG ? (
                          <Activity size={16} color="white" className="animate-spin" />
                       ) : (
                          <RotateCcw size={16} color="white" />
                       )}
                       <Text style={styles.fullScreenTextSmall}>
                          {isLoadingEPG ? 'CARREGANDO...' : 'CARREGAR GUIA'}
                       </Text>
                     </View>
                   </TouchableHighlight>
                </View>
                <View style={styles.previewEpgPanel}>
                  <Text style={styles.previewEpgTitle}>Guia de Programação</Text>
                  {currentPreviewProgram ? (
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
    flex: 0.22,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.06)',
  },
  channelsColumn: {
    flex: 0.28,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.015)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.06)',
  },
  playerSection: {
    flex: 0.50,
    padding: 0,
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
    paddingHorizontal: 16,
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
    paddingTop: 4,
    paddingBottom: 6,
    gap: 14,
  },
  groupText: {
    flex: 1,
    color: 'rgba(255,255,255,0.55)',
    fontSize: 16,
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
    paddingHorizontal: 20,
    paddingVertical: 20,
    marginHorizontal: 8,
    marginVertical: 15,
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
    paddingVertical: 12,
    gap: 14,
  },
  itemThumbnailContainer: {
    width: 52,
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
    fontSize: 18,
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
    height: '58%',
    minHeight: 260,
    maxHeight: SCREEN_HEIGHT * 0.64,
    zIndex: 1,
  },
  playerWrapperFocused: {
    borderWidth: 3,
    borderColor: '#E50914',
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
    paddingVertical: 16,
    paddingHorizontal: 18,
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
    paddingVertical: 14,
    paddingHorizontal: 16,
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
    paddingVertical: 9,
    paddingHorizontal: 11,
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
    paddingVertical: 6,
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
