import { Media, MediaType } from '../types';

const TUPLE_WIDTH = 5;
const TYPE_FLAG_LIVE = 0;
const TYPE_FLAG_MOVIE = 1;
const TYPE_FLAG_SERIES = 2;
const LEGACY_INDEXED_DB_NAME = 'xandeflix-db';

const TYPE_FLAG_TO_MEDIA: Record<number, MediaType> = {
  [TYPE_FLAG_LIVE]: MediaType.LIVE,
  [TYPE_FLAG_MOVIE]: MediaType.MOVIE,
  [TYPE_FLAG_SERIES]: MediaType.SERIES,
};

const MEDIA_TO_TYPE_FLAG: Record<string, number> = {
  live: TYPE_FLAG_LIVE,
  movie: TYPE_FLAG_MOVIE,
  series: TYPE_FLAG_SERIES,
  episode: TYPE_FLAG_SERIES,
};

export type MediaItem = Media & {
  groupTitle?: string;
};

export interface CompressedDictionariesDelta {
  titles?: string[];
  groups?: string[];
  urls?: string[];
  logos?: string[];
}

export interface CompressedCatalogChunk {
  tuples: Int32Array | number[];
  tupleWidth?: number;
  dictionaries?: CompressedDictionariesDelta;
  reset?: boolean;
}

type GroupScanCursor = {
  chunkIndex: number;
  rowOffset: number;
  globalRow: number;
  matchedCount: number;
};

type CatalogState = {
  titles: string[];
  groups: string[];
  urls: string[];
  logos: string[];
  titleToIndex: Map<string, number>;
  groupNameToIndex: Map<string, number>;
  groupLowerNameToIndex: Map<string, number>;
  urlToIndex: Map<string, number>;
  logoToIndex: Map<string, number>;
  tupleChunks: Int32Array[];
  totalRows: number;
  groupCounts: Map<number, number>;
  scanCursors: Map<number, GroupScanCursor>;
};

function createEmptyState(): CatalogState {
  return {
    titles: [],
    groups: [],
    urls: [],
    logos: [],
    titleToIndex: new Map<string, number>(),
    groupNameToIndex: new Map<string, number>(),
    groupLowerNameToIndex: new Map<string, number>(),
    urlToIndex: new Map<string, number>(),
    logoToIndex: new Map<string, number>(),
    tupleChunks: [],
    totalRows: 0,
    groupCounts: new Map<number, number>(),
    scanCursors: new Map<number, GroupScanCursor>(),
  };
}

let catalog = createEmptyState();
let legacyQuotaCleanupAttempted = false;

