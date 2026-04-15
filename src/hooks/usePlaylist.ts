import { useCallback, useEffect, useRef, useState } from 'react';
import { Category } from '../types';
import { useStore } from '../store/useStore';
import {
  PLAYLIST_CACHE_SCHEMA_VERSION,
  buildPlaylistCacheScope,
  getPlaylistCache,
  savePlaylistCache,
  getEpgCache,
  saveEpgCache,
} from '../lib/localCache';
import {
  appendCompressedChannelsChunk,
  clearAllChannels as clearChannelsCatalog,
  getCategories as getChannelCategories,
  getChannelsByCategory,
  insertChannels,
} from '../lib/db';
import { upsertPlaylistCatalogSnapshot } from '../lib/playlistCatalogSnapshot';
import { fetchRemoteText, prepareRemoteTextStreamSource } from '../lib/api';
import { getSessionSnapshot } from '../lib/auth';

export type PlaylistStatus =
  | 'idle'
  | 'loading_user_info'
  | 'loading_playlist'
  | 'success'
  | 'error_auth'
  | 'error_no_content'
  | 'error_playlist'
  | 'mock_fallback';

export interface PlaylistError {
  status: PlaylistStatus;
  message: string;
  details?: string;
  playlistUrl?: string;
}

interface WorkerParseResult {
  totalLoaded: number;
  epgUrl: string | null;
}

interface WorkerCatalogChunkMessage {
  type: 'CHUNK';
  count?: number;
  epgUrl?: string | null;
  tupleWidth?: number;
  tuples?: Int32Array | number[];
  dictionaries?: {
    titles?: string[];
    groups?: string[];
    urls?: string[];
    logos?: string[];
  };
  isFinal?: boolean;
}

const PLAYLIST_FETCH_TIMEOUT_MS = 180000; // 3 Minutos maximos para download
const PLAYLIST_FETCH_TOTAL_BUDGET_MS = 400000;
const MAX_PLAYLIST_SYNC_BYTES = 150 * 1024 * 1024; // 150MB
const PLAYLIST_FLOW_WATCHDOG_TIMEOUT_MS = 460000;
const CACHE_IO_TIMEOUT_MS = 12000;
const UI_PREFETCH_TIMEOUT_MS = 1800;
const UI_PREFETCH_LIMIT_MOBILE = 16;
const UI_PREFETCH_LIMIT_TV = 36;
const CHANNEL_PREVIEW_LIMIT_PER_CATEGORY = 30;
const SNAPSHOT_SYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const SNAPSHOT_SYNC_STORAGE_PREFIX = 'xandeflix_snapshot_sync_meta:';
const SNAPSHOT_SYNC_SIGNATURE_CATEGORIES_LIMIT = 24;
const SNAPSHOT_SYNC_SIGNATURE_ITEMS_LIMIT = 8;

type SnapshotSyncMeta = {
  signature: string;
  timestamp: number;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function describePlaylistSource(playlistUrl: string): string {
  try {
    return new URL(playlistUrl).host;
  } catch {
    return 'Lista vinculada';
  }
}

function normalizeSnapshotUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

function getSnapshotSyncStorageKey(userId: string): string {
  return `${SNAPSHOT_SYNC_STORAGE_PREFIX}${normalizeSnapshotUserId(userId)}`;
}

function foldHash(seed: number, value: string): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildSnapshotSyncSignature(
  userId: string,
  playlistUrl: string,
  epgUrl: string | null,
  categories: Category[],
): string {
  let hash = 2166136261;
  const feed = (value: string) => {
    hash = foldHash(hash, value);
  };

  const normalizedUser = normalizeSnapshotUserId(userId);
  const normalizedPlaylistUrl = playlistUrl.trim();
  const normalizedEpg = String(epgUrl || '').trim();
  const totalItems = categories.reduce((sum, category) => sum + category.items.length, 0);

  feed(normalizedUser);
  feed('|');
  feed(normalizedPlaylistUrl);
  feed('|');
  feed(normalizedEpg);
  feed(`|${categories.length}|${totalItems}`);

  const categorySample = categories.slice(0, SNAPSHOT_SYNC_SIGNATURE_CATEGORIES_LIMIT);
  for (const category of categorySample) {
    feed(category.id);
    feed('|');
    feed(category.title);
    feed('|');
    feed(String(category.items.length));

    const itemSample = category.items.slice(0, SNAPSHOT_SYNC_SIGNATURE_ITEMS_LIMIT);
    for (const item of itemSample) {
      feed(item.id);
      feed('|');
      feed(item.videoUrl);
    }
  }

  return `${normalizedUser}:${(hash >>> 0).toString(36)}`;
}

function readSnapshotSyncMeta(userId: string): SnapshotSyncMeta | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(getSnapshotSyncStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SnapshotSyncMeta>;
    if (typeof parsed?.signature !== 'string' || !Number.isFinite(parsed?.timestamp)) return null;
    return {
      signature: parsed.signature,
      timestamp: Math.max(0, Number(parsed.timestamp)),
    };
  } catch {
    return null;
  }
}

