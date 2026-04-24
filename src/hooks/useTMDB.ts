import { useState, useEffect } from 'react';
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
const TMDB_CACHE_VERSION = 'v5';
const TMDB_CACHE_READ_TIMEOUT_MS = 1400;
const TMDB_CACHE_WRITE_TIMEOUT_MS = 1200;
const TMDB_REQUEST_WATCHDOG_MS = 20000;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`[TMDB Hook] Timeout em ${label}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

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
  const categoryHint = String(options.categoryHint || '').trim();
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
    const catHint = categoryHint.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    const cacheKey = `${TMDB_CACHE_VERSION}:${cacheVariant}:${type}:${normalizedTitle}:${year || 'none'}:${catHint || 'nocat'}`;
    setData(null);
    setLoading(true);
    setError(null);

    const fetchMetadata = async () => {
      try {
        // 1. Check Persistent Cache (IndexedDB)
        let cachedItem: TMDBData | null = null;
        try {
          cachedItem = await withTimeout(
            tmdbStore.getItem<TMDBData>(cacheKey),
            TMDB_CACHE_READ_TIMEOUT_MS,
            'leitura de cache',
          );
        } catch (cacheReadError) {
          console.warn('[TMDB Hook] Falha/timeout ao ler cache local. Prosseguindo com rede.', cacheReadError);
        }

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
               { includeDetails, categoryHint },
             );
             if (result) {
               try {
                 await withTimeout(
                   tmdbStore.setItem(cacheKey, result),
                   TMDB_CACHE_WRITE_TIMEOUT_MS,
                   'escrita de cache',
                 );
               } catch (cacheWriteError) {
                 console.warn('[TMDB Hook] Falha/timeout ao salvar cache local do TMDB.', cacheWriteError);
               }
             }
             return result;
          })();
          inFlightRequests.set(cacheKey, request);
        }

        const result = await withTimeout(request, TMDB_REQUEST_WATCHDOG_MS, 'consulta TMDB');
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
  }, [categoryHint, includeDetails, title, type]);

  return { data, loading, error };
};
