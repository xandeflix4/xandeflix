import { cleanMediaTitle } from './titleCleaner';

export type TMDBMediaType = 'movie' | 'series';

export interface TMDBData {
  description: string;
  thumbnail: string | null;
  backdrop: string | null;
  year: number;
  rating: string;
  voteAverage?: number;
  voteCount?: number;
  popularity?: number;
  genres?: string[];
  trailerKey?: string | null;
  matchScore?: number;
  matchedTitle?: string;
}

export interface FetchTMDBMetadataOptions {
  includeDetails?: boolean;
}

export interface TMDBSearchResult {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
}

const rawTmdbApiKey = String(import.meta.env.VITE_TMDB_API_KEY || '').trim();
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const DEFAULT_TIMEOUT_MS = 8500;
const MIN_CONFIDENT_MATCH_SCORE = 0.78;
const MIN_ARTWORK_MATCH_SCORE = 0.82;
const MIN_TRAILER_MATCH_SCORE = 0.86;
const TMDB_MAX_CONCURRENT_REQUESTS = 2;
const TMDB_MIN_REQUEST_INTERVAL_MS = 180;
const TMDB_RETRY_ATTEMPTS = 2;
const TMDB_RETRY_BASE_DELAY_MS = 420;

let activeTMDBRequests = 0;
let lastTMDBRequestAt = 0;
let tmdbQueueDrainTimer: ReturnType<typeof setTimeout> | null = null;
const pendingTMDBQueue: Array<() => void> = [];

function getTMDBApiKey(): string {
  return rawTmdbApiKey;
}

export function isTMDBConfigured(): boolean {
  return Boolean(getTMDBApiKey());
}

function buildTMDBEndpoint(type: TMDBMediaType): string {
  return type === 'movie' ? 'movie' : 'tv';
}

function buildSearchUrl(query: string, type: TMDBMediaType, year?: string): string {
  const url = new URL(`${TMDB_API_BASE}/search/${buildTMDBEndpoint(type)}`);
  url.searchParams.set('api_key', getTMDBApiKey());
  url.searchParams.set('query', query);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('include_adult', 'false');

  if (year) {
    url.searchParams.set(type === 'movie' ? 'year' : 'first_air_date_year', year);
  }

  return url.toString();
}

function scheduleTMDBQueueDrain(delayMs = 0): void {
  if (tmdbQueueDrainTimer != null) {
    return;
  }

  tmdbQueueDrainTimer = globalThis.setTimeout(() => {
    tmdbQueueDrainTimer = null;
    drainTMDBQueue();
  }, delayMs);
}

function drainTMDBQueue(): void {
  while (activeTMDBRequests < TMDB_MAX_CONCURRENT_REQUESTS && pendingTMDBQueue.length > 0) {
    const now = Date.now();
    const elapsed = now - lastTMDBRequestAt;
    if (elapsed < TMDB_MIN_REQUEST_INTERVAL_MS) {
      scheduleTMDBQueueDrain(TMDB_MIN_REQUEST_INTERVAL_MS - elapsed);
      return;
    }

    const next = pendingTMDBQueue.shift();
    if (!next) {
      return;
    }

    activeTMDBRequests += 1;
    lastTMDBRequestAt = now;
    next();
  }
}

async function enqueueTMDBRequest<T>(request: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      request()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeTMDBRequests = Math.max(0, activeTMDBRequests - 1);
          drainTMDBQueue();
        });
    };

    pendingTMDBQueue.push(run);
    drainTMDBQueue();
  });
}

function shouldRetryTMDBRequest(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'NetworkError';
  }

  if (error instanceof TypeError) {
    return true;
  }

  if (error instanceof Error) {
    if (/TMDB HTTP 429/i.test(error.message)) return true;
    if (/TMDB HTTP 5\d\d/i.test(error.message)) return true;
  }

  return false;
}

function getTMDBRetryDelay(attempt: number): number {
  const jitter = Math.floor(Math.random() * 140);
  return TMDB_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + jitter;
}