function writeSnapshotSyncMeta(userId: string, meta: SnapshotSyncMeta): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(getSnapshotSyncStorageKey(userId), JSON.stringify(meta));
  } catch {
    // noop
  }
}

function buildPlaylistUrlCandidates(playlistUrl: string): string[] {
  try {
    const parsed = new URL(playlistUrl);
    const output = (parsed.searchParams.get('output') || '').toLowerCase();
    const asTs = new URL(parsed.toString()); asTs.searchParams.set('output', 'ts');
    const asMpegts = new URL(parsed.toString()); asMpegts.searchParams.set('output', 'mpegts');
    const asHls = new URL(parsed.toString()); asHls.searchParams.set('output', 'hls');

    if (output === 'mpegts') return Array.from(new Set([playlistUrl, asTs.toString(), asHls.toString()]));
    if (output === 'hls') return Array.from(new Set([playlistUrl, asTs.toString(), asMpegts.toString()]));
    if (output === 'ts') return Array.from(new Set([playlistUrl, asMpegts.toString(), asHls.toString()]));

    return [playlistUrl];
  } catch {
    return [playlistUrl];
  }
}

async function buildCategoriesPreviewFromCatalog(
  onUpdate?: (msg: string, progressHint?: number) => void,
): Promise<Category[]> {
  const categoryTitles = await getChannelCategories();
  const categories: Category[] = [];

  for (let index = 0; index < categoryTitles.length; index += 1) {
    const title = categoryTitles[index];
    const channels = await getChannelsByCategory(title, 0, CHANNEL_PREVIEW_LIMIT_PER_CATEGORY);

    if (!channels.length) continue;

    categories.push({
      id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `cat-${index}`,
      title,
      type: String(channels[0].type || 'live'),
      items: channels,
    });

    if (index % 6 === 0) {
      const percent = Math.round(((index + 1) / Math.max(categoryTitles.length, 1)) * 100);
      onUpdate?.(`[Catalogo] Montando vitrine local (${percent}%): ${index + 1}/${categoryTitles.length} categorias`, 86);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  return categories;
}

async function primeCatalogFromPreview(categories: Category[]): Promise<void> {
  await clearChannelsCatalog();
  const flattened = categories.flatMap((category) =>
    category.items.map((item) => ({
      ...item,
      category: item.category || category.title,
      groupTitle: item.category || category.title,
    })),
  );
  await insertChannels(flattened);
}

function toPreviewCategories(categories: Category[], limitPerCategory: number = CHANNEL_PREVIEW_LIMIT_PER_CATEGORY): Category[] {
  return categories
    .map((category) => ({
      ...category,
      items: category.items.slice(0, limitPerCategory),
    }))
    .filter((category) => category.items.length > 0);
}

async function parsePlaylistInWorker(
  playlistStreamUrl: string,
  onUpdate?: (msg: string, progressHint?: number) => void,
  activeWorkerRef?: { current: Worker | null },
): Promise<WorkerParseResult> {
  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(new URL('../workers/m3u.worker.ts', import.meta.url), {
        type: 'module'
      });
      if (activeWorkerRef) {
        activeWorkerRef.current = worker;
      }

      let totalLoaded = 0;
      let epgUrl: string | null = null;
      let firstChunkApplied = false;
      let settled = false;
      let pendingChunkWrites: Promise<void> = Promise.resolve();

      const closeWorker = () => {
        if (activeWorkerRef && activeWorkerRef.current === worker) {
          activeWorkerRef.current = null;
        }
        worker.terminate();
      };

      const safeResolve = () => {
        if (settled) return;
        settled = true;
        closeWorker();
        resolve({
          totalLoaded,
          epgUrl,
        });
      };

      const safeReject = (reason: unknown) => {
        if (settled) return;
        settled = true;
        closeWorker();
        reject(reason instanceof Error ? reason : new Error('Erro desconhecido no Worker'));
      };

      const queueChunkWrite = (chunkMessage: WorkerCatalogChunkMessage) => {
        pendingChunkWrites = pendingChunkWrites.then(async () => {
          if (settled) return;

          if (!firstChunkApplied) {
            await clearChannelsCatalog();
            firstChunkApplied = true;
          }

          await appendCompressedChannelsChunk({
            tuples: chunkMessage.tuples || [],
            tupleWidth: chunkMessage.tupleWidth,
            dictionaries: chunkMessage.dictionaries,
          });

          const numericCount = Number(chunkMessage.count);
          if (Number.isFinite(numericCount)) {
            totalLoaded = Math.max(totalLoaded, numericCount);
          }
          if (typeof chunkMessage.epgUrl === 'string' && chunkMessage.epgUrl.trim()) {
            epgUrl = chunkMessage.epgUrl.trim();
          }

          onUpdate?.(`[Fatiador] ${totalLoaded} canais tokenizados em memoria local...`, 72);
        });

        pendingChunkWrites.catch((error) => {
          safeReject(error instanceof Error ? error : new Error('Falha ao aplicar chunk condensado.'));
        });
      };

      worker.onmessage = (e) => {
        const { type, count, message, epgUrl: msgEpgUrl } = e.data || {};

        if (type === 'CHUNK') {
          queueChunkWrite(e.data as WorkerCatalogChunkMessage);
          return;
        }

        if (type === 'PROGRESS') {
          const numericCount = Number(count);
          if (Number.isFinite(numericCount)) {
            totalLoaded = Math.max(totalLoaded, numericCount);
          }
          if (typeof msgEpgUrl === 'string' && msgEpgUrl.trim()) {
            epgUrl = msgEpgUrl.trim();
          }
          onUpdate?.(`[Fatiador] ${totalLoaded} canais tokenizados em memoria local...`, 72);
          return;
        }

        if (type === 'DONE') {
          pendingChunkWrites.then(() => safeResolve()).catch((error) => safeReject(error));
          return;
        }

        if (type === 'ERROR') {
          safeReject(new Error(message || 'Erro desconhecido no Worker'));
        }
      };

      worker.onerror = (err) => {
        safeReject(err);
      };

      worker.postMessage({ playlistUrl: playlistStreamUrl, batchSize: 2000 });
    } catch (err) {
      reject(err);
    }
  });
}

