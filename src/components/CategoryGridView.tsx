import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Heart, LayoutGrid, Search, Star, X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Category, Media } from '../types';
import { useTMDB } from '../hooks/useTMDB';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { useStore } from '../store/useStore';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { Skeleton } from './Skeleton';
import { DISK_CATEGORY_PAGE_SIZE, useDiskCategory } from '../hooks/useDiskCategory';

const GRID_NAV_SECTION = 'modal-grid';

interface GridItemProps {
  item: Media;
  navId: string;
  navSection: string;
  onPress: (media: Media) => void;
  onFocus?: () => void;
  cardWidth: number;
  cardHeight: number;
}

const GridItem = React.memo(({ item, navId, navSection, onPress, onFocus, cardWidth, cardHeight }: GridItemProps) => {
  const { registerNode } = useTvNavigation({ isActive: false, subscribeFocused: false });
  const { data: tmdbData, loading: tmdbLoading } = useTMDB(item.title, item.type, {
    includeDetails: false,
    categoryHint: item.category,
  });
  const [imgError, setImgError] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const favorites = useStore((state) => state.favorites);
  const isFavorite =
    favorites.includes(item.videoUrl || `media:${item.id}`)
    || favorites.includes(item.id);

  useEffect(() => {
    return () => {
      registerNode(navId, null);
    };
  }, [navId, registerNode]);

  const isLiveChannel = item.type === 'live';
  const hasNoCover = !item.thumbnail && !tmdbData?.thumbnail;

  const targetImage = tmdbData?.thumbnail || item.thumbnail || null;
  const hasRenderableImage = Boolean(targetImage) && !imgError;
  const displayMode = (tmdbData?.thumbnail || imgError || !targetImage || hasNoCover || tmdbLoading || isLiveChannel) ? 'cover' : 'contain';

  return (
    <div style={{ width: cardWidth, height: cardHeight, aspectRatio: '2 / 3', backgroundColor: '#1f2937' }}>
      <div
        role="button"
        tabIndex={0}
        data-nav-id={navId}
        ref={(element) =>
          registerNode(navId, element, navSection, { onEnter: () => onPress(item), onFocus })
        }
        className="media-card-transition will-change-transform"
        onFocus={() => {
          setIsFocused(true);
          onFocus?.();
        }}
        onBlur={() => setIsFocused(false)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={() => onPress(item)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPress(item);
          }
        }}
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 0,
          overflow: 'hidden',
          backgroundColor: '#1a1a1a',
          border: isFocused ? '2px solid #E50914' : '2px solid rgba(255,255,255,0.05)',
          cursor: 'pointer',
          position: 'relative',
          transform: isFocused ? 'translate3d(0,0,0) scale(1.02)' : 'translate3d(0,0,0)',
          boxShadow: isFocused ? '0 0 0 2px rgba(229,9,20,0.25), 0 12px 28px rgba(0,0,0,0.42)' : 'none',
          transition: 'transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
        }}
      >
        {hasRenderableImage ? (
          <img
            src={targetImage || undefined}
            alt={item.title}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImgError(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: displayMode as 'cover' | 'contain',
              opacity: imageLoaded ? 1 : 0,
              transition: 'opacity 350ms ease-in-out',
              display: 'block',
              position: 'relative',
              zIndex: 2,
            }}
          />
        ) : null}

        {(!imageLoaded || imgError) && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: 12,
              color: 'rgba(255,255,255,0.78)',
              fontSize: 18,
              fontWeight: 900,
              letterSpacing: 2,
              textTransform: 'uppercase',
              background: 'linear-gradient(135deg, #1f2937, #0f172a, #111827)',
              zIndex: 1,
            }}
          >
            <span style={{ opacity: 0.12 }}>{String(item.title || '?').slice(0, 2)}</span>
          </div>
        )}

        {isFavorite && (
          <div
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: 'rgba(0,0,0,0.72)',
              border: '1px solid rgba(255,255,255,0.18)',
              alignItems: 'center',
              justifyContent: 'center',
              display: 'flex',
              zIndex: 2,
            }}
          >
            <Heart size={13} color="#ffffff" fill="#E50914" />
          </div>
        )}

        {(isFocused || isHovered) && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              padding: 12,
              backgroundColor: 'rgba(0,0,0,0.82)',
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
            }}
          >
            <div
              style={{
                color: 'white',
                fontSize: 14,
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 1,
                WebkitBoxOrient: 'vertical' as any,
              }}
            >
              {item.title}
            </div>

            {tmdbData?.rating && (
              <div style={{ display: 'flex', alignItems: 'center', marginTop: 4, gap: 4 }}>
                <Star size={10} color="#EAB308" fill="#EAB308" />
                <span style={{ color: '#EAB308', fontSize: 10, fontWeight: 900 }}>{tmdbData.rating}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

interface CategoryGridViewProps {
  category: Category;
  onClose: () => void;
  onSelectMedia: (media: Media) => void;
}

export const CategoryGridView: React.FC<CategoryGridViewProps> = ({ category, onClose, onSelectMedia }) => {
  const [search, setSearch] = useState('');
  const layout = useResponsiveLayout();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => {
    onCloseRef.current();
  }, []);
  const { registerNode, setFocusedId } = useTvNavigation({ isActive: true, onBack: requestClose, subscribeFocused: false });
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const setSelectedCategoryName = useStore((state) => state.setSelectedCategoryName);
  const setVisibleItems = useStore((state) => state.setVisibleItems);
  const [page, setPage] = useState(0);
  const [diskItems, setDiskItems] = useState<Media[]>([]);
  const { items: pageItems, loading: pageLoading, hasMore } = useDiskCategory(
    category.title,
    page,
    DISK_CATEGORY_PAGE_SIZE,
  );
  const loadMore = useCallback(() => {
    if (pageLoading || !hasMore) return;
    setPage((prev) => prev + 1);
  }, [hasMore, pageLoading]);

  useEffect(() => {
    const focusFirstItem = () => {
      const firstItem = document.querySelector<HTMLElement>('[data-nav-id^="grid-item-"]');
      const firstItemId = firstItem?.dataset?.navId || null;
      if (!firstItem || !firstItemId) return;
      setFocusedId(firstItemId);
      firstItem.focus({ preventScroll: true });
    };

    const focusSearchInput = () => {
      setFocusedId('grid-search');
      const searchInput = document.querySelector('[data-nav-id="grid-search"]') as HTMLElement | null;
      if (searchInput) {
        searchInput.focus({ preventScroll: true });
      }
    };

    const unregisterList: (() => void)[] = [];

    unregisterList.push(registerNode({
      id: 'grid-close',
      section: GRID_NAV_SECTION,
      type: 'button',
      onEnter: requestClose,
      onBack: requestClose,
      onDown: focusSearchInput,
    }));

    unregisterList.push(registerNode({
      id: 'grid-search',
      section: GRID_NAV_SECTION,
      type: 'input',
      onEnter: () => {
        const input = document.querySelector('[data-nav-id="grid-search"]') as HTMLInputElement | null;
        input?.focus();
      },
      onBack: requestClose,
      onDown: focusFirstItem,
      onUp: () => setFocusedId('grid-close'),
    }));

    // Focus on the first element (search) when grid mounts.
    // Retry across frames to survive heavy virtualized renders on TV devices.
    const timer = setTimeout(() => {
      focusSearchInput();
      requestAnimationFrame(() => {
        focusSearchInput();
      });
    }, 120);

    return () => {
      clearTimeout(timer);
      unregisterList.forEach((unregister) => unregister());
    };
  }, [registerNode, requestClose, setFocusedId]);

  useEffect(() => {
    const handleModalBack = (event: KeyboardEvent) => {
      const key = event.key;
      const keyCode = (event as KeyboardEvent & { keyCode?: number }).keyCode || 0;
      const isBack = key === 'Escape' || key === 'Back' || keyCode === 4;
      if (!isBack) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
    };

    window.addEventListener('keydown', handleModalBack, true);
    return () => window.removeEventListener('keydown', handleModalBack, true);
  }, [requestClose]);

  useEffect(() => {
    setSearch('');
    setPage(0);
    setDiskItems([]);
    setSelectedCategoryName(category.title);
    setVisibleItems([]);
  }, [category.title, setSelectedCategoryName, setVisibleItems]);

  useEffect(() => {
    // Import helper functions
    import('../lib/titleCleaner').then(({ cleanMediaTitle, extractSeriesInfo }) => {
      setDiskItems((previous) => {
        const base = page === 0 ? [] : previous;
        const seen = new Set(base.map((item) => `${item.id}`));
        const merged = [...base];
        const seriesFound = new Map<string, Media>();
        
        // Identifica as séries já existentes para atualização de episódios
        merged.forEach(item => {
          if (item.type === 'series') {
            seriesFound.set(item.title.toLowerCase().trim(), item);
          }
        });

        for (const item of pageItems) {
          const { cleanTitle, season, episode } = cleanMediaTitle(item.title);
          
          if (season !== undefined && episode !== undefined) {
            const seriesKey = cleanTitle.toLowerCase().trim();
            let existingSeries = seriesFound.get(seriesKey);
            
            if (!existingSeries) {
              existingSeries = {
                ...item,
                id: `grid-series-${item.id}`,
                title: cleanTitle,
                type: 'series' as any,
                seasons: []
              };
              seriesFound.set(seriesKey, existingSeries);
              merged.push(existingSeries);
            }
            
            // Adiciona o episódio à estrutura de temporadas
            const ep = {
              id: item.id,
              seasonNumber: season,
              episodeNumber: episode,
              title: item.title,
              videoUrl: item.videoUrl
            };
            
            const seasons = (existingSeries as any).seasons || [];
            let seasonObj = seasons.find((s: any) => s.seasonNumber === season);
            if (!seasonObj) {
              seasonObj = { seasonNumber: season, episodes: [] };
              seasons.push(seasonObj);
              seasons.sort((a: any, b: any) => a.seasonNumber - b.seasonNumber);
            }
            
            // Evita duplicatas de episódios
            if (!seasonObj.episodes.find((e: any) => e.id === ep.id)) {
              seasonObj.episodes.push(ep);
              seasonObj.episodes.sort((a: any, b: any) => a.episodeNumber - b.episodeNumber);
            }
            
            existingSeries.seasons = seasons;
          } else {
            const key = `${item.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              merged.push(item);
            }
          }
        }

        return merged;
      });
    });
  }, [page, pageItems]);

  const sourceItems = useMemo(() => {
    const fallbackItems = Array.isArray(category.items) ? category.items : [];
    if (diskItems.length > 0) return diskItems;

    // Categorias virtuais (ex: tendências TMDB) não existem no índice local.
    // Nesses casos, usamos os itens recebidos pela própria categoria da Home.
    if (!pageLoading && page === 0 && !hasMore && fallbackItems.length > 0) {
      return fallbackItems;
    }

    return diskItems;
  }, [category.items, diskItems, hasMore, page, pageLoading]);

  useEffect(() => {
    setVisibleItems(sourceItems.slice(0, 80));
  }, [setVisibleItems, sourceItems]);

  useEffect(() => {
    const node = scrollParentRef.current;
    if (!node) return;

    const handleScroll = () => {
      const nearBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 320;
      if (nearBottom) loadMore();
    };

    node.addEventListener('scroll', handleScroll);
    return () => node.removeEventListener('scroll', handleScroll);
  }, [loadMore]);

  const filteredItems = useMemo(() => {
    if (!search) return sourceItems;
    const normalized = search.toLowerCase();
    return sourceItems.filter((item) => item.title.toLowerCase().includes(normalized));
  }, [search, sourceItems]);

  const shouldReserveSideRail = (!layout.isMobile || layout.isTvProfile);
  const sideRailOffset = shouldReserveSideRail ? (layout.sideRailCollapsedWidth || 80) : 0;
  // Mantem o "Ver tudo" com metragem equivalente aos cards da Home.
  // Em Firestick/Android TV, garantimos 5 colunas reais na viewport de CSS.
  const railSafePadding = shouldReserveSideRail ? (layout.isTvProfile ? 8 : 16) : 0;
  const gridGap = layout.isTvProfile ? 10 : 14;
  const contentPadding = layout.isTvProfile ? 20 : layout.isMobile ? 16 : 28;
  const gridAreaWidth =
    layout.width - sideRailOffset - ((contentPadding * 2) + railSafePadding);
  const baseCardWidth = layout.isTvProfile ? 240 : layout.isCompact ? 210 : 230;
  const tvTargetColumns = 5;
  const resolvedColumns = layout.isTvProfile
    ? tvTargetColumns
    : layout.isMobile
      ? 2
      : Math.max(1, Math.floor((gridAreaWidth + gridGap) / (baseCardWidth + gridGap)));
  const columns = Math.max(1, resolvedColumns);
  const cardWidth = layout.isTvProfile
    ? Math.max(120, Math.floor((gridAreaWidth - (gridGap * (columns - 1))) / columns))
    : layout.isMobile
      ? Math.max(1, Math.floor((gridAreaWidth - gridGap) / 2))
      : Math.max(1, baseCardWidth);
  const cardHeight = Math.round(cardWidth * 1.5);
  const gridTitleSize = layout.isTvProfile ? 26 : layout.isCompact ? 22 : 32;
  const gridMetaSize = layout.isTvProfile ? 12 : layout.isCompact ? 12 : 14;

  const rowItems = useMemo(() => {
    const rows: Media[][] = [];
    for (let index = 0; index < filteredItems.length; index += columns) {
      rows.push(filteredItems.slice(index, index + columns));
    }
    return rows;
  }, [columns, filteredItems]);

  const rowVirtualizer = useVirtualizer({
    count: rowItems.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => cardHeight + gridGap,
    overscan: 5,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const innerHeight = rowVirtualizer.getTotalSize() + (contentPadding * 2);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 1.08 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.04 }}
      transition={{ duration: 0.26, ease: 'easeOut' }}
      style={{
        position: 'fixed',
        top: 0,
        left: sideRailOffset,
        right: 0,
        bottom: 0,
        zIndex: 230,
        backgroundColor: '#050505',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          minHeight: layout.isTvProfile ? 0 : layout.isCompact ? 0 : 120,
          backgroundColor: '#050505',
          justifyContent: 'center',
          paddingBottom: layout.isTvProfile ? 14 : layout.isCompact ? 16 : 20,
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          paddingLeft: contentPadding + railSafePadding,
          paddingRight: contentPadding,
          paddingTop: layout.isTvProfile ? 20 : layout.isMobile ? 20 : 26,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: layout.isCompact ? 14 : 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <LayoutGrid size={layout.isTvProfile ? 26 : layout.isMobile ? 24 : 32} color="#E50914" />
            <div style={{ marginLeft: layout.isTvProfile ? 12 : layout.isMobile ? 12 : 16 }}>
              <div
                style={{
                  fontSize: gridTitleSize,
                  fontWeight: 900,
                  color: 'white',
                  textTransform: 'uppercase',
                  letterSpacing: layout.isTvProfile ? 0.6 : layout.isCompact ? 0.5 : 1,
                }}
              >
                {category.title}
              </div>
              <div
                style={{
                  fontSize: gridMetaSize,
                  color: 'rgba(255,255,255,0.5)',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: layout.isTvProfile ? 1.2 : layout.isCompact ? 1.2 : 2,
                  marginTop: 4,
                }}
              >
                {sourceItems.length}{hasMore ? '+' : ''} conteudos carregados
              </div>
            </div>
          </div>

          <button
            type="button"
            tabIndex={0}
            data-nav-id="grid-close"
            onClick={onClose}
            style={{
              width: layout.isTvProfile ? 48 : 56,
              height: layout.isTvProfile ? 48 : 56,
              borderRadius: 50,
              border: 'none',
              backgroundColor: 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <X size={layout.isTvProfile ? 24 : layout.isMobile ? 24 : 32} color="white" />
          </button>
        </div>

        <div
          style={{
            width: '100%',
            height: layout.isTvProfile ? 46 : layout.isCompact ? 48 : 50,
            backgroundColor: 'rgba(255,255,255,0.05)',
            borderRadius: 25,
            display: 'flex',
            alignItems: 'center',
            border: '1px solid rgba(255,255,255,0.1)',
            marginTop: layout.isTvProfile ? 10 : layout.isCompact ? 0 : 18,
            padding: '0 16px',
          }}
        >
          <Search size={layout.isMobile ? 18 : 20} color="rgba(255,255,255,0.4)" />
          <input
            type="text"
            value={search}
            tabIndex={0}
            data-nav-id="grid-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar nesta categoria..."
            style={{
              flex: 1,
              height: '100%',
              color: 'white',
              fontSize: layout.isTvProfile ? 15 : 16,
              padding: '0 16px',
              background: 'transparent',
              border: 'none',
              outline: 'none',
            }}
          />
        </div>
      </div>

      <div
        ref={scrollParentRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          transform: 'translate3d(0,0,0)',
        }}
      >
        {rowItems.length === 0 ? (
          <div
            style={{
              padding: 100,
              textAlign: 'center',
              color: 'rgba(255,255,255,0.3)',
              fontSize: 18,
            }}
          >
            {pageLoading ? 'Carregando categoria...' : 'Nenhum conteudo combina com sua busca.'}
          </div>
        ) : (
          <div
            style={{
              height: innerHeight,
              position: 'relative',
            }}
          >
            {virtualRows.map((virtualRow) => {
              const row = rowItems[virtualRow.index] || [];
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: contentPadding + railSafePadding,
                    right: contentPadding,
                    height: cardHeight,
                    display: 'grid',
                    gridTemplateColumns: `repeat(${columns}, ${cardWidth}px)`,
                    columnGap: gridGap,
                    rowGap: gridGap,
                    justifyContent: 'start',
                    transform: `translate3d(0, ${virtualRow.start + contentPadding}px, 0)`,
                  }}
                >
                  {row.map((item, columnIndex) => {
                    const absoluteIndex = (virtualRow.index * columns) + columnIndex;
                    return (
                      <GridItem
                        key={`${item.id}-${absoluteIndex}`}
                        item={item}
                        navId={`grid-item-${item.id}-${absoluteIndex}`}
                        navSection={GRID_NAV_SECTION}
                        onPress={onSelectMedia}
                        onFocus={() => {
                          if (absoluteIndex >= Math.max(0, filteredItems.length - (columns * 2))) {
                            loadMore();
                          }
                        }}
                        cardWidth={cardWidth}
                        cardHeight={cardHeight}
                      />
                    );
                  })}
                </div>
              );
            })}
            {pageLoading && (
              <div
                style={{
                  position: 'absolute',
                  left: contentPadding + railSafePadding,
                  right: contentPadding,
                  bottom: Math.max(18, contentPadding - 6),
                  textAlign: 'center',
                  color: 'rgba(255,255,255,0.56)',
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: 1,
                }}
              >
                Carregando mais...
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
};
