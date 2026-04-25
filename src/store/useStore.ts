import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { detectTvEnvironment } from '../lib/deviceProfile';
import type { ManagedUser } from '../lib/adminSupabase';
import { EPGProgram, Media, PlaylistItem } from '../types';
import { fetchRemoteText } from '../lib/api';
import { parseM3U } from '../lib/m3uParser';
import { parseXMLTV } from '../lib/epgParser';
import { cleanMediaTitle } from '../lib/titleCleaner';

export type AdultAccessState = {
  enabled: boolean;
  totpEnabled: boolean;
};

type PlaybackProgressEntry = {
  currentTime: number;
  duration: number;
  timestamp: number;
};

type SavePlaybackProgressInput = {
  mediaId?: string;
  url: string;
  currentTime: number;
  duration?: number;
};

export type LastLiveChannelState = {
  categoryId: string;
  mediaId: string;
  mediaTitle: string;
  section: string; // 'live' | 'sports' etc.
  timestamp: number;
};

const safeStateStorage: StateStorage = {
  getItem: (name) => {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    const rawValue = localStorage.getItem(name);
    if (rawValue == null) {
      return null;
    }

    try {
      JSON.parse(rawValue);
      return rawValue;
    } catch (error) {
      console.error('[StorePersist] Cache persistido invalido, removendo chave:', name, error);
      localStorage.removeItem(name);
      return null;
    }
  },
  setItem: (name, value) => {
    if (typeof localStorage === 'undefined') {
      return;
    }

    localStorage.setItem(name, value);
  },
  removeItem: (name) => {
    if (typeof localStorage === 'undefined') {
      return;
    }

    localStorage.removeItem(name);
  },
};

interface XandeflixState {
  selectedCategoryName: string | null;
  setSelectedCategoryName: (name: string | null) => void;
  visibleItems: Media[];
  setVisibleItems: (items: Media[]) => void;
  appendVisibleItems: (items: Media[]) => void;
  clearVisibleItems: () => void;

