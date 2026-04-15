import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { View, Text, StyleSheet, ScrollView, TouchableHighlight, Image, Dimensions, FlatList, ListRenderItem } from 'react-native';
import { Radio, ChevronRight, Play, Maximize2, Search, Heart } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Category, Media } from '../types';
import { VideoPlayer } from './VideoPlayer';
import { NativeVideoPlayer } from '../lib/nativeVideoPlayer';
import { useStore } from '../store/useStore';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DISK_CATEGORY_PAGE_SIZE, useDiskCategory } from '../hooks/useDiskCategory';

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
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
type LiveTvFocusColumn = 'groups' | 'channels' | 'preview';

interface VirtualizedChannelsListProps {
  items: Media[];
  scrollParentRef: React.RefObject<HTMLDivElement>;
  favorites: string[];
  epgData: any;
  now: number;
  focusColumn: LiveTvFocusColumn;
  focusedChannelIndex: number;
  selectedMediaId: string | null;
  onChannelPress: (media: Media, index: number) => void;
}

const VirtualizedChannelsList = React.memo(({
  items,
  scrollParentRef,
  favorites,
  epgData,
  now,
  focusColumn,
  focusedChannelIndex,
  selectedMediaId,
  onChannelPress,
}: VirtualizedChannelsListProps) => {
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 74, // Approximate height of channelItem
    overscan: 10,
  });

  // Sync scroll on focus change (manual for virtual list)
  useEffect(() => {
    if (focusColumn !== 'channels') return;
    rowVirtualizer.scrollToIndex(focusedChannelIndex, { align: 'center', behavior: 'smooth' });
  }, [focusedChannelIndex, focusColumn, rowVirtualizer]);

  return (
    <div
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const media = items[virtualRow.index];
        const index = virtualRow.index;
        if (!media) return null;

        const isFavorite =
          favorites.includes(media.videoUrl || `media:${media.id}`) ||
          favorites.includes(media.id);
        const channelPrograms =
          (media.tvgId && epgData?.[media.tvgId]) ||
          (media.tvgName && epgData?.[media.tvgName]) ||
          [];
        const currentProgram = channelPrograms.find(
          (program) => now >= program.start && now < program.stop
        );

        return (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <TouchableHighlight
              onPress={() => onChannelPress(media, index)}
              underlayColor="rgba(255,255,255,0.05)"
              style={[
                styles.channelItem,
                focusColumn === 'channels' && focusedChannelIndex === index && styles.channelItemFocused,
                selectedMediaId === media.id && styles.channelItemActive,
                { height: 70, marginVertical: 2 } // Force height consistency
              ]}
              id={`tv-channel-${media.id}`}
              data-nav-id={`tv-channel-${media.id}`}
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
                  {currentProgram && (
                    <Text style={styles.channelProgram} numberOfLines={1}>
                      {currentProgram.title}
                    </Text>
                  )}
                  <Text style={styles.channelSubtitle} numberOfLines={1}>
                    {media.category}
                  </Text>
                </View>
              </View>
            </TouchableHighlight>
          </div>
        );
      })}
    </div>
  );
});

