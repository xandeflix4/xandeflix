import localforage from 'localforage';

// Initialize IndexedDB TMDB Cache (Match settings in useTMDB.ts)
export const tmdbStore = localforage.createInstance({
  name: 'xandeflix',
  storeName: 'tmdb_movie_cache'
});

/**
 * Limpa o cache persistente de metadados do TMDB.
 * Util quando a lógica de matching é atualizada e queremos forçar
 * uma nova busca para corrigir posters ou anos errados.
 */
export async function clearTMDBMetadataCache(): Promise<void> {
  try {
    await tmdbStore.clear();
    console.log('[TMDB Cache] Cache de metadados limpo.');
  } catch (err) {
    console.error('[TMDB Cache] Falha ao limpar cache:', err);
  }
}
