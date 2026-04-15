import localforage from 'localforage';
import { APP_BUILD_ID } from './buildInfo';

const BUILD_MARKER_KEY = 'xandeflix_app_build_marker';
const INDEXEDDB_CLEAR_TIMEOUT_MS = 3500;
const APP_STORAGE_KEYS = [
  'xandeflix-app-storage',
  'xandeflix_auth_token',
  'xandeflix_auth_role',
  'xandeflix_user_id',
  'xandeflix_session',
];

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`[BootstrapCache] Timeout ao executar etapa: ${label}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const clearAppWebStorage = () => {
  if (typeof localStorage !== 'undefined') {
    try {
      APP_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
      localStorage.setItem(BUILD_MARKER_KEY, APP_BUILD_ID);
    } catch (error) {
      console.warn('[BootstrapCache] Falha ao limpar localStorage:', error);
    }
  }

  if (typeof sessionStorage !== 'undefined') {
    try {
      const keysToRemove: string[] = [];
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith('xandeflix_')) {
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach((key) => sessionStorage.removeItem(key));
    } catch (error) {
      console.warn('[BootstrapCache] Falha ao limpar sessionStorage:', error);
    }
  }
};

const clearIndexedDbCaches = async () => {
  try {
    await withTimeout(
      localforage.dropInstance({ name: 'Xandeflix' }),
      INDEXEDDB_CLEAR_TIMEOUT_MS,
      'dropInstance(Xandeflix)',
    );
  } catch (error) {
    console.warn('[BootstrapCache] Falha ao limpar cache de playlist:', error);
  }

  try {
    await withTimeout(
      localforage.dropInstance({ name: 'xandeflix', storeName: 'tmdb_movie_cache' }),
      INDEXEDDB_CLEAR_TIMEOUT_MS,
      'dropInstance(xandeflix/tmdb_movie_cache)',
    );
  } catch (error) {
    console.warn('[BootstrapCache] Falha ao limpar cache do TMDB:', error);
  }
};

export const ensureFreshBuildState = async () => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  let previousBuildId: string | null = null;
  try {
    previousBuildId = localStorage.getItem(BUILD_MARKER_KEY);
  } catch (error) {
    console.warn('[BootstrapCache] Falha ao ler marcador de build no localStorage:', error);
    return;
  }

  if (previousBuildId === APP_BUILD_ID) {
    return;
  }

  console.info('[BootstrapCache] Nova build detectada. Limpando caches locais.', {
    previousBuildId,
    nextBuildId: APP_BUILD_ID,
  });

  clearAppWebStorage();
  await clearIndexedDbCaches();
};