  activeFilter: string;
  setActiveFilter: (filter: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  selectedMedia: Media | null;
  setSelectedMedia: (media: Media | null) => void;
  isSettingsVisible: boolean;
  setIsSettingsVisible: (visible: boolean) => void;

  hiddenCategoryIds: string[];
  setHiddenCategoryIds: (ids: string[]) => void;

  isUsingMock: boolean;
  setIsUsingMock: (using: boolean) => void;

  // New persistent states
  favorites: string[];
  toggleFavorite: (key: string) => void;
  
  lastPlaylistUrl: string | null;
  lastEpgUrl: string | null;
  
  watchHistory: Record<string, number>; // url -> timeInSeconds
  updateWatchHistory: (url: string, timeInSeconds: number, duration?: number) => void;
  savePlaybackProgress: (input: SavePlaybackProgressInput) => void;

  epgData: Record<string, EPGProgram[]> | null;
  setEpgData: (epgData: Record<string, EPGProgram[]> | null) => void;
  appendEpgData: (epgData: Record<string, EPGProgram[]>) => void;

  playbackProgress: Record<string, PlaybackProgressEntry>;

  isAdminMode: boolean;
  setIsAdminMode: (mode: boolean) => void;
  managedUsers: ManagedUser[];
  setManagedUsers: (users: ManagedUser[]) => void;

  adultAccess: AdultAccessState;
  setAdultAccessSettings: (settings?: Partial<AdultAccessState> | null) => void;
  isAdultUnlocked: boolean;
  unlockAdultContent: () => void;
  lockAdultContent: () => void;
  hydrateProfileState: (userId?: string) => void;
  clearSessionState: () => void;
  isTvMode: boolean;
  setIsTvMode: (enabled: boolean) => void;
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
  playerMode: 'fullscreen' | 'minimized' | 'closed';
  setPlayerMode: (mode: 'fullscreen' | 'minimized' | 'closed') => void;

  playlistCategories: Record<string, PlaylistItem[]>;
  fetchPlaylist: (url: string) => Promise<void>;
  playlistError: string | null;

  isLoadingEPG: boolean;
  epgError: string | null;
  fetchEPG: (url: string) => Promise<void>;

  lastLiveChannel: LastLiveChannelState | null;
  setLastLiveChannel: (state: LastLiveChannelState | null) => void;

  // Video Player Persistence
  activeVideoUrl: string | null;
  setActiveVideoUrl: (url: string | null) => void;
  playingMedia: Media | null;
  setPlayingMedia: (media: Media | null) => void;
  videoType: 'live' | 'movie' | 'series' | null;
  setVideoType: (type: 'live' | 'movie' | 'series' | null) => void;
  isChannelBrowserOpen: boolean;
  setIsChannelBrowserOpen: (open: boolean) => void;
}

const initialTvMode = detectTvEnvironment();
const MAX_VISIBLE_ITEMS = 220;

function organizeSeasons(episodes: any[]) {
  const seasonsMap: Record<number, any[]> = {};
  episodes.forEach(ep => {
    if (!seasonsMap[ep.seasonNumber]) seasonsMap[ep.seasonNumber] = [];
    seasonsMap[ep.seasonNumber].push(ep);
  });

  return Object.entries(seasonsMap)
    .map(([num, eps]) => ({
      seasonNumber: parseInt(num, 10),
      episodes: eps.sort((a, b) => a.episodeNumber - b.episodeNumber)
    }))
    .sort((a, b) => a.seasonNumber - b.seasonNumber);
}

export const useStore = create<XandeflixState>()(
  persist(
    (set, get) => ({
      selectedCategoryName: null,
      visibleItems: [],
      activeFilter: 'home',
      searchQuery: '',
      selectedMedia: null,
      isSettingsVisible: false,
      isUsingMock: false,
      hiddenCategoryIds: [],
      favorites: [],
      lastPlaylistUrl: null,
      lastEpgUrl: null,
      watchHistory: {},
      epgData: null,
      playbackProgress: {},
      isAdminMode: false,
      managedUsers: [],
      adultAccess: { enabled: false, totpEnabled: false },
      isAdultUnlocked: false,
      isTvMode: initialTvMode,
      focusedId: null,
      playerMode: 'closed',
      lastLiveChannel: null,
      activeVideoUrl: null,
      playingMedia: null,
      videoType: null,

      setLastLiveChannel: (channelState) => set({ lastLiveChannel: channelState }),

      setIsTvMode: (enabled) => set({ isTvMode: enabled }),
      setFocusedId: (id) => set({ focusedId: id }),
      setPlayerMode: (mode) => set({ playerMode: mode }),

      setSelectedCategoryName: (name) => set({ selectedCategoryName: name }),
      setVisibleItems: (items) =>
        set({
          visibleItems: items.slice(0, MAX_VISIBLE_ITEMS),
        }),
      appendVisibleItems: (items) =>
        set((state) => {
          const existing = state.visibleItems;
          const seen = new Set(existing.map((item) => `${item.id}::${item.videoUrl}`));
          const merged = [...existing];

          for (const item of items) {
            const key = `${item.id}::${item.videoUrl}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(item);
            if (merged.length >= MAX_VISIBLE_ITEMS) break;
          }

          return {
            visibleItems: merged.slice(0, MAX_VISIBLE_ITEMS),
          };
        }),
      clearVisibleItems: () => set({ visibleItems: [] }),
      setActiveFilter: (filter) => {
        console.log(`[Store] Alterando activeFilter: ${useStore.getState().activeFilter} -> ${filter}`);
        set({ activeFilter: filter });
      },
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSelectedMedia: (media) => set({ selectedMedia: media }),
      setIsSettingsVisible: (visible) => set({ isSettingsVisible: visible }),
      setIsUsingMock: (using) => set({ isUsingMock: using }),
      setActiveVideoUrl: (url) => set({ activeVideoUrl: url }),
      setPlayingMedia: (media) => set({ playingMedia: media }),
      setVideoType: (type) => set({ videoType: type }),
      isChannelBrowserOpen: false,
      setIsChannelBrowserOpen: (open) => set({ isChannelBrowserOpen: open }),
      
      setHiddenCategoryIds: (ids) => set({ hiddenCategoryIds: ids }),

      toggleFavorite: (key) =>
        set((state) => {
          const isFavorite = state.favorites.includes(key);
          const newFavorites = isFavorite
            ? state.favorites.filter((f) => f !== key)
            : [...state.favorites, key];
          return { favorites: newFavorites };
        }),

      updateWatchHistory: (url: string, time: number, duration?: number) =>
        set((state) => ({
          watchHistory: {
            ...state.watchHistory,
            [url]: time
          },
          playbackProgress: {
            ...state.playbackProgress,
            [url]: {
              currentTime: time,
              duration: duration ?? state.playbackProgress[url]?.duration ?? 0,
              timestamp: Date.now(),
            },
          },
        })),

      savePlaybackProgress: ({ mediaId, url, currentTime, duration }) =>
        set((state) => {
          const previousUrlEntry = state.playbackProgress[url];
          const previousMediaEntry = mediaId ? state.playbackProgress[mediaId] : undefined;
          const entry: PlaybackProgressEntry = {
            currentTime,
            duration:
              duration ??
              previousMediaEntry?.duration ??
              previousUrlEntry?.duration ??
              0,
            timestamp: Date.now(),
          };

          return {
            watchHistory: {
              ...state.watchHistory,
              [url]: currentTime,
            },
            playbackProgress: {
              ...state.playbackProgress,
              [url]: entry,
              ...(mediaId ? { [mediaId]: entry } : {}),
            },
          };
        }),

      setEpgData: (epgData) => set({ epgData }),
      appendEpgData: (newData) => 
        set((state) => {
          const updated = { ...(state.epgData || {}) };
          Object.entries(newData).forEach(([channelId, programs]) => {
            if (updated[channelId]) {
              // Merge programs and sort
              const seenIds = new Set(updated[channelId].map(p => p.id));
              const uniqueNew = programs.filter(p => !seenIds.has(p.id));
              updated[channelId] = [...updated[channelId], ...uniqueNew].sort((a, b) => a.start - b.start);
            } else {
              updated[channelId] = programs;
            }
          });
          return { epgData: updated };
        }),

      setIsAdminMode: (mode) => set({ isAdminMode: mode }),
      setManagedUsers: (users) => set({ managedUsers: users }),
      setAdultAccessSettings: (settings) => {
        const enabled = Boolean(settings?.enabled);
        set((state) => ({
          adultAccess: {
            ...state.adultAccess,
            enabled,
            totpEnabled: Boolean(settings?.totpEnabled),
          },
          isAdultUnlocked: enabled ? state.isAdultUnlocked : false,
        }));
      },
      unlockAdultContent: () => set({ isAdultUnlocked: true }),
      lockAdultContent: () => set({ isAdultUnlocked: false }),
      hydrateProfileState: () =>
        set({
          visibleItems: [],
          searchQuery: '',
          isSettingsVisible: false,
          isUsingMock: false,
        }),
      clearSessionState: () =>
        set({
          selectedCategoryName: null,
          visibleItems: [],
          activeFilter: 'home',
          searchQuery: '',
          selectedMedia: null,
          isSettingsVisible: false,
          isUsingMock: false,
          managedUsers: [],
          adultAccess: { enabled: false, totpEnabled: false },
          isAdultUnlocked: false,
          epgData: null,
          playbackProgress: {},
          playerMode: 'closed',
          playlistCategories: {},
        }),

      playlistCategories: {},
      playlistError: null,

      fetchPlaylist: async (url: string) => {
        if (!url) return;
        set({ playlistError: null, lastPlaylistUrl: url });

        try {
          // Roteamento de Proxy CORS (Etapa 15)
          const isNative = detectTvEnvironment() || (typeof window !== 'undefined' && (window as any).Capacitor);
          const finalUrl = isNative ? url : `/api/proxy?url=${encodeURIComponent(url)}`;

          const content = await fetchRemoteText(finalUrl, { timeoutMs: 15000 });

          const { items: flatItems, epgUrl } = parseM3U(content);

          if (flatItems.length === 0) {
            throw new Error('Nenhum canal válido encontrado nesta lista.');
          }

          // Iniciar carregamento do EPG em background se disponível
          if (epgUrl) {
            void get().fetchEPG(epgUrl);
          }

          // 3. Agrupamento e Consolidação de Séries (Etapa 20)
          const grouped: Record<string, PlaylistItem[]> = {};
          const seriesData: Record<string, { main: PlaylistItem, episodes: any[] }> = {};

          flatItems.forEach(item => {
            const category = item.group || 'OUTROS';
            const { cleanTitle, season, episode } = cleanMediaTitle(item.title);
            
            // Se for identificado como episódio de série (tem SxxExx no título)
            if (season !== undefined && episode !== undefined) {
              const seriesKey = `${cleanTitle}-${category}`.toLowerCase();
              if (!seriesData[seriesKey]) {
                seriesData[seriesKey] = {
                  main: { 
                    ...item, 
                    title: cleanTitle, 
                    id: `series-${seriesKey}`
                  },
                  episodes: []
                };
              }
              seriesData[seriesKey].episodes.push({
                id: item.id,
                title: item.title,
                seasonNumber: season,
                episodeNumber: episode,
                videoUrl: item.url
              });
            } else {
              if (!grouped[category]) grouped[category] = [];
              const mediaItem = { ...item };
              // Determina se é live ou movie baseado no grupo ou metadados
              const isLive = category.toLowerCase().includes('canais') || 
                             category.toLowerCase().includes('live') || 
                             category.toLowerCase().includes('radio');
              mediaItem.type = isLive ? 'live' : 'movie';
              grouped[category].push(mediaItem);
            }
          });

          // Injetar as séries agrupadas de volta nas categorias
          Object.values(seriesData).forEach(group => {
            const item = group.main;
            const category = item.group || 'OUTROS';
            if (!grouped[category]) grouped[category] = [];
            
            // Anexa os episódios encontrados ao item principal
            (item as any).seasons = organizeSeasons(group.episodes);
            (item as any).type = 'series';
            
            grouped[category].push(item);
          });

          set({
            playlistCategories: grouped,
            selectedCategoryName: Object.keys(grouped)[0] || null
          });
        } catch (error: any) {
          const isCorsError = error.message?.toLowerCase().includes('fetch') || error.name === 'AbortError';
          const errorMessage = isCorsError
            ? 'Erro de CORS: O servidor da lista bloqueou o acesso direto pelo navegador. Tente usar um Proxy ou o App nativo.'
            : error.message || 'Erro ao carregar playlist.';

          set({
            playlistError: errorMessage,
          });
          console.error('[Store] Falha no carregamento M3U:', error);
        }
      },

      isLoadingEPG: false,
      epgError: null,

      fetchEPG: async (url: string) => {
        if (!url) return;
        set({ isLoadingEPG: true, epgError: null, lastEpgUrl: url });

        try {
          const isNative = detectTvEnvironment() || (typeof window !== 'undefined' && (window as any).Capacitor);
          const finalUrl = isNative ? url : `/api/proxy?url=${encodeURIComponent(url)}`;
          
          const xmlContent = await fetchRemoteText(finalUrl, { timeoutMs: 15000 });
          const groupedData = parseXMLTV(xmlContent);
          set({ epgData: groupedData, isLoadingEPG: false });
        } catch (error: any) {
          set({ epgError: error.message || 'Erro ao carregar EPG', isLoadingEPG: false });
          console.error('[Store] Erro EPG:', error);
        }
      },
    }),
    {
      name: 'xandeflix-app-storage',
      version: 5,
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState as XandeflixState;
        }

        const safeState = persistedState as Partial<XandeflixState> & Record<string, unknown>;
        const {
          activeVideoUrl: _activeVideoUrl,
          playingMedia: _playingMedia,
          videoType: _videoType,
          playerMode: _playerMode,
          focusedId: _focusedId,
          isChannelBrowserOpen: _isChannelBrowserOpen,
          selectedMedia: _selectedMedia,
          ...durableState
        } = safeState;
        return {
          ...durableState,
          isTvMode: detectTvEnvironment(),
        } as XandeflixState;
      },
      onRehydrateStorage: (state) => {
        console.log('[Store] Iniciando re-hidratacao...');
        return (hydratedState, error) => {
          if (error) {
            console.error('[Store] Erro na re-hidratacao:', error);
          } else {
            console.log('[Store] Re-hidratacao concluida. activeFilter:', hydratedState?.activeFilter);
          }
        };
      },
      partialize: (state) => ({
        // Persistimos apenas dados duráveis; estados transitórios de player/foco
        // ficam fora para evitar escrita síncrona frequente em Android TV.
        favorites: state.favorites,
        lastPlaylistUrl: state.lastPlaylistUrl,
        lastEpgUrl: state.lastEpgUrl,
        watchHistory: state.watchHistory,
        playbackProgress: state.playbackProgress,
        hiddenCategoryIds: state.hiddenCategoryIds,
        isAdminMode: state.isAdminMode,
        adultAccess: state.adultAccess,
        lastLiveChannel: state.lastLiveChannel,
        activeFilter: state.activeFilter,
        selectedCategoryName: state.selectedCategoryName,
      }),
      storage: createJSONStorage(() => safeStateStorage),
    }
  )
);
