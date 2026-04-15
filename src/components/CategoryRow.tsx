import React, { useMemo } from 'react';
import { ChevronRight, Play, Star } from 'lucide-react';
import type { Category, Media, PlaylistItem } from '../types';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import type { TMDBData } from '../lib/tmdb';

type RowItem = Media | PlaylistItem;

interface CategoryRowProps {
  category?: Category;
  title?: string;
  items?: RowItem[];
  rowIndex: number;
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
  const candidates = [
    metadata?.backdrop,
    metadata?.thumbnail,
    isMedia(item) ? item.backdrop : '',
    isMedia(item) ? item.thumbnail : '',
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
  const isFocused = focusedId === navId;
  const canOpenMedia = Boolean(onPress && isMedia(item));

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
          disableAutoScroll: true,
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
        transform: isFocused ? 'translateY(-6px) scale(1.04)' : 'translateY(0) scale(1)',
        transition: 'transform 180ms ease, box-shadow 180ms ease',
        boxShadow: isFocused
          ? '0 18px 32px rgba(0,0,0,0.55), 0 0 18px rgba(229,9,20,0.35)'
          : '0 8px 18px rgba(0,0,0,0.35)',
      }}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={item.title}
          loading="lazy"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center center',
            display: 'block',
          }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, #1f2937, #0f172a)',
            color: 'rgba(255,255,255,0.78)',
            fontSize: 20,
            fontWeight: 900,
            textTransform: 'uppercase',
            letterSpacing: 1,
          }}
        >
          {String(item.title || '?').slice(0, 2)}
        </div>
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
  preloadedTMDBByKey,
  onMediaFocus,
  onMediaPress,
  onSeeAll,
}) => {
  const layout = useResponsiveLayout();
  const { registerNode } = useTvNavigation({ isActive: false, subscribeFocused: false });

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

  const rowPaddingX = layout.isTvProfile ? 20 : 28;
  const rowGap = layout.isTvProfile ? 10 : 14;
  const cardWidth = layout.isTvProfile ? 230 : layout.isCompact ? 230 : 250;
  const cardHeight = Math.round(cardWidth * (9 / 16));
  const titleSize = layout.isTvProfile ? 20 : layout.isCompact ? 24 : 28;

  const seeAllNavId = `see-all-${rowIndex}`;

  return (
    <div
      style={{
        width: '100%',
        paddingTop: layout.isTvProfile ? 8 : 16,
        paddingBottom: layout.isTvProfile ? 12 : 20,
      }}
    >
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
                disableAutoScroll: true,
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
          paddingBottom: 8,
        }}
      >
        {resolvedItems.map((item, index) => (
          <MediaCard
            key={`${item.id}-${index}`}
            item={item}
            navId={`item-${rowIndex}-${index}`}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
            imageUrl={resolveImageUrl(item, preloadedTMDBByKey)}
            onPress={onMediaPress}
            onFocus={onMediaFocus}
          />
        ))}
        <div style={{ width: 6, flex: '0 0 auto' }} />
      </div>
    </div>
  );
};
