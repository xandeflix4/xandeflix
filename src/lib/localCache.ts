import localforage from 'localforage';
import { Category, EPGProgram } from '../types';

export const PLAYLIST_CACHE_SCHEMA_VERSION = 3;

// Configuração do Banco IndexedDB
localforage.config({
  name: 'Xandeflix',
  storeName: 'playlist_cache',
  description: 'Cache persistente das categorias e itens da playlist IPTV'
});

export interface PlaylistCacheData {
  schemaVersion: number;
  data: Category[];
  timestamp: number;
  epgUrl?: string | null;
}

const CACHE_KEY = 'xandeflix_active_playlist';
const EPG_CACHE_KEY = 'xandeflix_epg_data';

function hashCacheScope(scope: string): string {
  let hash = 2166136261;

  for (let index = 0; index < scope.length; index += 1) {
    hash ^= scope.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function getScopedCacheKey(baseKey: string, scope?: string): string {
  const normalizedScope = (scope || '').trim();
  return normalizedScope ? `${baseKey}:${hashCacheScope(normalizedScope)}` : baseKey;
}

export function buildPlaylistCacheScope(userId: string, playlistUrl: string): string {
  return `${userId.trim().toLowerCase()}::${playlistUrl.trim()}`;
}

/**
 * Salva as categorias processadas no cache persistente
 */
export async function savePlaylistCache(
  data: Category[],
  scope?: string,
  epgUrl?: string | null,
): Promise<void> {
  try {
    const cacheObject: PlaylistCacheData = {
      schemaVersion: PLAYLIST_CACHE_SCHEMA_VERSION,
      data,
      timestamp: Date.now(),
      epgUrl: (epgUrl || '').trim() || null,
    };
    await localforage.setItem(getScopedCacheKey(CACHE_KEY, scope), cacheObject);
    console.log('[Cache] Playlist salva no IndexedDB com sucesso.');
  } catch (err) {
    console.error('[Cache] Falha ao salvar no IndexedDB:', err);
  }
}

/**
 * Recupera os dados do cache, se existirem
 */
export async function getPlaylistCache(scope?: string): Promise<PlaylistCacheData | null> {
  try {
    return await localforage.getItem<PlaylistCacheData>(getScopedCacheKey(CACHE_KEY, scope));
  } catch (err) {
    console.error('[Cache] Falha ao ler do IndexedDB:', err);
    return null;
  }
}

/**
 * Salva os dados de EPG processados no cache
 */
export async function saveEpgCache(
  epgData: Record<string, EPGProgram[]>,
  scope?: string
): Promise<void> {
  try {
    await localforage.setItem(getScopedCacheKey(EPG_CACHE_KEY, scope), epgData);
  } catch (err) {
    console.error('[Cache] Falha ao salvar EPG no IndexedDB:', err);
  }
}

/**
 * Recupera o guia de programação do cache
 */
export async function getEpgCache(scope?: string): Promise<Record<string, EPGProgram[]> | null> {
  try {
    return await localforage.getItem<Record<string, EPGProgram[]>>(getScopedCacheKey(EPG_CACHE_KEY, scope));
  } catch (err) {
    console.error('[Cache] Falha ao ler EPG do IndexedDB:', err);
    return null;
  }
}

/**
 * Remove o cache atual, forçando uma nova sincronização com o provedor
 */
export async function clearPlaylistCache(scope?: string): Promise<void> {
  try {
    if (scope) {
      await localforage.removeItem(getScopedCacheKey(CACHE_KEY, scope));
      await localforage.removeItem(getScopedCacheKey(EPG_CACHE_KEY, scope));
      await localforage.removeItem(CACHE_KEY);
      await localforage.removeItem(EPG_CACHE_KEY);
    } else {
      await localforage.clear();
    }
    console.log('[Cache] Cache de playlist limpo.');
  } catch (err) {
    console.error('[Cache] Falha ao limpar IndexedDB:', err);
  }
}