export const LiveTVGrid: React.FC<LiveTVGridProps> = ({ categories, onPlayFull, layout, externalMedia, isGlobalPlayerActive }) => {
  const favorites = useStore((state) => state.favorites);
  const epgData = useStore((state) => state.epgData);
  const setSelectedCategoryName = useStore((state) => state.setSelectedCategoryName);
  const setVisibleItems = useStore((state) => state.setVisibleItems);
  const liveCategories = useMemo(
    () => categories.filter((c) => c.type === 'live'),
    [categories],
  );

  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [categoryItems, setCategoryItems] = useState<Media[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [previewMedia, setPreviewMedia] = useState<Media | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const openingFullscreenRef = useRef(false);
  const activePreviewChannelIdRef = useRef<string | null>(null);
  const [isPromotingToFullscreen, setIsPromotingToFullscreen] = useState(false);
  const [focusColumn, setFocusColumn] = useState<LiveTvFocusColumn>('groups');
  const [focusedGroupIndex, setFocusedGroupIndex] = useState(0);
  const [focusedChannelIndex, setFocusedChannelIndex] = useState(0);
  const groupsListRef = useRef<FlatList<Category> | null>(null);
  const channelsListRef = useRef<HTMLDivElement | null>(null);
  const selectedCategory = useMemo(
    () => liveCategories.find((c) => c.id === selectedCatId) || null,
    [liveCategories, selectedCatId],
  );
  const { items: pageItems, loading: pageLoading, hasMore: hasMorePages } = useDiskCategory(
    selectedCategory?.title || null,
    page,
    DISK_CATEGORY_PAGE_SIZE,
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

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return categoryItems;
    return categoryItems.filter((i) =>
      i.title.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }, [categoryItems, searchQuery]);

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

  useEffect(() => {
    const node = channelsListRef.current;
    if (!node) return;

    const handleScroll = () => {
      const nearBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 260;
      if (nearBottom) {
        loadMoreChannels();
      }
    };

    node.addEventListener('scroll', handleScroll);
    return () => node.removeEventListener('scroll', handleScroll);
  }, [loadMoreChannels]);

  useEffect(() => {
    const list = groupsListRef.current;
    if (!list || focusedGroupIndex < 0 || focusedGroupIndex >= liveCategories.length) {
      return;
    }

    try {
      list.scrollToIndex({ index: focusedGroupIndex, animated: true, viewPosition: 0.3 });
    } catch (e) {}
  }, [focusedGroupIndex, liveCategories.length]);


  const openFullScreen = async (media: Media) => {
    if (openingFullscreenRef.current) {
      return;
    }

    openingFullscreenRef.current = true;
    setIsPromotingToFullscreen(true);
    activePreviewChannelIdRef.current = media.id;

    if (Capacitor.isNativePlatform()) {
      try {
        // Nao bloqueia a transicao para fullscreen se o plugin demorar para responder.
        await Promise.race([
          NativeVideoPlayer.exitPlayer(),
          new Promise((resolve) => window.setTimeout(resolve, 450)),
        ]);
      } catch (exitError) {
        console.warn('[LiveTVGrid] Falha ao encerrar player de previa antes do fullscreen:', exitError);
      }
    }

    window.setTimeout(() => {
      onPlayFull(media);
      window.setTimeout(() => {
        openingFullscreenRef.current = false;
        setIsPromotingToFullscreen(false);
      }, 500);
    }, 60);
  };

  useEffect(() => {
    if (!isGlobalPlayerActive) {
      return;
    }

    openingFullscreenRef.current = false;
    setIsPromotingToFullscreen(false);
  }, [isGlobalPlayerActive]);

  const handleMediaClick = (media: Media) => {
    const isSecondClickOnSameChannel = activePreviewChannelIdRef.current === media.id;

    if (isSecondClickOnSameChannel) {
      // Second click: Full screen
      void openFullScreen(media);
    } else {
      // First click: Preview
      openingFullscreenRef.current = false;
      setIsPromotingToFullscreen(false);
      setFocusColumn('channels');
      activePreviewChannelIdRef.current = media.id;
      setSelectedMediaId(media.id);
      setPreviewMedia(media);
    }
  };

  const { registerNode, setFocusedId } = useTvNavigation({ isActive: true });

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
          setSelectedMediaId(media.id);
          setPreviewMedia(media);
          activePreviewChannelIdRef.current = media.id;
        },
        onEnter: () => handleMediaClick(media)
      }));
    });

    // Preview Player registration
    if (previewMedia) {
      unregisterList.push(registerNode('tv-preview-player', null, 'body', {
        onFocus: () => setFocusColumn('preview'),
        onEnter: () => openFullScreen(previewMedia)
      }));
    }

    return () => unregisterList.forEach(u => u());
  }, [liveCategories, filteredItems, registerNode, previewMedia, setFocusedId]);

  if (liveCategories.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Nenhum canal ao vivo encontrado.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Groups Column */}
      <View style={styles.groupsColumn}>
        <View style={styles.columnHeader}>
          <Radio size={20} color="#E50914" />
          <Text style={styles.columnTitle}>GRUPOS</Text>
        </View>
        <FlatList
          ref={groupsListRef}
          data={liveCategories}
          keyExtractor={cat => cat.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 40 }}
          removeClippedSubviews={true}
          initialNumToRender={20}
          onScrollToIndexFailed={() => {}}
          renderItem={({ item: cat, index }) => (
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
                setFocusedId(`tv-group-${cat.id}`);
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
                  {selectedCatId === cat.id ? `${filteredItems.length}${hasMorePages ? '+' : ''}` : cat.items.length}
                </Text>
                {selectedCatId === cat.id && <ChevronRight size={16} color="#E50914" />}
              </View>
            </TouchableHighlight>
          )}
        />
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
        </View>
        <div
          ref={channelsListRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          <VirtualizedChannelsList 
            items={filteredItems}
            scrollParentRef={channelsListRef}
            favorites={favorites}
            epgData={epgData}
            now={now}
            focusColumn={focusColumn}
            focusedChannelIndex={focusedChannelIndex}
            selectedMediaId={selectedMediaId}
            onChannelPress={(media, index) => {
              setFocusColumn('channels');
              setFocusedChannelIndex(index);
              handleMediaClick(media);
              setFocusedId(`tv-channel-${media.id}`);
            }}
          />
          {pageLoading && (
            <View style={styles.channelListLoading}>
              <Text style={styles.channelListLoadingText}>Carregando mais canais...</Text>
            </View>
          )}
        </div>
      </View>

      {/* Preview Player Section */}
      <View style={styles.playerSection}>
        <AnimatePresence mode="wait">
          {previewMedia && !isGlobalPlayerActive ? (
            <motion.div
              key={previewMedia.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
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
                     onClose={() => {
                       if (!openingFullscreenRef.current) {
                         activePreviewChannelIdRef.current = null;
                         setPreviewMedia(null);
                       }
                     }}
                     onPreviewRequestFullscreen={() => {
                       void openFullScreen(previewMedia);
                     }}
                     suppressNativePreviewExitOnUnmount={isPromotingToFullscreen || !!isGlobalPlayerActive}
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
                       void openFullScreen(previewMedia);
                     }}
                     underlayColor="#B91C1C"
                     style={styles.fullScreenBtnSmall}
                   >
                     <View style={styles.fullScreenBtnInner}>
                       <Maximize2 size={16} color="white" />
                       <Text style={styles.fullScreenTextSmall}>TELA CHEIA</Text>
                     </View>
                   </TouchableHighlight>
                </View>
              </View>
            </motion.div>
          ) : (
            <View style={styles.playerPlaceholder}>
              <View style={styles.placeholderIconContainer}>
                <Radio size={64} color="rgba(255,255,255,0.05)" />
              </View>
              <Text style={styles.placeholderText}>Selecione um canal para visualizar</Text>
            </View>
          )}
        </AnimatePresence>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'transparent',
    gap: 0,
    overflow: 'hidden',
    height: '100%', // Ensure it fills screen even if flex 1 is tricky
  },
  groupsColumn: {
    width: 240,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.05)',
  },
  channelsColumn: {
    width: 340,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.05)',
  },
  playerSection: {
    flex: 1,
    padding: 0,
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    backgroundColor: '#000',
  },
  columnHeader: {
    padding: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
    marginBottom: 10,
  },
  columnTitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 2,
    fontFamily: 'Outfit',
  },
  groupItem: {
    paddingHorizontal: 16,
    marginHorizontal: 8,
    marginVertical: 2,
    borderRadius: 8,
  },
  groupItemActive: {
    backgroundColor: 'rgba(229,9,20,0.1)',
  },
  groupItemFocused: {
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.65)',
  },
  groupItemInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  groupText: {
    flex: 1,
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Outfit',
  },
  groupTextActive: {
    color: 'white',
  },
  itemCount: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.2)',
    fontWeight: '700',
    minWidth: 24,
    textAlign: 'center',
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  searchInput: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 0,
    color: 'white',
    fontSize: 14,
    fontFamily: 'Outfit',
    outlineStyle: 'none',
  } as any,
  channelListLoading: {
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelListLoadingText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Outfit',
  },
  channelItem: {
    paddingHorizontal: 16,
    marginHorizontal: 8,
    marginVertical: 2,
    borderRadius: 10,
  },
  channelItemActive: {
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  channelItemFocused: {
    borderWidth: 2,
    borderColor: '#E50914',
    backgroundColor: 'rgba(229,9,20,0.1)',
  },
  channelItemInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 16,
  },
  itemThumbnailContainer: {
    width: 48,
    aspectRatio: '1/1',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
    position: 'relative',
  },
  itemThumbnail: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  },
  favoriteBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  channelInfo: {
    flex: 1,
    gap: 4,
  },
  channelTitle: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Outfit',
  },
  channelTitleActive: {
    color: '#3B82F6',
  },
  channelSubtitle: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 11,
    fontFamily: 'Outfit',
  },
  channelProgram: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Outfit',
  },
  playingIndicator: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(229,9,20,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E50914',
    shadowColor: '#E50914',
    shadowOpacity: 1,
    shadowRadius: 10,
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
    backgroundColor: '#000',
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
    backgroundColor: 'rgba(0,0,0,0.6)',
    backdropFilter: 'blur(10px)',
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  } as any,
  previewTitleSmall: {
    fontSize: 18,
    fontWeight: '800',
    color: 'white',
    fontFamily: 'Outfit',
  },
  fullScreenBtnSmall: {
    backgroundColor: '#E50914',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  fullScreenTextSmall: {
    color: 'white',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 1,
    fontFamily: 'Outfit',
  },
  fullScreenBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
