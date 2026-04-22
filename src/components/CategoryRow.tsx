import React, { useMemo } from 'react';
import { ChevronRight, Play, Star } from 'lucide-react';
import type { Category, Media, PlaylistItem } from '../types';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { useTMDB } from '../hooks/useTMDB';
import type { TMDBData } from '../lib/tmdb';

type RowItem = Media | PlaylistItem;

interface CategoryRowProps {
  category?: Category;
  title?: string;
  items?: RowItem[];
  rowIndex: number;
  disableSideMenuOffset?: boolean;
  tightTopSpacing?: boolean;
  preloadedTMDBByKey?: Record<string, TMDBData>;
  tmdbMissedByKey?: Record<string, true>;
  onMediaFocus?: (media: Media, id: string) => void;
  onMediaPress?: (media: Media) => void;
  onSeeAll?: (category: Category) => void;
}

interface MediaCardProps {
  item: RowItem;
  navId: string;
  cardWidth: number;
  cardHeight: number;
  imageUrl: string;
  onPress?: (media: Media) => void;
  onFocus?: (media: Media, id: string) => void;
}

const sanitizeCategoryId = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'categoria';

const isMedia = (item: RowItem): item is Media => 'videoUrl' in item;

const resolveImageUrl = (item: RowItem, preloadedTMDBByKey?: Record<string, TMDBData>): string => {
  const metadata = preloadedTMDBByKey?.[item.id];
  const isLive = isMedia(item) && (item.type === 'live' || (item as any).isLive);

  const candidates = [
    // Se for Live, preferimos backdrop (horizontal), se for Filme/Serie preferimos poster (thumbnail/vertical)
    isLive ? metadata?.backdrop : metadata?.thumbnail,
    isLive ? metadata?.thumbnail : metadata?.backdrop,
    isMedia(item) ? (isLive ? item.backdrop : item.thumbnail) : '',
    isMedia(item) ? (isLive ? item.thumbnail : item.backdrop) : '',
    'logo' in item ? item.logo : '',
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return '';
};

const MediaCard = React.memo(({
  item,
  navId,
  cardWidth,
  cardHeight,
  imageUrl,
  onPress,
  onFocus,
}: MediaCardProps) => {
  const { registerNode, focusedId } = useTvNavigation({ isActive: false, subscribeFocused: true });
  const mediaType = isMedia(item) ? String(item.type || '').toLowerCase() : '';
  const shouldUseTMDBImageFallback =
    isMedia(item)
    && !String(imageUrl || '').trim()
    && (mediaType === 'movie' || mediaType === 'series');
  const { data: tmdbFallbackData } = useTMDB(
    shouldUseTMDBImageFallback ? item.title : undefined,
    shouldUseTMDBImageFallback ? mediaType : undefined,
    {
      includeDetails: false,
      categoryHint: isMedia(item) ? item.category : undefined,
    },
  );
  const resolvedImageUrl = useMemo(() => {
    const local = String(imageUrl || '').trim();
    if (local) return local;
    const tmdbThumb = String(tmdbFallbackData?.thumbnail || '').trim();
    if (tmdbThumb) return tmdbThumb;
    const tmdbBackdrop = String(tmdbFallbackData?.backdrop || '').trim();
    if (tmdbBackdrop) return tmdbBackdrop;
    return '';
  }, [imageUrl, tmdbFallbackData?.backdrop, tmdbFallbackData?.thumbnail]);
  const [imageStatus, setImageStatus] = React.useState<'loading' | 'loaded' | 'error'>(imageUrl ? 'loading' : 'error');
  
  const isFocused = focusedId === navId;
  const canOpenMedia = Boolean(onPress && isMedia(item));

  // Reset status when image changes
  React.useEffect(() => {
    setImageStatus(resolvedImageUrl ? 'loading' : 'error');
  }, [resolvedImageUrl]);

  return (
    <div
      ref={(el) =>
        registerNode(navId, el, 'body', {
          onEnter: () => {
            if (canOpenMedia) {
              onPress?.(item as Media);
            }
          },
          onFocus: () => {
            if (isMedia(item)) {
              onFocus?.(item, navId);
            }
          },
        })
      }
      data-nav-id={navId}
      tabIndex={0}
      onClick={() => {
        if (canOpenMedia) {
          onPress?.(item as Media);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && canOpenMedia) {
          onPress?.(item as Media);
        }
      }}
      className="media-card-transition"
      style={{
        width: cardWidth,
        height: cardHeight,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: '#111827',
        position: 'relative',
        flex: '0 0 auto',
        cursor: 'pointer',
        transform: isFocused ? 'translate3d(0, -6px, 0) scale(1.04)' : 'translate3d(0, 0, 0) scale(1)',
        transition: 'transform 150ms cubic-bezier(0.2, 0, 0.2, 1)',
        willChange: 'transform',
        zIndex: isFocused ? 10 : 1,
      }}
    >
      {/* Background Fallback (Always there during loading or error) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #1f2937, #0f172a, #111827)',
          color: 'rgba(255,255,255,0.78)',
          fontSize: 20,
          fontWeight: 900,
          textTransform: 'uppercase',
          letterSpacing: 2,
          opacity: imageStatus !== 'loaded' ? 1 : 0,
          transition: 'opacity 300ms ease',
        }}
      >
        <span style={{ opacity: 0.15 }}>{String(item.title || '?').slice(0, 2)}</span>
      </div>

      {resolvedImageUrl && imageStatus !== 'error' && (
        <img
          src={resolvedImageUrl}
          alt={item.title}
          onLoad={() => setImageStatus('loaded')}
          onError={() => setImageStatus('error')}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: imageStatus === 'loaded' ? 1 : 0,
            transition: 'opacity 400ms ease-in-out',
            display: 'block',
          }}
        />
      )}

      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.12) 55%, transparent 100%)',
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: 10,
          right: 10,
          bottom: 9,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: 0.88 }}>
          <Play size={11} color="#fff" fill="#fff" />
          {isMedia(item) && (
            <>
              <span style={{ color: 'rgba(255,255,255,0.95)', fontSize: 11, fontWeight: 700, letterSpacing: 0.2 }}>
                {item.year || ''}
              </span>
              {!!item.rating && (
                <>
                  <Star size={11} color="#facc15" fill="#facc15" />
                  <span style={{ color: 'rgba(255,255,255,0.92)', fontSize: 11, fontWeight: 700 }}>{item.rating}</span>
                </>
              )}
            </>
          )}
        </div>
        <span
          style={{
            color: '#fff',
            fontSize: 13,
            fontWeight: 800,
            lineHeight: 1.25,
            textShadow: '0 2px 6px rgba(0,0,0,0.7)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.title}
        </span>
      </div>
    </div>
  );
});

export const CategoryRow: React.FC<CategoryRowProps> = ({
  category,
  title,
  items,
  rowIndex,
  disableSideMenuOffset = false,
  tightTopSpacing = false,
  preloadedTMDBByKey,
  onMediaFocus,
  onMediaPress,
  onSeeAll,
}) => {
  const layout = useResponsiveLayout();
  const { registerNode } = useTvNavigation({ isActive: false, subscribeFocused: false });
  const [isVisible, setIsVisible] = React.useState(false);
  const [renderedCount, setRenderedCount] = React.useState(layout.isTvProfile ? 8 : 12);
  const rowRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { rootMargin: '600px 0px' }
    );
    if (rowRef.current) observer.observe(rowRef.current);
    return () => observer.disconnect();
  }, []);

  const onFocusWrapper = React.useCallback((media: Media, id: string, index: number) => {
    if (index >= renderedCount - 4) {
      setRenderedCount(prev => Math.min(resolvedItems.length, prev + 10));
    }
    onMediaFocus?.(media, id);
  }, [onMediaFocus, renderedCount, (category?.items || items || []).length]);

  const resolvedTitle = category?.title || title || 'Categoria';
  const resolvedItems = (category?.items || items || []).filter(Boolean) as RowItem[];
  const resolvedMediaItems = resolvedItems.filter(isMedia);

  const resolvedCategory = useMemo<Category>(
    () =>
      category || {
        id: `legacy-${sanitizeCategoryId(resolvedTitle)}-${rowIndex}`,
        title: resolvedTitle,
        type: String(resolvedMediaItems[0]?.type || 'movie'),
        items: resolvedMediaItems,
      },
    [category, resolvedMediaItems, resolvedTitle, rowIndex],
  );

  if (!resolvedItems || resolvedItems.length === 0) {
    return null;
  }

  const sideMenuOffset = disableSideMenuOffset ? 0 : ((!layout.isMobile || layout.isTvProfile) ? layout.sideRailCollapsedWidth : 0);
  const rowPaddingX = (layout.isTvProfile ? 20 : 28) + sideMenuOffset;
  const rowGap = layout.isTvProfile ? 10 : 14;
  const isLiveRow = resolvedCategory.type === 'live' || resolvedTitle.toLowerCase().includes('canais') || resolvedTitle.toLowerCase().includes('ao vivo');
  
  const cardWidth = layout.isTvProfile
    ? (isLiveRow ? 360 : 240)
    : (layout.isCompact ? (isLiveRow ? 320 : 210) : (isLiveRow ? 360 : 230));
  const cardHeight = isLiveRow ? Math.round(cardWidth * (9 / 16)) : Math.round(cardWidth * 1.5);
  const titleSize = layout.isTvProfile ? 20 : layout.isCompact ? 24 : 28;

  const seeAllNavId = `see-all-${rowIndex}`;
  const rowHeight = cardHeight + (layout.isTvProfile ? 100 : 140);

  return (
    <div
      ref={rowRef}
      style={{
        width: '100%',
        minHeight: isVisible ? 'auto' : rowHeight,
        paddingTop: tightTopSpacing ? 0 : (layout.isTvProfile ? 8 : 16),
        paddingBottom: layout.isTvProfile ? 12 : 20,
      }}
    >
      {!isVisible ? (
        <div style={{ height: rowHeight }} />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingLeft: rowPaddingX,
              paddingRight: rowPaddingX,
              marginBottom: 10,
              gap: 12,
            }}
          >
            <h2
              style={{
                margin: 0,
                color: '#fff',
                fontSize: titleSize,
                fontWeight: 900,
                letterSpacing: 0.3,
                lineHeight: 1.15,
              }}
            >
              {resolvedTitle}
            </h2>

            {onSeeAll && resolvedMediaItems.length > 0 ? (
              <button
                ref={(el) =>
                  registerNode(seeAllNavId, el, 'body', {
                    onEnter: () => onSeeAll(resolvedCategory),
                  })
                }
                data-nav-id={seeAllNavId}
                onClick={() => onSeeAll(resolvedCategory)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.18)',
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  color: 'rgba(255,255,255,0.88)',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  padding: '8px 10px',
                  cursor: 'pointer',
                }}
              >
                Ver tudo
                <ChevronRight size={14} />
              </button>
            ) : (
              <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>
                {resolvedItems.length} ITENS
              </span>
            )}
          </div>

          <div
            className="scrollbar-hide"
            style={{
              display: 'flex',
              gap: rowGap,
              overflowX: 'auto',
              overflowY: 'hidden',
              scrollSnapType: 'x mandatory',
              paddingLeft: rowPaddingX,
              paddingRight: rowPaddingX,
              paddingBottom: tightTopSpacing ? 28 : 45,
              paddingTop: tightTopSpacing ? 12 : 30,
            }}
          >
            {resolvedItems.slice(0, renderedCount).map((item, index) => (
              <MediaCard
                key={`${item.id}-${index}`}
                item={item}
                navId={`item-${rowIndex}-${index}`}
                cardWidth={cardWidth}
                cardHeight={cardHeight}
                imageUrl={resolveImageUrl(item, preloadedTMDBByKey)}
                onPress={onMediaPress}
                onFocus={(m, id) => onFocusWrapper(m, id, index)}
              />
            ))}
            <div style={{ width: 6, flex: '0 0 auto' }} />
          </div>
        </>
      )}
    </div>
  );
};
