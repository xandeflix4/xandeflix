import { M3UParser } from '../lib/m3uParser';
import { Media, MediaType } from '../types';

const DEFAULT_BATCH_SIZE = 2000;
const YIELD_EVERY_LINES = 4000;
const TUPLE_WIDTH = 5;

const TYPE_FLAG_LIVE = 0;
const TYPE_FLAG_MOVIE = 1;
const TYPE_FLAG_SERIES = 2;

interface WorkerTask {
  playlistUrl?: string;
  m3uText?: string;
  batchSize?: number;
}

interface WorkerCatalogDictionaries {
  titles: string[];
  groups: string[];
  urls: string[];
  logos: string[];
}

interface WorkerCatalogMaps {
  titles: Map<string, number>;
  groups: Map<string, number>;
  urls: Map<string, number>;
  logos: Map<string, number>;
}

type WorkerRuntime = {
  tupleBatch: number[];
  batchSize: number;
  totalLoaded: number;
  currentItemAttributes: Partial<Media> | null;
  lineNumber: number;
  epgUrl: string | null;
  firstNonEmptySeen: boolean;
  dictionaries: WorkerCatalogDictionaries;
  maps: WorkerCatalogMaps;
  dictionaryDelta: WorkerCatalogDictionaries;
};

function postToMain(message: unknown, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    (self as any).postMessage(message, transfer);
    return;
  }
  (self as any).postMessage(message);
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function extractExtinfPayload(line: string): { attributes: string; name: string } {
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let commaIndex = -1;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === ',' && !inSingleQuote && !inDoubleQuote) {
      commaIndex = i;
      break;
    }
  }

  if (commaIndex === -1) {
    return { attributes: line, name: 'Canal' };
  }

  return {
    attributes: line.slice(0, commaIndex),
    name: line.slice(commaIndex + 1).trim() || 'Canal',
  };
}