async function parseEpgInWorker(
  xmlText: string,
  onChunk: (data: Record<string, any[]>) => void,
  activeWorkerRef: { current: Worker | null },
): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(new URL('../workers/epg.worker.ts', import.meta.url), {
        type: 'module'
      });
      activeWorkerRef.current = worker;

      worker.onmessage = (e) => {
        const { type, data, totalLoaded, message } = e.data;

        if (type === 'CHUNK') {
          onChunk(data);
        } else if (type === 'DONE') {
          worker.terminate();
          activeWorkerRef.current = null;
          resolve(totalLoaded);
        } else if (type === 'ERROR') {
          worker.terminate();
          activeWorkerRef.current = null;
          reject(new Error(message || 'Erro no EPG Worker'));
        }
      };

      worker.onerror = (err) => {
        worker.terminate();
        activeWorkerRef.current = null;
        reject(err);
      };

      worker.postMessage({ xmlText, chunkSize: 2000 });
    } catch (err) {
      reject(err);
    }
  });
}

async function prefetchImage(url: string): Promise<void> {
  if (!url || typeof window === 'undefined' || typeof Image === 'undefined') return;

  await new Promise<void>((resolve) => {
    const image = new Image();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timeoutId = window.setTimeout(finish, UI_PREFETCH_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timeoutId);
      finish();
    };
    image.onerror = () => {
      window.clearTimeout(timeoutId);
      finish();
    };
    image.src = url;
  });
}

