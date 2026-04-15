export enum MediaType {
  MOVIE = 'movie',
  SERIES = 'series',
  EPISODE = 'episode',
  LIVE = 'live'
}

export interface Episode {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  videoUrl: string;
}

export interface Media {
  id: string;
  title: string;
  description: string;
  thumbnail: string;
  backdrop: string;
  videoUrl: string;
  type: MediaType;
  year: number;
  rating: string;
  duration?: string;
  category: string;
  tvgId?: string;
  tvgName?: string;
  currentEpisode?: Episode;
  currentSeasonNumber?: number;
  seasons?: {
    seasonNumber: number;
    episodes: Episode[];
  }[];
  qualities?: { name: string; url: string }[];
}

export interface Category {
  id: string;
  title: string;
  type?: string;
  items: Media[];
}

export interface EPGProgram {
  id: string;
  channelId: string;
  start: number;
  stop: number;
  title: string;
  description: string;
}

export interface User {
  id: string;
  name: string;
  avatar: string;
}

export interface PlaylistItem {
  id: string;
  title: string;
  group: string;
  logo: string;
  url: string;
}
