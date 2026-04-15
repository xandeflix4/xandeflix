import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { Category } from '../types';
import { isAdultCategory } from '../lib/adultContent';

export const useMediaFilter = (allCategories: Category[]) => {
  const activeFilter = useStore((state) => state.activeFilter);
  const searchQuery = useStore((state) => state.searchQuery);
  const hiddenCategoryIds = useStore((state) => state.hiddenCategoryIds);
  const favorites = useStore((state) => state.favorites);
  const adultAccessEnabled = useStore((state) => state.adultAccess.enabled);
  const isAdultUnlocked = useStore((state) => state.isAdultUnlocked);

  const filteredCategories = useMemo(() => {
    const adultLocked = !adultAccessEnabled || !isAdultUnlocked;
    const visibleCategories = allCategories.filter(
      (cat) => !hiddenCategoryIds.includes(cat.id) && (!adultLocked || !isAdultCategory(cat)),
    );

    // 0. Build virtual "Minha Lista" category
    const favoriteItems: any[] = [];
    const seenIds = new Set<string>();
    
    for (const cat of visibleCategories) {
      for (const item of cat.items) {
        if (seenIds.has(item.id)) continue;
        
        const isFav = favorites.includes(item.id) || favorites.includes(item.videoUrl || `media:${item.id}`);
        if (isFav) {
          seenIds.add(item.id);
          favoriteItems.push(item);
        }
      }
    }

    const favoritesCategory: Category | null = favoriteItems.length > 0 ? {
      id: 'mylist-cat',
      title: 'Minha Lista',
      items: favoriteItems,
      type: 'movie' as any // Virtual type
    } : null;

    // 1. Handle "Minha Lista" dedicated view
    if (activeFilter === 'mylist') {
      return favoritesCategory ? [favoritesCategory] : [];
    }

    // 2. Filter out hidden categories from general result
    let result = visibleCategories;

    // 3. Dedicated search mode searches across the full visible library
    if (activeFilter === 'search') {
      const query = searchQuery.trim().toLowerCase();
      if (!query) return [];

      return result
        .map((cat) => ({
          ...cat,
          items: cat.items.filter((item) =>
            item.title.toLowerCase().includes(query) ||
            cat.title.toLowerCase().includes(query)
          )
        }))
        .filter((cat) => cat.items.length > 0);
    }

    // 4. Filter by type (home, live, movies, series)
    if (activeFilter === 'home') {
      // Show everything EXCEPT live channels on the initial dashboard
      result = result.filter(cat => cat.type !== 'live');
      
      // Inject favorites at the top if they exist
      if (favoritesCategory) {
        result = [favoritesCategory, ...result];
      }
    } else {
      // Filter strictly by the active type (live, movie, or series)
      result = result.filter(cat => cat.type === activeFilter);
    }

    return result;
  }, [allCategories, activeFilter, searchQuery, hiddenCategoryIds, favorites, adultAccessEnabled, isAdultUnlocked]);

  return { filteredCategories };
};