function collectUiPrefetchUrls(categories: Category[], limit: number): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const category of categories) {
    for (const item of category.items.slice(0, 6)) {
      const candidateUrls = [item.backdrop, item.thumbnail]
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0);

      for (const url of candidateUrls) {
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
        if (urls.length >= limit) return urls;
      }
    }

    if (urls.length >= limit) break;
  }

  return urls;
}

async function warmupUiElements(
  categories: Category[],
  onUpdate?: (msg: string, progressHint?: number) => void,
  isTvMode?: boolean,
) {
  const totalCategories = categories.length;
  const totalPreviewItems = categories.reduce((sum, category) => sum + Math.min(category.items.length, 20), 0);

  onUpdate?.(
    `[UI] Indexando elementos: ${totalCategories} categorias / ${totalPreviewItems} itens de vitrine.`,
    92,
  );
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

  const prefetchLimit = isTvMode ? UI_PREFETCH_LIMIT_TV : UI_PREFETCH_LIMIT_MOBILE;
  const urls = collectUiPrefetchUrls(categories, prefetchLimit);
  if (urls.length === 0) {
    onUpdate?.('[UI] Sem capas para pre-carregar. Prosseguindo...', 96);
    return;
  }

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    await prefetchImage(url);

    if (index % 4 === 0 || index === urls.length - 1) {
      const percent = Math.round(((index + 1) / urls.length) * 100);
      const mappedProgress = 93 + Math.round(percent * 0.06); // 93..99
      onUpdate?.(`[UI] Carregando elementos visuais: ${percent}% (${index + 1}/${urls.length})`, mappedProgress);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
}

export const usePlaylist = () => {
  const [loading, setLoading] = useState(false);
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistStatus>('idle');
  const [playlistError, setPlaylistError] = useState<PlaylistError | null>(null);
  const [playlistSource, setPlaylistSource] = useState<string>('');
  const [playlistProgress, setPlaylistProgress] = useState<number>(0);
  const [playlistLogs, setPlaylistLogs] = useState<string[]>([]);
  const [catalogPreviewCategories, setCatalogPreviewCategories] = useState<Category[]>([]);
  const [isWritingDatabase, setIsWritingDatabase] = useState(false);
  const activePlaylistLoadPromiseRef = useRef<Promise<void> | null>(null);
  const activeWorkerRef = useRef<Worker | null>(null);
  const activeEpgWorkerRef = useRef<Worker | null>(null);
  const setSelectedCategoryName = useStore((state) => state.setSelectedCategoryName);
  const setVisibleItems = useStore((state) => state.setVisibleItems);
  const clearVisibleItems = useStore((state) => state.clearVisibleItems);
  const setIsUsingMock = useStore((state) => state.setIsUsingMock);
  const setAdultAccessSettings = useStore((state) => state.setAdultAccessSettings);
  const setEpgData = useStore((state) => state.setEpgData);
  const appendEpgData = useStore((state) => state.appendEpgData);

  const syncVisibleSliceStore = useCallback(
    (categories: Category[]) => {
      if (!categories.length) {
        setSelectedCategoryName(null);
        clearVisibleItems();
        return;
      }

      const firstCategory = categories[0];
      setSelectedCategoryName(firstCategory.title);
      setVisibleItems(firstCategory.items.slice(0, 80));
    },
    [clearVisibleItems, setSelectedCategoryName, setVisibleItems],
  );

  useEffect(() => {
    return () => {
      activePlaylistLoadPromiseRef.current = null;
      if (activeWorkerRef.current) {
        console.log('[Worker] Encerrando worker ativo por unmount...');
        activeWorkerRef.current.terminate();
        activeWorkerRef.current = null;
      }
      if (activeEpgWorkerRef.current) {
        console.log('[EPG Worker] Encerrando worker de EPG por unmount...');
        activeEpgWorkerRef.current.terminate();
        activeEpgWorkerRef.current = null;
      }
    };
  }, []);

  const appendProgressLog = useCallback((msg: string) => {
    console.log(`[Diagnostic] ${msg}`);
    setPlaylistLogs((previous) => {
      if (previous[previous.length - 1] === msg) {
        return previous;
      }

      return [...previous.slice(-11), msg];
    });
  }, []);

  const updateDiag = useCallback((msg: string, progressHint?: number) => {
    appendProgressLog(msg);
    setPlaylistError((prev) =>
      prev
        ? { ...prev, details: msg }
        : { status: 'loading_playlist', message: 'Carregando Sistema...', details: msg },
    );

    if (typeof progressHint === 'number' && Number.isFinite(progressHint)) {
      setPlaylistProgress((prev) => Math.max(prev, Math.min(99, Math.round(progressHint))));
      return;
    }

    const percentMatch = msg.match(/(\d{1,3})%/);
    if (percentMatch) {
      const parsed = Number(percentMatch[1]);
      if (Number.isFinite(parsed)) {
        setPlaylistProgress((prev) => Math.max(prev, Math.min(99, parsed)));
      }
    }
  }, [appendProgressLog]);

  const setNoContentError = useCallback(
    (message: string, details: string, playlistUrl?: string) => {
      appendProgressLog(`[Erro] ${details}`);
      setPlaylistProgress(100);
      setCatalogPreviewCategories([]);
      syncVisibleSliceStore([]);
      setIsUsingMock(false);
      setEpgData(null);
      setPlaylistStatus('error_no_content');
      setPlaylistError({
        status: 'error_no_content',
        message,
        details,
        playlistUrl,
      });
    },
    [appendProgressLog, setEpgData, setIsUsingMock, syncVisibleSliceStore],
  );

  const syncCatalogSnapshot = useCallback(
    async (userId: string, playlistUrl: string, epgUrl: string | null, categories: Category[]) => {
      const signature = buildSnapshotSyncSignature(userId, playlistUrl, epgUrl, categories);
      const now = Date.now();
      const previousMeta = readSnapshotSyncMeta(userId);
      if (
        previousMeta
        && previousMeta.signature === signature
        && (now - previousMeta.timestamp) < SNAPSHOT_SYNC_MIN_INTERVAL_MS
      ) {
        return;
      }

      try {
        await upsertPlaylistCatalogSnapshot({ userId, playlistUrl, epgUrl, categories });
        writeSnapshotSyncMeta(userId, { signature, timestamp: now });
      } catch (error) {
        console.warn('[Playlist] Falha ao sincronizar snapshot no Supabase:', error);
      }
    },
    [],
  );

  const hydrateEpgData = useCallback(async (epgUrl: string | null, cacheScope?: string) => {
      if (!epgUrl) { setEpgData(null); return; }
      
      // Se tivermos cacheScope, tentamos recuperar o guia local primeiro
      if (cacheScope) {
        const cachedEpg = await getEpgCache(cacheScope);
        if (cachedEpg && Object.keys(cachedEpg).length > 0) {
          appendProgressLog(`[EPG] Guia de programaÃ§Ã£o restaurado do cache local.`);
          setEpgData(cachedEpg);
          // Opcionalmente: poderiamos parar aqui se o cache fosse recente. 
          // Por enquanto, faremos o download em background para garantir dados frescos.
        }
      }

      // Se jÃ¡ houver um worker de EPG rodando, encerra para carregar a nova URL
      if (activeEpgWorkerRef.current) {
        activeEpgWorkerRef.current.terminate();
        activeEpgWorkerRef.current = null;
      }

      try {
        appendProgressLog(`[EPG] Baixando guia de programaÃ§Ã£o: ${epgUrl.substring(0, 40)}...`);
        const xmlText = await fetchRemoteText(epgUrl, { timeoutMs: 45000 });
        
        appendProgressLog(`[EPG] XMLTV Baixado (${(xmlText.length/1024/1024).toFixed(1)}MB). Iniciando processamento...`);
        
        // Se nÃ£o carregamos do cache, ou se decidimos atualizar
        // Se o arquivo for pequeno, o parser Ã© rÃ¡pido. Em TV, o parsing em thread separada Ã© vital.
        const count = await parseEpgInWorker(
          xmlText,
          (chunk) => {
            requestAnimationFrame(() => {
              appendEpgData(chunk);
            });
          },
          activeEpgWorkerRef
        );

        appendProgressLog(`[EPG] Sucesso! ${count} programas processados em background.`);
        
        // Salva no cache para a prÃ³xima inicializaÃ§Ã£o
        const finalEpgData = useStore.getState().epgData;
        if (finalEpgData && Object.keys(finalEpgData).length > 0 && cacheScope) {
          void saveEpgCache(finalEpgData, cacheScope);
        }
      } catch (error: any) {
        appendProgressLog(`[EPG] Falha: ${error.message || 'Erro de rede/parsing'}`);
      }
    },
    [setEpgData, appendEpgData, appendProgressLog],
  );

  const fetchPlaylist = useCallback(async () => {
    if (activePlaylistLoadPromiseRef.current) return activePlaylistLoadPromiseRef.current;

    const run = async () => {
      let hasData = catalogPreviewCategories.length > 0;
      if (!hasData) setLoading(true);
      setPlaylistError(null);
      setPlaylistProgress(2);
      setPlaylistLogs([]);
      appendProgressLog('[Sistema] Iniciando sincronizacao da conta...');

      let playlistUrl = '';
      let cacheScope = '';
      let hasValidatedUser = false;

      try {
        updateDiag(`[Local] Validando a sessÃ£o do usuÃ¡rio no Supabase...`);
        setPlaylistProgress((prev) => Math.max(prev, 8));
        const sessionSnapshot = await getSessionSnapshot();
        if (!sessionSnapshot) throw new Error('SessÃ£o nativa expirada. FaÃ§a login novamente.');
        if (sessionSnapshot.role === 'admin') {
          setEpgData(null);
          setPlaylistProgress(100);
          appendProgressLog('[Sistema] Sessao admin detectada.');
          setLoading(false);
          setPlaylistStatus('idle');
          return;
        }

        setPlaylistStatus('loading_user_info');
        const userData = sessionSnapshot.data;
        if (!userData) throw new Error('Perfil do usuÃ¡rio vazio. Reconecte a conta.');
        hasValidatedUser = true;
        setAdultAccessSettings(userData.adultAccess);
        if (!userData.playlistUrl) {
          setNoContentError('Conta Ativada, sem lista', 'Solicite que o Admin coloque a URL M3U na sua conta.');
          return;
        }

        playlistUrl = userData.playlistUrl;
        cacheScope = buildPlaylistCacheScope(userData.id || 'anonymous', playlistUrl);
        setEpgData(null);

        updateDiag('[Cache] Procurando cache local...');
        setPlaylistProgress((prev) => Math.max(prev, 15));
        const cached = await withTimeout(
          getPlaylistCache(cacheScope), CACHE_IO_TIMEOUT_MS, 'Timeout: Banco local IndexedDB muito lento.'
        ).catch(() => null);

        const CACHE_EXPIRATION_MS = 12 * 60 * 60 * 1000;
        const hasCompatibleCache = Boolean(cached) && cached!.schemaVersion === PLAYLIST_CACHE_SCHEMA_VERSION;
        const cacheAgeMs = hasCompatibleCache && cached ? Math.max(0, Date.now() - cached.timestamp) : Number.POSITIVE_INFINITY;
        const hasFreshCache = hasCompatibleCache && cacheAgeMs < CACHE_EXPIRATION_MS;

        if (hasCompatibleCache && cached) {
          const cachedPreview = toPreviewCategories(cached.data);
          if (cachedPreview.length > 0) {
            const cacheAgeHours = Math.floor(cacheAgeMs / (60 * 60 * 1000));
            if (hasFreshCache) {
              updateDiag('[Cache] Dados recuperados da memoria local! Restaurando interface...');
            } else {
              updateDiag(`[Cache] Restaurando catalogo salvo (${cacheAgeHours}h). Atualizacao rodando em background...`);
            }

            await primeCatalogFromPreview(cachedPreview).catch(() => null);
            await warmupUiElements(
              cachedPreview,
              updateDiag,
              useStore.getState().isTvMode,
            );
            setCatalogPreviewCategories(cachedPreview);
            syncVisibleSliceStore(cachedPreview);
            setIsUsingMock(false);
            setPlaylistStatus('success');
            setPlaylistSource(describePlaylistSource(playlistUrl));
            void hydrateEpgData(cached.epgUrl || null, cacheScope);
            setPlaylistProgress((prev) => Math.max(prev, hasFreshCache ? 30 : 27));
            appendProgressLog(`[Concluido] Catalogo restaurado do cache com ${cachedPreview.length} categorias.`);
            appendProgressLog('[Atualizacao] Revalidando catalogo completo em segundo plano...');
            hasData = true;
            setLoading(false);
          } else {
            appendProgressLog('[Cache] Snapshot local encontrado, mas sem dados uteis. Seguindo com stream completo.');
          }
        }

        setPlaylistStatus('loading_playlist');
        setPlaylistSource(describePlaylistSource(playlistUrl));
        setPlaylistProgress((prev) => Math.max(prev, 24));

        updateDiag('[Motor] Ativando parser em stream com catalogo condensado em memoria...', 52);
        setIsWritingDatabase(true);
        if (!hasData) {
          syncVisibleSliceStore([]);
        }

        const playlistCandidates = buildPlaylistUrlCandidates(playlistUrl);
        let parsedPlaylist: WorkerParseResult | null = null;
        let workerLastError: unknown = null;
        const parsingStartedAt = Date.now();

        for (let index = 0; index < playlistCandidates.length; index += 1) {
          const elapsedMs = Date.now() - parsingStartedAt;
          const remainingBudgetMs = PLAYLIST_FETCH_TOTAL_BUDGET_MS - elapsedMs;
          if (remainingBudgetMs <= 5000) break;

          const candidateTimeoutMs = Math.min(PLAYLIST_FETCH_TIMEOUT_MS, remainingBudgetMs);
          const candidateUrl = playlistCandidates[index];
          let streamSource: Awaited<ReturnType<typeof prepareRemoteTextStreamSource>> | null = null;

          try {
            updateDiag(`[HTTP] Preparando stream da playlist... (Passo ${index + 1}/${playlistCandidates.length})`);
            streamSource = await prepareRemoteTextStreamSource(candidateUrl, {
              timeoutMs: candidateTimeoutMs,
              preflightHead: false,
              maxContentLengthBytes: MAX_PLAYLIST_SYNC_BYTES,
              retryWithoutNativeHeaders: true,
            });

            parsedPlaylist = await parsePlaylistInWorker(
              streamSource.streamUrl,
              updateDiag,
              activeWorkerRef,
            );

            if (parsedPlaylist.totalLoaded > 0) {
              break;
            }

            workerLastError = new Error('A lista foi processada, mas sem canais validos.');
          } catch (error) {
            workerLastError = error;
            const details = error instanceof Error ? error.message : 'erro desconhecido';
            updateDiag(`[HTTP] Falha no stream: ${details}`);
          } finally {
            if (streamSource) {
              await streamSource.cleanup().catch(() => null);
            }
          }
        }

        if (!parsedPlaylist || parsedPlaylist.totalLoaded <= 0) {
          const message =
            workerLastError instanceof Error
              ? workerLastError.message
              : 'Nao foi possivel processar a playlist em stream.';
          throw new Error(`O parsing em stream falhou: ${message}`);
        }

        updateDiag('[Catalogo] Carregando vitrine inicial do catalogo condensado...', 84);
        const previewCategories = await buildCategoriesPreviewFromCatalog(updateDiag);

        if (previewCategories.length > 0) {
          updateDiag('[UI] Preparando elementos da interface...', 91);
          await warmupUiElements(
            previewCategories,
            updateDiag,
            useStore.getState().isTvMode,
          );

          setCatalogPreviewCategories(previewCategories);
          syncVisibleSliceStore(previewCategories);
          setIsUsingMock(false);

          updateDiag('[Cache] Salvando vitrine compacta para boot rapido...', 94);
          await withTimeout(
            savePlaylistCache(previewCategories, cacheScope, parsedPlaylist.epgUrl),
            CACHE_IO_TIMEOUT_MS,
            'Timeout: Falha write-to-disk',
          ).catch(() => null);

          void syncCatalogSnapshot(userData.id, playlistUrl, parsedPlaylist.epgUrl, previewCategories);
          setPlaylistStatus('success');
          void hydrateEpgData(parsedPlaylist.epgUrl, cacheScope);
          setPlaylistProgress(100);
          appendProgressLog(
            `[Concluido] ${parsedPlaylist.totalLoaded} canais tokenizados na memoria (${previewCategories.length} categorias na vitrine).`,
          );
        } else {
          setNoContentError('M3U Vazia', 'O servidor forneceu um M3U que nao contem canais.');
          return;
        }
      } catch (error: any) {
        const errorStatus: PlaylistStatus = hasValidatedUser ? 'error_playlist' : 'error_auth';
        setPlaylistError({
          status: errorStatus,
          message: 'Falha CrÃ­tica ao carregar a lista IPTV',
          details: error.message || 'Erro nÃ£o mapeado no sistema de Parsing M3U.',
          playlistUrl,
        });
        if (!hasData) {
          setCatalogPreviewCategories([]);
          syncVisibleSliceStore([]);
          setIsUsingMock(false);
          setEpgData(null);
          setPlaylistStatus(errorStatus);
        }
        appendProgressLog(`[Erro] ${error?.message || 'Falha inesperada.'}`);
        setPlaylistProgress(100);
      } finally {
        setIsWritingDatabase(false);
        setLoading(false);
      }
    };

    activePlaylistLoadPromiseRef.current = withTimeout(run(), PLAYLIST_FLOW_WATCHDOG_TIMEOUT_MS, 'WatchDog: Fluxo travou completamente o Android (ProvÃ¡vel OOM).')
      .catch((error) => {
        setPlaylistStatus('error_playlist');
        setPlaylistError({
          status: 'error_playlist',
          message: 'Travamento Nativo Identificado',
          details: error instanceof Error ? error.message : 'Watchdog interceptou falha geral de app freeze.',
        });
        appendProgressLog(`[Erro] ${error instanceof Error ? error.message : 'Watchdog interceptou falha geral.'}`);
        setPlaylistProgress(100);
        setCatalogPreviewCategories([]);
        syncVisibleSliceStore([]);
        setIsUsingMock(false);
        setEpgData(null);
      })
      .finally(() => { setLoading(false); activePlaylistLoadPromiseRef.current = null; });

    return activePlaylistLoadPromiseRef.current;
  }, [
    appendProgressLog,
    catalogPreviewCategories,
    hydrateEpgData,
    setAdultAccessSettings,
    setEpgData,
    setIsUsingMock,
    setNoContentError,
    syncCatalogSnapshot,
    syncVisibleSliceStore,
    updateDiag,
  ]);

  return {
    fetchPlaylist,
    loading,
    playlistStatus,
    playlistError,
    playlistSource,
    playlistProgress,
    playlistLogs,
    catalogPreviewCategories,
    isWritingDatabase,
  };
};
