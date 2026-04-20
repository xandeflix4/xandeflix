import { useState, useEffect } from 'react';
import localforage from 'localforage';
import { cleanMediaTitle } from '../lib/titleCleaner';
import {
  fetchTMDBMetadata,
  isTMDBConfigured,
  type TMDBData,
  type FetchTMDBMetadataOptions,
} from '../lib/tmdb';

import { tmdbStore } from '../lib/tmdbCache';


const inFlightRequests = new Map<string, Promise<TMDBData | null>>();
const TMDB_DEBOUNCE_MS = 220;
const TMDB_CACHE_VERSION = 'v3';

/**
 * Custom hook to fetch rich metadata from TMDB directly from the client.
 * Optimized with title cleaning and IndexedDB persistent caching to save mobile data.
 * 
 * @param title The RAW media title from the IPTV list
 * @param type The type of media (movie or series)
 */
export const useTMDB = (
  title: string | undefined,
  type: string | undefined,
  options: FetchTMDBMetadataOptions = {},
) => {
  const includeDetails = options.includeDetails !== false;
  const [data, setData] = useState<TMDBData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    if (!title || !type || type === 'live') {
      setData(null);
      setLoading(false);
      return;
    }

    const { cleanTitle, year } = cleanMediaTitle(title);
    const normalizedTitle = cleanTitle.trim();
    if (!normalizedTitle) {
      setData(null);
      setLoading(false);
      return;
    }

    const cacheVariant = includeDetails ? 'full' : 'lite';
    const catHint = (options.categoryHint || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    const cacheKey = `${TMDB_CACHE_VERSION}:${cacheVariant}:${type}:${normalizedTitle}:${year || 'none'}:${catHint || 'nocat'}`;
    setData(null);
    setLoading(true);
    setError(null);

    const fetchMetadata = async () => {
      try {
        // 1. Check Persistent Cache (IndexedDB)
        const cachedItem = await tmdbStore.getItem<TMDBData>(cacheKey);
        if (cachedItem) {
          if (isMounted) { setData(cachedItem); setLoading(false); }
          return;
        }

        // 2. Fetch or hook into inflight request
        let request = inFlightRequests.get(cacheKey);
        if (!request) {
          request = (async () => {
             if (!isTMDBConfigured()) return null;
             const result = await fetchTMDBMetadata(
               year ? `${normalizedTitle} (${year})` : normalizedTitle,
               type as 'movie' | 'series',
               { includeDetails, categoryHint: options.categoryHint },
             );
             if (result) await tmdbStore.setItem(cacheKey, result); // Persist!
             return result;
          })();
          inFlightRequests.set(cacheKey, request);
        }

        const result = await request;
        if (isMounted) setData(result);
      } catch (err: any) {
        if (isMounted) {
           setError(err.message);
           setData(null);
        }
      } finally {
        inFlightRequests.delete(cacheKey);
        if (isMounted) setLoading(false);
      }
    };

    // Keep lookup responsive on TV while still avoiding request bursts during fast navigation.
    const timeout = setTimeout(fetchMetadata, TMDB_DEBOUNCE_MS);
    return () => {
       isMounted = false;
       clearTimeout(timeout);
    };
  }, [includeDetails, title, type]);

  return { data, loading, error };
};
