import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { Category, Media } from '../types';
import { isAdultCategory } from '../lib/adultContent';
import { cleanMediaTitle } from '../lib/titleCleaner';

// Palavras-chave para identificação inteligente
const SPORTS_KEYWORDS = [
  'premiere', 'combate', 'esporte', 'espn', 'sportv', 'bandsports', 'fox sports', 
  'golf', 'tennis', 'nba', 'fifa', 'ufc', 'copa', 'brasileirao', 'futebol', 'conmebol',
  'nfl', 'fighting', 'esportivos'
];

const KIDS_KEYWORDS = [
  'kids', 'infantil', 'desenhos', 'disney', 'junior', 'gloob', 'nick', 'cartoon', 
  'discovery kids', 'boing', 'pixar', 'anime', 'animation', 'criança', 'animados',
  'mundial kids', 'family', 'família'
];

const isSportsItem = (item: Media, categoryTitle: string = ''): boolean => {
  if (item.type !== 'live') return false;
  const searchContent = `${item.title} ${categoryTitle} ${item.category || ''}`.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return SPORTS_KEYWORDS.some(kw => searchContent.includes(kw));
};

const isKidsItem = (item: Media, categoryTitle: string = ''): boolean => {
  const searchContent = `${item.title} ${categoryTitle} ${item.category || ''}`.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return KIDS_KEYWORDS.some(kw => searchContent.includes(kw));
};

// Helper para consolidar itens de séries dentro de uma categoria
const consolidateItems = (items: Media[], categoryTitle: string = ''): Media[] => {
  const seriesMap = new Map<string, { main: Media, episodes: any[] }>();
  const results: Media[] = [];
  const isSeriesCat = /series|vod|show/i.test(categoryTitle);

  items.forEach(item => {
    // Canais ao vivo nunca são agrupados
    if (item.type === 'live') {
      results.push(item);
      return;
    }

    const { cleanTitle, season, episode, isSeries: detectedSeries } = cleanMediaTitle(item.title);
    
    // Se for identificado como série ou estiver em categoria de série
    if (detectedSeries || isSeriesCat) {
      if (season !== undefined && episode !== undefined) {
        const key = `${cleanTitle}`.toLowerCase().trim();
        if (!seriesMap.has(key)) {
          seriesMap.set(key, {
            main: { 
              ...item, 
              title: cleanTitle, 
              type: 'series' as any,
              id: `series-global-${item.id}` 
            },
            episodes: []
          });
        }
        seriesMap.get(key)!.episodes.push({
          id: item.id,
          seasonNumber: season,
          episodeNumber: episode,
          title: item.title,
          videoUrl: item.videoUrl
        });
        return;
      }
    }
    
    results.push(item);
  });

  // Integrar as séries agrupadas de volta ao resultado
  seriesMap.forEach(group => {
    const seasonsMap: Record<number, any[]> = {};
    group.episodes.forEach(ep => {
      if (!seasonsMap[ep.seasonNumber]) seasonsMap[ep.seasonNumber] = [];
      seasonsMap[ep.seasonNumber].push(ep);
    });

    const seasons = Object.entries(seasonsMap).map(([num, eps]) => ({
      seasonNumber: parseInt(num, 10),
      episodes: eps.sort((a, b) => a.episodeNumber - b.episodeNumber)
    })).sort((a,b) => a.seasonNumber - b.seasonNumber);

    results.push({ ...group.main, seasons });
  });

  return results;
};