function extractEpgUrl(line: string): string | null {
  if (!line.toUpperCase().startsWith('#EXTM3U')) return null;
  const match = line.match(/\burl-tvg=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  return (match?.[1] || match?.[2] || match?.[3] || '').trim() || null;
}

function normalizeStreamType(streamUrl: string, fallbackType: MediaType): MediaType {
  const lowerUrl = streamUrl.toLowerCase();

  if (lowerUrl.includes('/live/')) return MediaType.LIVE;
  if (lowerUrl.includes('/movie/')) return MediaType.MOVIE;
  if (lowerUrl.includes('/series/')) return MediaType.SERIES;
  if (lowerUrl.includes('output=ts') || lowerUrl.includes('output=mpegts')) return MediaType.LIVE;

  return fallbackType;
}

function toTypeFlag(typeValue: MediaType): number {
  if (typeValue === MediaType.MOVIE) return TYPE_FLAG_MOVIE;
  if (typeValue === MediaType.SERIES || typeValue === MediaType.EPISODE) return TYPE_FLAG_SERIES;
  return TYPE_FLAG_LIVE;
}

function getDictionaryIndex(
  map: Map<string, number>,
  dictionary: string[],
  delta: string[],
  rawValue: string | null | undefined,
): number {
  const normalized = String(rawValue || '').trim();
  const value = normalized;
  const found = map.get(value);
  if (typeof found === 'number') {
    return found;
  }

  const nextIndex = dictionary.length;
  dictionary.push(value);
  map.set(value, nextIndex);
  delta.push(value);
  return nextIndex;
}

function encodeChannelTuple(
  runtime: WorkerRuntime,
  parsed: Partial<Media>,
  streamUrl: string,
): void {
  const title = String(parsed.title || 'Canal').trim() || 'Canal';
  const group = M3UParser.normalizeCategoryTitle(String(parsed.category || 'Geral'));
  const logo = String(parsed.thumbnail || '').trim();
  const resolvedType = normalizeStreamType(streamUrl, (parsed.type as MediaType) || MediaType.LIVE);
  const typeFlag = toTypeFlag(resolvedType);

  const titleIdx = getDictionaryIndex(
    runtime.maps.titles,
    runtime.dictionaries.titles,
    runtime.dictionaryDelta.titles,
    title,
  );
  const groupIdx = getDictionaryIndex(
    runtime.maps.groups,
    runtime.dictionaries.groups,
    runtime.dictionaryDelta.groups,
    group,
  );
  const urlIdx = getDictionaryIndex(
    runtime.maps.urls,
    runtime.dictionaries.urls,
    runtime.dictionaryDelta.urls,
    streamUrl,
  );
  const logoIdx = getDictionaryIndex(
    runtime.maps.logos,
    runtime.dictionaries.logos,
    runtime.dictionaryDelta.logos,
    logo,
  );

  runtime.tupleBatch.push(titleIdx, groupIdx, urlIdx, logoIdx, typeFlag);
}

function resetDictionaryDelta(runtime: WorkerRuntime): void {
  runtime.dictionaryDelta.titles = [];
  runtime.dictionaryDelta.groups = [];
  runtime.dictionaryDelta.urls = [];
  runtime.dictionaryDelta.logos = [];
}

function buildChunkMessage(runtime: WorkerRuntime, isFinal: boolean): {
  type: 'CHUNK';
  count: number;
  epgUrl: string | null;
  tupleWidth: number;
  tuples: Int32Array;
  dictionaries: WorkerCatalogDictionaries;
  isFinal: boolean;
} {
  const tupleCount = Math.floor(runtime.tupleBatch.length / TUPLE_WIDTH);
  if (tupleCount > 0) {
    runtime.totalLoaded += tupleCount;
  }

  return {
    type: 'CHUNK',
    count: runtime.totalLoaded,
    epgUrl: runtime.epgUrl,
    tupleWidth: TUPLE_WIDTH,
    tuples: Int32Array.from(runtime.tupleBatch),
    dictionaries: {
      titles: runtime.dictionaryDelta.titles,
      groups: runtime.dictionaryDelta.groups,
      urls: runtime.dictionaryDelta.urls,
      logos: runtime.dictionaryDelta.logos,
    },
    isFinal,
  };
}

function postChunk(runtime: WorkerRuntime, isFinal: boolean): void {
  const hasTupleData = runtime.tupleBatch.length > 0;
  const hasDictionaryDelta =
    runtime.dictionaryDelta.titles.length > 0
    || runtime.dictionaryDelta.groups.length > 0
    || runtime.dictionaryDelta.urls.length > 0
    || runtime.dictionaryDelta.logos.length > 0;

  if (!hasTupleData && !hasDictionaryDelta && !isFinal) {
    return;
  }

  const chunk = buildChunkMessage(runtime, isFinal);
  const transferList = chunk.tuples.byteLength > 0 ? [chunk.tuples.buffer] : [];
  postToMain(chunk, transferList);
  postToMain({ type: 'PROGRESS', count: runtime.totalLoaded, epgUrl: runtime.epgUrl });

  runtime.tupleBatch = [];
  resetDictionaryDelta(runtime);
}

function processLine(runtime: WorkerRuntime, rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;

  runtime.lineNumber += 1;

  if (!runtime.firstNonEmptySeen) {
    runtime.firstNonEmptySeen = true;
    runtime.epgUrl = extractEpgUrl(line);
  }

  if (line.toUpperCase().startsWith('#EXTINF')) {
    const { attributes, name } = extractExtinfPayload(line);
    runtime.currentItemAttributes = M3UParser.parseAttributes(attributes, name, runtime.lineNumber);
    return;
  }

  if (line.startsWith('http') && runtime.currentItemAttributes) {
    encodeChannelTuple(runtime, runtime.currentItemAttributes, line);
    runtime.currentItemAttributes = null;
  }
}

async function parseTextInChunks(text: string, runtime: WorkerRuntime): Promise<void> {
  let lineStart = 0;
  let processedSinceYield = 0;

  for (let index = 0; index < text.length; index += 1) {
    const charCode = text.charCodeAt(index);
    if (charCode !== 10 && charCode !== 13) continue;

    const line = text.slice(lineStart, index);
    if (charCode === 13 && text.charCodeAt(index + 1) === 10) index += 1;
    lineStart = index + 1;

    processLine(runtime, line);

    if ((runtime.tupleBatch.length / TUPLE_WIDTH) >= runtime.batchSize) {
      postChunk(runtime, false);
    }

    processedSinceYield += 1;
    if (processedSinceYield >= YIELD_EVERY_LINES) {
      processedSinceYield = 0;
      await waitTick();
    }
  }

  if (lineStart < text.length) {
    processLine(runtime, text.slice(lineStart));
  }
}

function resolveDecoder(contentTypeHeader: string | null): TextDecoder {
  const contentType = String(contentTypeHeader || '').toLowerCase();
  const latin1Hints = ['iso-8859-1', 'latin1', 'windows-1252', 'iso_8859-1'];
  const useLatin1 = latin1Hints.some((hint) => contentType.includes(hint));
  return new TextDecoder(useLatin1 ? 'windows-1252' : 'utf-8', { fatal: false });
}

async function parseStreamInChunks(response: Response, runtime: WorkerRuntime): Promise<void> {
  if (!response.body) {
    const fallbackText = await response.text();
    await parseTextInChunks(fallbackText, runtime);
    return;
  }

  const reader = response.body.getReader();
  const decoder = resolveDecoder(response.headers.get('content-type'));
  let textBuffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    textBuffer += decoder.decode(value, { stream: true });

    let lineStart = 0;
    let processedSinceYield = 0;

    for (let index = 0; index < textBuffer.length; index += 1) {
      const charCode = textBuffer.charCodeAt(index);
      if (charCode !== 10 && charCode !== 13) continue;

      const line = textBuffer.slice(lineStart, index);
      if (charCode === 13 && textBuffer.charCodeAt(index + 1) === 10) index += 1;
      lineStart = index + 1;

      processLine(runtime, line);

      if ((runtime.tupleBatch.length / TUPLE_WIDTH) >= runtime.batchSize) {
        postChunk(runtime, false);
      }

      processedSinceYield += 1;
      if (processedSinceYield >= YIELD_EVERY_LINES) {
        processedSinceYield = 0;
        await waitTick();
      }
    }

    textBuffer = textBuffer.slice(lineStart);
  }

  textBuffer += decoder.decode();
  if (textBuffer.trim()) {
    processLine(runtime, textBuffer);
  }
}

