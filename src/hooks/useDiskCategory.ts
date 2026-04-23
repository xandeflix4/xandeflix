import { useEffect, useState } from 'react';
import type { Media } from '../types';
import { getChannelsByCategory } from '../lib/db';

interface UseDiskCategoryResult {
  items: Media[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
}

export const DISK_CATEGORY_PAGE_SIZE = 150;

export function useDiskCategory(
  categoryName: string | null | undefined,
  page: number,
  pageSize: number = DISK_CATEGORY_PAGE_SIZE,
  refreshKey?: string | number | boolean,
): UseDiskCategoryResult {
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    const normalizedCategory = String(categoryName || '').trim();
    if (!normalizedCategory) {
      setItems([]);
      setHasMore(false);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const safePage = Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
    const safePageSize = Number.isFinite(pageSize)
      ? Math.max(1, Math.floor(pageSize))
      : DISK_CATEGORY_PAGE_SIZE;

    setLoading(true);
    setError(null);

    void getChannelsByCategory(normalizedCategory, safePage * safePageSize, safePageSize)
      .then((result) => {
        if (cancelled) return;
        setItems(result as Media[]);
        setHasMore(result.length >= safePageSize);
      })
      .catch((reason) => {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : 'Falha ao ler categoria no catalogo local';
        setError(message);
        setItems([]);
        setHasMore(false);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [categoryName, page, pageSize, refreshKey]);

  return { items, loading, error, hasMore };
}