async function cleanupLegacyIndexedDb(): Promise<void> {
  if (legacyQuotaCleanupAttempted) return;
  legacyQuotaCleanupAttempted = true;

  if (typeof indexedDB === 'undefined') return;

  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(LEGACY_INDEXED_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

function normalizeGroupTitle(rawValue: string | null | undefined): string {
  const normalized = String(rawValue || '').trim();
  return normalized || 'Geral';
}

function normalizeTypeFlag(rawType: string | MediaType | null | undefined): number {
  const key = String(rawType || '').toLowerCase();
  return MEDIA_TO_TYPE_FLAG[key] ?? TYPE_FLAG_LIVE;
}

function decodeTypeFlag(flag: number): MediaType {
  return TYPE_FLAG_TO_MEDIA[flag] ?? MediaType.LIVE;
}

function setGroupIndexLookups(groupName: string, groupIndex: number): void {
  const normalized = normalizeGroupTitle(groupName);
  if (!catalog.groupNameToIndex.has(normalized)) {
    catalog.groupNameToIndex.set(normalized, groupIndex);
  }
  const lower = normalized.toLowerCase();
  if (!catalog.groupLowerNameToIndex.has(lower)) {
    catalog.groupLowerNameToIndex.set(lower, groupIndex);
  }
}

function pushDictionaryEntry(
  dictionary: string[],
  map: Map<string, number>,
  rawValue: string | null | undefined,
): number {
  const value = String(rawValue || '').trim();
  const nextIndex = dictionary.length;
  dictionary.push(value);

  if (!map.has(value)) {
    map.set(value, nextIndex);
  }
  return nextIndex;
}

function appendDictionaryDelta(delta?: CompressedDictionariesDelta): void {
  if (!delta) return;

  const nextTitles = Array.isArray(delta.titles) ? delta.titles : [];
  const nextGroups = Array.isArray(delta.groups) ? delta.groups : [];
  const nextUrls = Array.isArray(delta.urls) ? delta.urls : [];
  const nextLogos = Array.isArray(delta.logos) ? delta.logos : [];

  for (const entry of nextTitles) {
    pushDictionaryEntry(catalog.titles, catalog.titleToIndex, entry);
  }
  for (const entry of nextUrls) {
    pushDictionaryEntry(catalog.urls, catalog.urlToIndex, entry);
  }
  for (const entry of nextLogos) {
    pushDictionaryEntry(catalog.logos, catalog.logoToIndex, entry);
  }
  for (const entry of nextGroups) {
    const groupName = normalizeGroupTitle(entry);
    const nextIndex = pushDictionaryEntry(catalog.groups, catalog.groupNameToIndex, groupName);
    setGroupIndexLookups(groupName, nextIndex);
  }
}

function toInt32TupleValues(input: Int32Array | number[]): Int32Array {
  if (input instanceof Int32Array) return input;
  if (!Array.isArray(input) || input.length === 0) return new Int32Array();

  const output = new Int32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const value = Number(input[index]);
    output[index] = Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  return output;
}

function appendTupleValues(tupleValues: Int32Array, tupleWidth: number): void {
  if (!tupleValues.length) return;
  if (tupleWidth !== TUPLE_WIDTH) {
    throw new Error(`Tuple width invalida: esperado ${TUPLE_WIDTH}, recebido ${tupleWidth}.`);
  }
  if ((tupleValues.length % tupleWidth) !== 0) {
    throw new Error('Tuplas condensadas invalidas: tamanho nao multiplo da largura da tupla.');
  }

  const rowCount = Math.floor(tupleValues.length / tupleWidth);
  catalog.tupleChunks.push(tupleValues);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const base = rowIndex * tupleWidth;
    const groupIdx = tupleValues[base + 1] ?? 0;

    const currentCount = catalog.groupCounts.get(groupIdx) || 0;
    catalog.groupCounts.set(groupIdx, currentCount + 1);

    const groupName = normalizeGroupTitle(catalog.groups[groupIdx]);
    setGroupIndexLookups(groupName, groupIdx);
  }

  catalog.totalRows += rowCount;
}

function getOrCreateDictionaryIndex(
  map: Map<string, number>,
  dictionary: string[],
  rawValue: string | null | undefined,
  normalize?: (value: string) => string,
): number {
  const raw = String(rawValue || '').trim();
  const value = normalize ? normalize(raw) : raw;
  const found = map.get(value);
  if (typeof found === 'number') return found;

  const nextIndex = dictionary.length;
  dictionary.push(value);
  map.set(value, nextIndex);
  return nextIndex;
}

function appendRawMediaItems(channels: MediaItem[]): void {
  if (channels.length === 0) return;

  const tuples = new Int32Array(channels.length * TUPLE_WIDTH);
  let writeOffset = 0;

  for (const channel of channels) {
    const title = String(channel.title || 'Canal').trim() || 'Canal';
    const groupTitle = normalizeGroupTitle(channel.groupTitle || channel.category);
    const videoUrl = String(channel.videoUrl || '').trim();
    const logo = String(channel.thumbnail || '').trim();
    const typeFlag = normalizeTypeFlag(channel.type);

    const titleIdx = getOrCreateDictionaryIndex(catalog.titleToIndex, catalog.titles, title);
    const groupIdx = getOrCreateDictionaryIndex(
      catalog.groupNameToIndex,
      catalog.groups,
      groupTitle,
      normalizeGroupTitle,
    );
    const urlIdx = getOrCreateDictionaryIndex(catalog.urlToIndex, catalog.urls, videoUrl);
    const logoIdx = getOrCreateDictionaryIndex(catalog.logoToIndex, catalog.logos, logo);

    setGroupIndexLookups(groupTitle, groupIdx);

    tuples[writeOffset] = titleIdx;
    tuples[writeOffset + 1] = groupIdx;
    tuples[writeOffset + 2] = urlIdx;
    tuples[writeOffset + 3] = logoIdx;
    tuples[writeOffset + 4] = typeFlag;
    writeOffset += TUPLE_WIDTH;
  }

  appendTupleValues(tuples, TUPLE_WIDTH);
}

function buildMediaFromTuple(
  globalRowIndex: number,
  titleIdx: number,
  groupIdx: number,
  urlIdx: number,
  logoIdx: number,
  typeFlag: number,
): MediaItem {
  const title = String(catalog.titles[titleIdx] || `Canal ${globalRowIndex + 1}`);
  const groupTitle = normalizeGroupTitle(catalog.groups[groupIdx]);
  const videoUrl = String(catalog.urls[urlIdx] || '');
  const thumbnail = String(catalog.logos[logoIdx] || '');
  const type = decodeTypeFlag(typeFlag);

  return {
    id: `mem-${globalRowIndex}-${urlIdx}`,
    title,
    description: '',
    thumbnail,
    backdrop: thumbnail,
    videoUrl,
    type,
    year: 0,
    rating: '',
    category: groupTitle,
    groupTitle,
    tvgName: title,
  };
}

function resolveGroupIndex(category: string): number | null {
  const normalizedCategory = normalizeGroupTitle(category);
  const exact = catalog.groupNameToIndex.get(normalizedCategory);
  if (typeof exact === 'number') return exact;

  const lower = catalog.groupLowerNameToIndex.get(normalizedCategory.toLowerCase());
  if (typeof lower === 'number') return lower;

  return null;
}

function getCursorStart(
  groupIndex: number,
  safeOffset: number,
): { chunkIndex: number; rowOffset: number; globalRow: number; matchedCount: number } {
  const cursor = catalog.scanCursors.get(groupIndex);
  if (!cursor) {
    return { chunkIndex: 0, rowOffset: 0, globalRow: 0, matchedCount: 0 };
  }

  if (safeOffset >= cursor.matchedCount) {
    return {
      chunkIndex: cursor.chunkIndex,
      rowOffset: cursor.rowOffset,
      globalRow: cursor.globalRow,
      matchedCount: cursor.matchedCount,
    };
  }

  return { chunkIndex: 0, rowOffset: 0, globalRow: 0, matchedCount: 0 };
}

export async function clearAllChannels(): Promise<void> {
  await cleanupLegacyIndexedDb();
  catalog = createEmptyState();
}

export async function appendCompressedChannelsChunk(chunk: CompressedCatalogChunk): Promise<void> {
  if (chunk.reset) {
    await clearAllChannels();
  }

  appendDictionaryDelta(chunk.dictionaries);

  const tupleWidth = Number.isFinite(chunk.tupleWidth)
    ? Math.max(1, Math.floor(chunk.tupleWidth as number))
    : TUPLE_WIDTH;
  const tupleValues = toInt32TupleValues(chunk.tuples);
  appendTupleValues(tupleValues, tupleWidth);
}

export async function insertChannels(channels: MediaItem[]): Promise<void> {
  if (!channels.length) return;
  appendRawMediaItems(channels);
}

export async function getChannelsByCategory(
  category: string,
  offset: number,
  limit: number,
): Promise<MediaItem[]> {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (safeLimit === 0) return [];

  const groupIndex = resolveGroupIndex(category);
  if (groupIndex == null) return [];

  const totalForGroup = catalog.groupCounts.get(groupIndex) || 0;
  if (totalForGroup === 0 || safeOffset >= totalForGroup) return [];

  const results: MediaItem[] = [];
  const start = getCursorStart(groupIndex, safeOffset);
  let currentChunkIndex = start.chunkIndex;
  let currentRowOffset = start.rowOffset;
  let globalRow = start.globalRow;
  let matchedCount = start.matchedCount;

  while (currentChunkIndex < catalog.tupleChunks.length) {
    const chunk = catalog.tupleChunks[currentChunkIndex];
    const rowCount = Math.floor(chunk.length / TUPLE_WIDTH);

    for (let row = currentRowOffset; row < rowCount; row += 1) {
      const base = row * TUPLE_WIDTH;
      const titleIdx = chunk[base] ?? 0;
      const tupleGroupIdx = chunk[base + 1] ?? 0;
      const urlIdx = chunk[base + 2] ?? 0;
      const logoIdx = chunk[base + 3] ?? 0;
      const typeFlag = chunk[base + 4] ?? 0;

      if (tupleGroupIdx === groupIndex) {
        if (matchedCount >= safeOffset) {
          results.push(buildMediaFromTuple(globalRow, titleIdx, tupleGroupIdx, urlIdx, logoIdx, typeFlag));
          if (results.length >= safeLimit) {
            const nextRow = row + 1;
            const nextChunkIndex = nextRow < rowCount ? currentChunkIndex : currentChunkIndex + 1;
            const nextRowOffset = nextRow < rowCount ? nextRow : 0;
            catalog.scanCursors.set(groupIndex, {
              chunkIndex: nextChunkIndex,
              rowOffset: nextRowOffset,
              globalRow: globalRow + 1,
              matchedCount: matchedCount + 1,
            });
            return results;
          }
        }
        matchedCount += 1;
      }

      globalRow += 1;
    }

    currentChunkIndex += 1;
    currentRowOffset = 0;
  }

  catalog.scanCursors.set(groupIndex, {
    chunkIndex: catalog.tupleChunks.length,
    rowOffset: 0,
    globalRow: catalog.totalRows,
    matchedCount,
  });

  return results;
}

export async function getCategories(): Promise<string[]> {
  const categories: string[] = [];
  for (const [groupIndex, count] of catalog.groupCounts.entries()) {
    if (count <= 0) continue;
    categories.push(normalizeGroupTitle(catalog.groups[groupIndex]));
  }
  return categories;
}

export function getChannelsCatalogStats(): { totalChannels: number; totalCategories: number } {
  let totalCategories = 0;
  for (const [, count] of catalog.groupCounts.entries()) {
    if (count > 0) totalCategories += 1;
  }

  return {
    totalChannels: catalog.totalRows,
    totalCategories,
  };
}