export const useMediaFilter = (allCategories: Category[]) => {
  const activeFilter = useStore((state) => state.activeFilter);
  const searchQuery = useStore((state) => state.searchQuery);
  const hiddenCategoryIds = useStore((state) => state.hiddenCategoryIds);
  const favorites = useStore((state) => state.favorites);
  const adultAccessEnabled = useStore((state) => state.adultAccess.enabled);
  const isAdultUnlocked = useStore((state) => state.isAdultUnlocked);

  const filteredCategories = useMemo(() => {
    const adultLocked = !adultAccessEnabled || !isAdultUnlocked;
    
    // 1. Base filter for visibility and adult content
    const baseCategories = allCategories.filter(
      (cat) => !hiddenCategoryIds.includes(cat.id) && (!adultLocked || !isAdultCategory(cat)),
    );

    // 2. Build virtual category "Minha Lista"
    const favoriteItems: Media[] = [];
    const seenFavIds = new Set<string>();
    for (const cat of baseCategories) {
      for (const item of cat.items) {
        if (seenFavIds.has(item.id)) continue;
        const isFav = favorites.includes(item.id) || favorites.includes(item.videoUrl || `media:${item.id}`);
        if (isFav) {
          seenFavIds.add(item.id);
          favoriteItems.push(item);
        }
      }
    }

    const favoritesCategory: Category | null = favoriteItems.length > 0 ? {
      id: 'mylist-cat',
      title: 'Minha Lista',
      items: consolidateItems(favoriteItems, 'Minha Lista'),
      type: 'movie' as any
    } : null;

    if (activeFilter === 'mylist') {
      return favoritesCategory ? [favoritesCategory] : [];
    }

    // 3. Search Mode
    if (activeFilter === 'search') {
      const query = searchQuery.trim().toLowerCase();
      if (!query) return [];
      return baseCategories
        .map((cat) => ({
          ...cat,
          items: consolidateItems(cat.items.filter((item) =>
            item.title.toLowerCase().includes(query) ||
            cat.title.toLowerCase().includes(query)
          ), cat.title)
        }))
        .filter((cat) => cat.items.length > 0);
    }

    // 4. Inteligência de Categorias (Canais, Esportes, Filmes, Series, Infantil)
    let finalCategories: Category[] = [];

    if (activeFilter === 'home') {
      // Home exibe tudo menos Live (padrão Netflix)
      finalCategories = baseCategories
        .filter(cat => cat.type !== 'live')
        .map(cat => ({
          ...cat,
          items: consolidateItems(cat.items, cat.title)
        }));
      if (favoritesCategory) finalCategories = [favoritesCategory, ...finalCategories];
    } 
    else if (activeFilter === 'sports') {
      finalCategories = baseCategories
        .filter(cat => cat.type === 'live' || isSportsItem({ title: '' } as any, cat.title))
        .map(cat => ({
          ...cat,
          items: cat.items.filter(item => isSportsItem(item, cat.title))
        }))
        .filter(cat => cat.items.length > 0);
    } 
    else if (activeFilter === 'kids') {
      finalCategories = baseCategories
        .map(cat => ({
          ...cat,
          items: consolidateItems(cat.items.filter(item => isKidsItem(item, cat.title)), cat.title)
        }))
        .filter(cat => cat.items.length > 0);
    } 
    else if (activeFilter === 'live') {
      finalCategories = baseCategories
        .filter(cat => cat.type === 'live')
        .map(cat => ({
          ...cat,
          items: cat.items.filter(item => !isSportsItem(item, cat.title) && !isKidsItem(item, cat.title))
        }))
        .filter(cat => cat.items.length > 0);
    } 
    else if (activeFilter === 'movie' || activeFilter === 'series') {
      finalCategories = baseCategories
        .filter(cat => cat.type === activeFilter)
        .map(cat => ({
          ...cat,
          items: consolidateItems(cat.items.filter(item => !isKidsItem(item, cat.title)), cat.title)
        }))
        .filter(cat => cat.items.length > 0);
    } else {
      finalCategories = baseCategories.map(cat => ({
        ...cat,
        items: consolidateItems(cat.items, cat.title)
      }));
    }

    return finalCategories;
  }, [allCategories, activeFilter, searchQuery, hiddenCategoryIds, favorites, adultAccessEnabled, isAdultUnlocked]);

  return { filteredCategories };
};