function formatTMDBError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function formatTMDBRequestTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function fetchTMDBJson<T>(url: string): Promise<T> {
  if (!isTMDBConfigured()) {
    throw new Error('TMDB nao configurado. Defina VITE_TMDB_API_KEY no .env.');
  }

  const requestTarget = formatTMDBRequestTarget(url);
  let attempt = 0;
  while (attempt <= TMDB_RETRY_ATTEMPTS) {
    try {
      return await enqueueTMDBRequest(async () => {
        const controller = new AbortController();
        const timeoutId = globalThis.setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`TMDB HTTP ${response.status}`);
          }

          return response.json() as Promise<T>;
        } finally {
          globalThis.clearTimeout(timeoutId);
        }
      });
    } catch (error) {
      const errorLabel = formatTMDBError(error);
      const canRetry = attempt < TMDB_RETRY_ATTEMPTS && shouldRetryTMDBRequest(error);
      if (!canRetry) {
        console.warn(`[TMDB] Requisicao falhou para ${requestTarget}: ${errorLabel}`);
        throw error;
      }

      console.warn(
        `[TMDB] Tentativa ${attempt + 1} falhou para ${requestTarget}: ${errorLabel}. Repetindo...`,
      );
      await wait(getTMDBRetryDelay(attempt));
      attempt += 1;
    }
  }

  throw new Error('TMDB request failed unexpectedly.');
}

function mapTMDBSearchResult(result: any): TMDBSearchResult {
  return {
    id: Number(result?.id || 0),
    title: String(result?.title || result?.name || ''),
    overview: String(result?.overview || ''),
    poster_path: typeof result?.poster_path === 'string' ? result.poster_path : null,
    backdrop_path: typeof result?.backdrop_path === 'string' ? result.backdrop_path : null,
    release_date: typeof result?.release_date === 'string' ? result.release_date : undefined,
    first_air_date:
      typeof result?.first_air_date === 'string' ? result.first_air_date : undefined,
    vote_average:
      typeof result?.vote_average === 'number' ? result.vote_average : Number(result?.vote_average || 0),
    vote_count:
      typeof result?.vote_count === 'number' ? result.vote_count : Number(result?.vote_count || 0),
    popularity:
      typeof result?.popularity === 'number' ? result.popularity : Number(result?.popularity || 0),
  };
}

