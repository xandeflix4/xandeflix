import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { detectTvEnvironment } from '../lib/deviceProfile';
import type { ManagedUser } from '../lib/adminSupabase';
import { EPGProgram, Media, PlaylistItem } from '../types';
import { fetchRemoteText } from '../lib/api';
import { parseM3U } from '../lib/m3uParser';
import { parseXMLTV } from '../lib/epgParser';

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
  favorites: PlaylistItem[]; 
  toggleFavorite: (item: PlaylistItem) => void;
  
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
}

const initialTvMode = detectTvEnvironment();
const MAX_VISIBLE_ITEMS = 220;

export const useStore = create<XandeflixState>()(
  persist(
    (set) => ({
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
      setActiveFilter: (filter) => set({ activeFilter: filter }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSelectedMedia: (media) => set({ selectedMedia: media }),
      setIsSettingsVisible: (visible) => set({ isSettingsVisible: visible }),
      setIsUsingMock: (using) => set({ isUsingMock: using }),
      
      setHiddenCategoryIds: (ids) => set({ hiddenCategoryIds: ids }),

      toggleFavorite: (item) =>
        set((state) => {
          const isFavorite = state.favorites.some((f) => f.id === item.id);
          const newFavorites = isFavorite
            ? state.favorites.filter((f) => f.id !== item.id)
            : [...state.favorites, item];
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
          selectedCategoryName: null,
          visibleItems: [],
          activeFilter: 'home',
          searchQuery: '',
          selectedMedia: null,
          isSettingsVisible: false,
          isUsingMock: false,
          epgData: null,
          playerMode: 'closed',
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
      isLoadingPlaylist: false,
      playlistError: null,

      fetchPlaylist: async (url: string) => {
        if (!url) return;
        set({ isLoadingPlaylist: true, playlistError: null, lastPlaylistUrl: url });

        try {
          // Roteamento de Proxy CORS (Etapa 15)
          const isNative = detectTvEnvironment() || (typeof window !== 'undefined' && (window as any).Capacitor);
          const finalUrl = isNative ? url : `/api/proxy?url=${encodeURIComponent(url)}`;
          
          const content = await fetchRemoteText(finalUrl, { timeoutMs: 15000 });
          
          // 2. Parse (Etapa 6)
          const flatItems = parseM3U(content);
          
          if (flatItems.length === 0) {
            throw new Error('Nenhum canal válido encontrado nesta lista.');
          }

          // 3. Agrupamento (Etapa 7)
          const grouped: Record<string, PlaylistItem[]> = {};
          flatItems.forEach(item => {
            const category = item.group || 'OUTROS';
            if (!grouped[category]) grouped[category] = [];
            grouped[category].push(item);
          });

          set({ 
            playlistCategories: grouped, 
            isLoadingPlaylist: false,
            selectedCategoryName: Object.keys(grouped)[0] || null
          });
        } catch (error: any) {
          const isCorsError = error.message?.toLowerCase().includes('fetch') || error.name === 'AbortError';
          const errorMessage = isCorsError 
            ? 'Erro de CORS: O servidor da lista bloqueou o acesso direto pelo navegador. Tente usar um Proxy ou o App nativo.'
            : error.message || 'Erro ao carregar playlist.';
            
          set({ 
            playlistError: errorMessage, 
            isLoadingPlaylist: false 
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
      version: 3,
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState as XandeflixState;
        }

        const safeState = persistedState as Partial<XandeflixState> & Record<string, unknown>;
        return {
          ...safeState,
          isTvMode: detectTvEnvironment(),
        } as XandeflixState;
      },
      partialize: (state) => ({
        favorites: state.favorites,
        lastPlaylistUrl: state.lastPlaylistUrl,
        lastEpgUrl: state.lastEpgUrl,
        watchHistory: state.watchHistory,
        playbackProgress: state.playbackProgress,
        hiddenCategoryIds: state.hiddenCategoryIds,
        isAdminMode: state.isAdminMode,
        adultAccess: state.adultAccess,
      }),
      storage: createJSONStorage(() => safeStateStorage),
    }
  )
);