function createRuntime(batchSize: number): WorkerRuntime {
  return {
    tupleBatch: [],
    batchSize,
    totalLoaded: 0,
    currentItemAttributes: null,
    lineNumber: 0,
    epgUrl: null,
    firstNonEmptySeen: false,
    dictionaries: {
      titles: [],
      groups: [],
      urls: [],
      logos: [],
    },
    maps: {
      titles: new Map<string, number>(),
      groups: new Map<string, number>(),
      urls: new Map<string, number>(),
      logos: new Map<string, number>(),
    },
    dictionaryDelta: {
      titles: [],
      groups: [],
      urls: [],
      logos: [],
    },
  };
}

async function processWorkerTask(task: WorkerTask): Promise<void> {
  const playlistUrl = String(task.playlistUrl || '').trim();
  const m3uText = typeof task.m3uText === 'string' ? task.m3uText : '';
  const batchSize = Number.isFinite(task.batchSize)
    ? Math.max(200, Math.floor(task.batchSize as number))
    : DEFAULT_BATCH_SIZE;

  if (!playlistUrl && !m3uText.trim()) {
    throw new Error('A lista M3U esta vazia ou invalida.');
  }

  const runtime = createRuntime(batchSize);

  if (playlistUrl) {
    const response = await fetch(playlistUrl, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Falha ao baixar playlist: HTTP ${response.status}`);
    }
    await parseStreamInChunks(response, runtime);
  } else {
    await parseTextInChunks(m3uText, runtime);
  }

  postChunk(runtime, true);
  postToMain({ type: 'DONE', count: runtime.totalLoaded, epgUrl: runtime.epgUrl });
}

if (typeof self !== 'undefined') {
  self.onmessage = async (event: MessageEvent<WorkerTask>) => {
    try {
      await processWorkerTask(event.data);
    } catch (error: any) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido no worker M3U.';
      postToMain({ type: 'ERROR', message });
    }
  };
}