function normalizeForComparison(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getReleaseYear(result: TMDBSearchResult): string {
  return String(result.release_date || result.first_air_date || '').slice(0, 4);
}

function scoreTMDBMatch(queryTitle: string, queryYear: string | undefined, candidate: TMDBSearchResult): number {
  const query = normalizeForComparison(queryTitle);
  const candidateTitle = normalizeForComparison(candidate.title || '');
  if (!query || !candidateTitle) return 0;

  if (query === candidateTitle) {
    return queryYear && getReleaseYear(candidate) === queryYear ? 1 : 0.92;
  }

  const queryTokens = query.split(' ').filter((token) => token.length > 1);
  const candidateTokens = candidateTitle.split(' ').filter((token) => token.length > 1);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  const querySet = new Set(queryTokens);
  const candidateSet = new Set(candidateTokens);
  let intersection = 0;
  querySet.forEach((token) => {
    if (candidateSet.has(token)) intersection += 1;
  });

  const overlap = intersection / querySet.size;
  const containsBoost =
    query.includes(candidateTitle) || candidateTitle.includes(query) ? 0.15 : 0;

  const yearBoost =
    queryYear && getReleaseYear(candidate) === queryYear
      ? 0.18
      : 0;

  let score = overlap + containsBoost + yearBoost;

  // Short titles need stronger token parity to avoid wrong matches.
  if (queryTokens.length <= 2 && intersection < queryTokens.length) {
    score *= 0.72;
  }

  if (Math.abs(candidateTokens.length - queryTokens.length) >= 4) {
    score -= 0.08;
  }

  return Math.min(Math.max(score, 0), 1);
}

interface TMDBBestMatch {
  result: TMDBSearchResult;
  score: number;
}

function pickBestTMDBResult(
  results: TMDBSearchResult[],
  queryTitle: string,
  queryYear?: string,
): TMDBBestMatch | null {
  if (!results.length) return null;

  let best: TMDBSearchResult | null = null;
  let bestScore = 0;

  for (const result of results.slice(0, 8)) {
    const score = scoreTMDBMatch(queryTitle, queryYear, result);
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }

  if (!best || bestScore < MIN_CONFIDENT_MATCH_SCORE) {
    return null;
  }

  return {
    result: best,
    score: bestScore,
  };
}

function buildPosterUrl(path: string | null, size: 'w500' | 'w1280' | 'original'): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

export async function searchTMDB(query: string, type: TMDBMediaType): Promise<TMDBSearchResult[]> {
  const cleanedQuery = query.trim();
  if (!cleanedQuery) {
    return [];
  }

  const payload = await fetchTMDBJson<{ results?: any[] }>(buildSearchUrl(cleanedQuery, type));
  return Array.isArray(payload.results) ? payload.results.map(mapTMDBSearchResult) : [];
}

async function searchBestTMDBResult(
  queryTitle: string,
  type: TMDBMediaType,
  queryYear?: string,
): Promise<TMDBBestMatch | null> {
  const payload = await fetchTMDBJson<{ results?: any[] }>(
    buildSearchUrl(queryTitle, type, queryYear),
  );
  const mappedResults = Array.isArray(payload.results)
    ? payload.results.map(mapTMDBSearchResult)
    : [];

  return pickBestTMDBResult(mappedResults, queryTitle, queryYear);
}

export async function fetchTMDBMetadata(
  rawTitle: string,
  type: TMDBMediaType,
  options: FetchTMDBMetadataOptions = {},
): Promise<TMDBData | null> {
  const { includeDetails = true } = options;
  if (!rawTitle.trim()) {
    return null;
  }

  const { cleanTitle, year } = cleanMediaTitle(rawTitle);
  const normalizedTitle = cleanTitle.trim();
  if (!normalizedTitle) {
    return null;
  }

  let bestMatch = await searchBestTMDBResult(normalizedTitle, type, year);
  if (!bestMatch && year) {
    // Fallback when IPTV titles carry an incorrect year token.
    bestMatch = await searchBestTMDBResult(normalizedTitle, type);
  }

  if (!bestMatch) {
    return null;
  }

  const mapped = bestMatch.result;
  const matchScore = bestMatch.score;
  const canUseArtwork = matchScore >= MIN_ARTWORK_MATCH_SCORE;
  const canUseTrailer = matchScore >= MIN_TRAILER_MATCH_SCORE;
  const releaseYear = Number(
    String(mapped.release_date || mapped.first_air_date || '0').slice(0, 4),
  );

  let trailerKey: string | null = null;
  let genres: string[] = [];
  if (includeDetails) {
    try {
      const detailsUrl = new URL(`${TMDB_API_BASE}/${buildTMDBEndpoint(type)}/${mapped.id}`);
      detailsUrl.searchParams.set('api_key', getTMDBApiKey());
      detailsUrl.searchParams.set('language', 'pt-BR');
      detailsUrl.searchParams.set('append_to_response', 'videos');
      detailsUrl.searchParams.set('include_video_language', 'pt-BR,pt,en-US,en,null');

      const detailsPayload = await fetchTMDBJson<{
        genres?: Array<{ name?: string }>;
        videos?: { results?: any[] };
      }>(detailsUrl.toString());
      const videoResults = Array.isArray(detailsPayload.videos?.results)
        ? detailsPayload.videos?.results
        : [];
      genres = Array.isArray(detailsPayload.genres)
        ? detailsPayload.genres
            .map((genre) => String(genre?.name || '').trim())
            .filter((genre) => genre.length > 0)
            .slice(0, 3)
        : [];

      let trailer = videoResults.find((v) => v.type === 'Trailer' && v.site === 'YouTube' && (v.iso_639_1 === 'pt' || v.iso_639_1 === 'pt-BR'));
      if (!trailer) trailer = videoResults.find((v) => v.type === 'Trailer' && v.site === 'YouTube' && (v.iso_639_1 === 'en' || v.iso_639_1 === 'en-US'));
      if (!trailer) trailer = videoResults.find((v) => v.type === 'Trailer' && v.site === 'YouTube');
      if (!trailer) trailer = videoResults.find((v) => v.site === 'YouTube');

      if (canUseTrailer && trailer?.key) {
        trailerKey = trailer.key;
      }
    } catch (err) {
      console.warn(
        `[TMDB] Falha ao pre-carregar trailer para: ${mapped.title} - ${formatTMDBError(err)}`,
      );
    }
  }

  return {
    description: mapped.overview || 'Sinopse nao disponivel.',
    // Use null instead of empty strings to simplify UI fallback logic.
    thumbnail: canUseArtwork && mapped.poster_path ? buildPosterUrl(mapped.poster_path, 'w500') : null,
    backdrop: canUseArtwork && mapped.backdrop_path ? buildPosterUrl(mapped.backdrop_path, 'w1280') : null,
    year: Number.isFinite(releaseYear) && releaseYear > 0 ? releaseYear : 0,
    rating: mapped.vote_average ? mapped.vote_average.toFixed(1) : '0.0',
    voteAverage: Number.isFinite(mapped.vote_average as number) ? Number(mapped.vote_average) : 0,
    voteCount: Number.isFinite(mapped.vote_count as number) ? Number(mapped.vote_count) : 0,
    popularity: Number.isFinite(mapped.popularity as number) ? Number(mapped.popularity) : 0,
    genres,
    trailerKey,
    matchScore,
    matchedTitle: mapped.title,
  };
}
