import type { Category, Media } from '../types';
import { supabase } from './supabase';
import type { Json, PlaylistCatalogSnapshotRow } from '../types/supabase';

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_ITEM_SAMPLE_LIMIT = 12;
const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 320;
const MAX_THUMBNAIL_LENGTH = 1024;
const MAX_URL_LENGTH = 2048;

export type PlaylistCatalogSnapshotItem = {
  title: string;
  url: string;
  thumbnail: string;
  description: string;
  type: string;
};

export type PlaylistCatalogSnapshotCategory = {
  id: string;
  title: string;
  type?: string;
  itemCount: number;
  items: PlaylistCatalogSnapshotItem[];
};

export type PlaylistCatalogSnapshotData = {
  version: number;
  sampleItemLimit: number;
  categories: PlaylistCatalogSnapshotCategory[];
};

export type PlaylistCatalogSnapshotView = {
  userId: string;
  playlistUrl: string;
  epgUrl: string | null;
  categoryCount: number;
  itemCount: number;
  generatedAt: string;
  sourceHash: string | null;
  snapshot: PlaylistCatalogSnapshotData;
};

function sanitizeText(value: string | undefined, maxLength: number): string {
  return (value || '').trim().slice(0, maxLength);
}

function getPreviewUrl(media: Media): string {
  if (media.videoUrl) {
    return media.videoUrl;
  }

  return media.seasons?.[0]?.episodes?.[0]?.videoUrl || '';
}

function toSnapshotItem(media: Media): PlaylistCatalogSnapshotItem {
  return {
    title: sanitizeText(media.title, MAX_TITLE_LENGTH),
    url: sanitizeText(getPreviewUrl(media), MAX_URL_LENGTH),
    thumbnail: sanitizeText(media.thumbnail, MAX_THUMBNAIL_LENGTH),
    description: sanitizeText(media.description, MAX_DESCRIPTION_LENGTH),
    type: String(media.type || ''),
  };
}

export function buildPlaylistCatalogSnapshotData(
  categories: Category[],
  options?: {
    sampleItemLimit?: number;
  },
): PlaylistCatalogSnapshotData {
  const sampleItemLimit = options?.sampleItemLimit ?? SNAPSHOT_ITEM_SAMPLE_LIMIT;

  return {
    version: SNAPSHOT_VERSION,
    sampleItemLimit,
    categories: categories.map((category) => ({
      id: category.id,
      title: sanitizeText(category.title, MAX_TITLE_LENGTH),
      type: category.type,
      itemCount: category.items.length,
      items: category.items.slice(0, sampleItemLimit).map(toSnapshotItem),
    })),
  };
}

function computeSourceHash(playlistUrl: string, categoryCount: number, itemCount: number): string {
  return `${playlistUrl.trim()}::${categoryCount}::${itemCount}`;
}

function isSnapshotCategory(value: Json | undefined): value is PlaylistCatalogSnapshotCategory {
  return Boolean(
    value &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.title === 'string' &&
      typeof value.itemCount === 'number' &&
      Array.isArray(value.items),
  );
}

function isSnapshotData(value: Json): value is PlaylistCatalogSnapshotData {
  return Boolean(
    value &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      typeof value.version === 'number' &&
      typeof value.sampleItemLimit === 'number' &&
      Array.isArray(value.categories) &&
      value.categories.every((category) => isSnapshotCategory(category)),
  );
}

function toSnapshotView(row: PlaylistCatalogSnapshotRow): PlaylistCatalogSnapshotView | null {
  if (!isSnapshotData(row.snapshot)) {
    return null;
  }

  return {
    userId: row.user_id,
    playlistUrl: row.playlist_url,
    epgUrl: row.epg_url,
    categoryCount: row.category_count,
    itemCount: row.item_count,
    generatedAt: row.generated_at,
    sourceHash: row.source_hash,
    snapshot: row.snapshot,
  };
}

export async function upsertPlaylistCatalogSnapshot(input: {
  userId: string;
  playlistUrl: string;
  epgUrl: string | null;
  categories: Category[];
}): Promise<void> {
  const snapshot = buildPlaylistCatalogSnapshotData(input.categories);
  const categoryCount = snapshot.categories.length;
  const itemCount = snapshot.categories.reduce((total, category) => total + category.itemCount, 0);

  const { error } = await supabase.from('playlist_catalog_snapshots').upsert(
    {
      user_id: input.userId,
      playlist_url: input.playlistUrl,
      epg_url: input.epgUrl,
      category_count: categoryCount,
      item_count: itemCount,
      source_hash: computeSourceHash(input.playlistUrl, categoryCount, itemCount),
      generated_at: new Date().toISOString(),
      snapshot,
    },
    { onConflict: 'user_id' },
  );

  if (error) {
    throw error;
  }
}

export async function getPlaylistCatalogSnapshotForUser(
  userId: string,
): Promise<PlaylistCatalogSnapshotView | null> {
  const { data, error } = await supabase
    .from('playlist_catalog_snapshots')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return toSnapshotView(data as PlaylistCatalogSnapshotRow);
}

export async function deletePlaylistCatalogSnapshotForUser(userId: string): Promise<void> {
  const { error } = await supabase.from('playlist_catalog_snapshots').delete().eq('user_id', userId);

  if (error) {
    throw error;
  }
}
