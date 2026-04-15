import { hashSync } from 'bcryptjs';
import { supabase, isSupabaseConfigured } from './supabase';
import { deletePlaylistCatalogSnapshotForUser } from './playlistCatalogSnapshot';
import type {
  Json,
  PlayerTelemetryReportRow,
  XandeflixUserRow,
  XandeflixUserInsert,
  XandeflixUserUpdate,
} from '../types/supabase';

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 14;
const DEFAULT_USER_PASSWORD = '123';
const MAX_TEXT_LENGTH = 160;
const ADMIN_REQUEST_TIMEOUT_MS = 20_000;

function withTimeout<T>(
  promiseLike: PromiseLike<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    Promise.resolve(promiseLike)
      .then((value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      });
  });
}

export type ManagedUser = {
  id: string;
  name: string;
  username: string;
  accessId: string;
  playlistUrl: string;
  isBlocked: boolean;
  role: 'admin' | 'user';
  lastAccess?: string;
  hiddenCategories: string[];
  categoryOverrides: Record<string, string>;
  mediaOverrides: Record<string, any>;
  adultAccess: {
    enabled: boolean;
    totpEnabled: boolean;
  };
};

export type EditableManagedUser = ManagedUser & {
  password?: string;
};

export type ManagedUserDraft = {
  name: string;
  username: string;
  password?: string;
  playlistUrl?: string;
};

export type AuthSyncSummary = {
  linkedCount: number;
  insertedCount: number;
};

export type PlayerTelemetryChannel = {
  key: string;
  mediaId: string;
  mediaTitle: string;
  mediaCategory: string;
  streamHost: string;
  sessions: number;
  sampledReports: number;
  watchSeconds: number;
  bufferSeconds: number;
  bufferEventCount: number;
  stallRecoveryCount: number;
  errorRecoveryCount: number;
  endedRecoveryCount: number;
  manualRetryCount: number;
  qualityFallbackCount: number;
  fatalErrorCount: number;
  problemScore: number;
};

export type PlayerTelemetrySummary = {
  enabled: boolean;
  windowHours: number;
  storage: 'supabase' | 'unavailable';
  setupRequired?: boolean;
  message?: string;
  overview: {
    reportCount: number;
    affectedChannels: number;
    sampledReports: number;
    watchSeconds: number;
    bufferSeconds: number;
    bufferEventCount: number;
    stallRecoveryCount: number;
    errorRecoveryCount: number;
    endedRecoveryCount: number;
    manualRetryCount: number;
    qualityFallbackCount: number;
    fatalErrorCount: number;
  };
  channels: PlayerTelemetryChannel[];
};

function assertSupabaseConfigured() {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase nao configurado. Verifique VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.');
  }
}

function sanitizeText(value: unknown, fallback = '', maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function clampNumber(value: unknown, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeStringRecord(value: Json): Record<string, string> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, String(entryValue)]),
  );
}

function normalizeGenericRecord(value: Json): Record<string, any> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return {};
  }

  return value as Record<string, any>;
}

function normalizeManagedUserName(value: string): string {
  return value.trim();
}

function normalizeManagedUserIdentifier(value: string): string {
  return value.trim();
}

function normalizeManagedUserPassword(value?: string | null): string | undefined {
  const normalized = (value || '').trim();
  return normalized || undefined;
}

function buildProblemScore(channel: PlayerTelemetryChannel): number {
  return (
    channel.fatalErrorCount * 8 +
    channel.stallRecoveryCount * 5 +
    channel.errorRecoveryCount * 4 +
    channel.endedRecoveryCount * 2 +
    channel.qualityFallbackCount * 2 +
    channel.manualRetryCount * 2 +
    channel.bufferEventCount * 0.3 +
    channel.bufferSeconds / 30
  );
}

function isTelemetryTableMissing(error: any): boolean {
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const details = typeof error?.details === 'string' ? error.details.toLowerCase() : '';
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';

  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    (message.includes('player_telemetry_reports') && message.includes('schema cache')) ||
    (details.includes('player_telemetry_reports') && details.includes('schema cache'))
  );
}

function formatSupabaseError(error: any, fallback: string): string {
  const message = sanitizeText(error?.message, fallback, 240);
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';

  if (code === '23505') {
    if (message.toLowerCase().includes('username') || message.toLowerCase().includes('access_id')) {
      return 'Ja existe um usuario com esse ID de acesso.';
    }
    if (message.toLowerCase().includes('email')) {
      return 'Ja existe um usuario com esse email.';
    }
  }

  if (code === '42501') {
    return 'A conta atual nao possui permissao de administrador no Supabase.';
  }

  return message || fallback;
}

export function normalizeTitleForMatching(title: string): string {
  if (!title) return '';

  let normalized = title.trim().toUpperCase();
  const qualityTags = [
    /\bFHD\b/g,
    /\bHD\b/g,
    /\bSD\b/g,
    /\b4K\b/g,
    /\bUHD\b/g,
    /\bL\b/g,
    /\bULTRA HD\b/g,
    /\bH265\b/g,
    /\bH264\b/g,
    /\bHEVC\b/g,
    /\b\d{3,4}P\b/g,
  ];

  qualityTags.forEach((tag) => {
    normalized = normalized.replace(tag, '');
  });

  const extraTags = [/\[.*?\]/g, /\(.*?\)|\{.*?\}/g, /\|/g, /:/g, /-/g];
  extraTags.forEach((tag) => {
    normalized = normalized.replace(tag, '');
  });

  return normalized.replace(/\s\s+/g, ' ').trim().toLowerCase();
}

function toManagedUser(row: XandeflixUserRow): ManagedUser {
  return {
    id: row.id,
    name: row.name,
    username: row.username || row.access_id || row.id,
    accessId: row.access_id || row.username || row.id,
    playlistUrl: row.playlist_url || '',
    isBlocked: row.is_blocked,
    role: row.role,
    lastAccess: row.last_access || undefined,
    hiddenCategories: row.hidden_categories || [],
    categoryOverrides: normalizeStringRecord(row.category_overrides),
    mediaOverrides: normalizeGenericRecord(row.media_overrides),
    adultAccess: {
      enabled: Boolean(row.adult_password),
      totpEnabled: false,
    },
  };
}

async function runSingleUserUpdate(
  userId: string,
  payload: XandeflixUserUpdate,
  fallbackMessage: string,
): Promise<ManagedUser> {
  assertSupabaseConfigured();

  const { data, error } = await withTimeout(
    supabase
      .from('xandeflix_users')
      .update(payload)
      .eq('id', userId)
      .select('*')
      .maybeSingle(),
    ADMIN_REQUEST_TIMEOUT_MS,
    'Tempo limite ao atualizar usuario no painel admin.',
  );

  if (error) {
    throw new Error(formatSupabaseError(error, fallbackMessage));
  }

  if (!data) {
    throw new Error('Usuario nao encontrado.');
  }

  return toManagedUser(data as XandeflixUserRow);
}

export async function listManagedUsers(): Promise<ManagedUser[]> {
  assertSupabaseConfigured();
  await syncManagedUsersFromAuth();

  const { data, error } = await withTimeout(
    supabase
      .from('xandeflix_users')
      .select('*')
      .order('created_at', { ascending: false }),
    ADMIN_REQUEST_TIMEOUT_MS,
    'Tempo limite ao carregar usuarios no painel admin.',
  );

  if (error) {
    throw new Error(formatSupabaseError(error, 'Nao foi possivel carregar os usuarios.'));
  }

  return (data || []).map((row) => toManagedUser(row as XandeflixUserRow));
}

export async function syncManagedUsersFromAuth(): Promise<AuthSyncSummary> {
  assertSupabaseConfigured();

  const { data, error } = await withTimeout(
    supabase.rpc('sync_auth_users_to_xandeflix_users', {}),
    ADMIN_REQUEST_TIMEOUT_MS,
    'Tempo limite ao sincronizar usuarios do Authentication com o painel admin.',
  );

  if (error) {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    const normalizedMessage =
      typeof error?.message === 'string' ? error.message.toLowerCase() : '';

    if (
      code === 'PGRST202' ||
      code === '42883' ||
      normalizedMessage.includes('sync_auth_users_to_xandeflix_users')
    ) {
      throw new Error(
        'A funcao sync_auth_users_to_xandeflix_users nao existe no banco. Execute o SQL supabase_phase3_auth_sync.sql.',
      );
    }

    throw new Error(
      formatSupabaseError(
        error,
        'Nao foi possivel sincronizar usuarios do Authentication com o painel admin.',
      ),
    );
  }

  const row = Array.isArray(data) && data[0] ? data[0] : null;
  return {
    linkedCount: Number((row as any)?.linked_count || 0),
    insertedCount: Number((row as any)?.inserted_count || 0),
  };
}
/**
 * Ativa um novo usuario no sistema Xandeflix via Supabase Auth.
 * Isso cria uma conta de autenticacao real e vincula o perfil do catalogo.
 */
export async function activateNewSubscriber(
  email: string,
  password?: string,
  playlistUrl?: string,
  name?: string
): Promise<ManagedUser> {
  assertSupabaseConfigured();

  const rawPassword = password || DEFAULT_USER_PASSWORD;
  const username = email.split('@')[0];

  // 1. Criar Usuario no Auth
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password: rawPassword,
    options: {
      data: {
        name: name || username,
        username: username,
        access_id: username,
        role: 'user'
      }
    }
  });

  if (authError) {
    throw new Error(formatSupabaseError(authError, 'Falha ao criar credenciais de acesso.'));
  }

  if (!authData.user) {
    throw new Error('Falha ao gerar usuario no Supabase Auth.');
  }

  // 2. Aguarda a sincronizacao automatica do trigger e atualiza o perfil
  // Nota: O trigger handle_new_auth_user ja criou a entrada na public.xandeflix_users.
  // Vamos buscar por email para garantir que estamos editando o perfil correto.
  
  const { data: profileData, error: profileError } = await supabase
    .from('xandeflix_users')
    .update({ 
      playlist_url: (playlistUrl || '').trim(),
      updated_at: new Date().toISOString()
    })
    .eq('auth_user_id', authData.user.id)
    .select('*')
    .maybeSingle();

  if (profileError) {
    throw new Error(formatSupabaseError(profileError, 'Usuario criado, mas falhou ao vincular playlist.'));
  }

  if (!profileData) {
    throw new Error('Perfil do usuario nao encontrado apos sincronizacao Auth.');
  }

  return toManagedUser(profileData as XandeflixUserRow);
}

export async function createManagedUser(input: ManagedUserDraft): Promise<ManagedUser> {
  assertSupabaseConfigured();

  const name = normalizeManagedUserName(input.name);
  const username = normalizeManagedUserIdentifier(input.username);
  const playlistUrl = (input.playlistUrl || '').trim();
  const rawPassword = normalizeManagedUserPassword(input.password) || DEFAULT_USER_PASSWORD;

  if (!name) {
    throw new Error('Informe o nome do cliente.');
  }

  if (!username) {
    throw new Error('Informe o ID de acesso.');
  }

  const payload: XandeflixUserInsert = {
    name,
    username,
    access_id: username,
    password: hashSync(rawPassword, 10),
    playlist_url: playlistUrl,
    is_blocked: false,
    role: 'user',
  };

  const { data, error } = await withTimeout(
    supabase
      .from('xandeflix_users')
      .insert(payload)
      .select('*')
      .maybeSingle(),
    ADMIN_REQUEST_TIMEOUT_MS,
    'Tempo limite ao criar usuario no painel admin.',
  );

  if (error) {
    throw new Error(formatSupabaseError(error, 'Nao foi possivel criar o usuario.'));
  }

  if (!data) {
    throw new Error('Nao foi possivel criar o usuario.');
  }

  return toManagedUser(data as XandeflixUserRow);
}

export async function updateManagedUser(
  userId: string,
  input: Partial<Pick<EditableManagedUser, 'name' | 'username' | 'playlistUrl' | 'password'>>,
): Promise<ManagedUser> {
  const payload: XandeflixUserUpdate = {};

  if (input.name !== undefined) {
    const name = normalizeManagedUserName(input.name);
    if (!name) {
      throw new Error('Informe o nome do cliente.');
    }
    payload.name = name;
  }

  if (input.username !== undefined) {
    const username = normalizeManagedUserIdentifier(input.username);
    if (!username) {
      throw new Error('Informe o ID de acesso.');
    }
    payload.username = username;
    payload.access_id = username;
  }

  if (input.playlistUrl !== undefined) {
    payload.playlist_url = input.playlistUrl.trim();
  }

  if (input.password !== undefined) {
    const password = normalizeManagedUserPassword(input.password);
    if (password) {
      payload.password = hashSync(password, 10);
    }
  }

  const updatedUser = await runSingleUserUpdate(
    userId,
    payload,
    'Nao foi possivel salvar as alteracoes.',
  );

  if (input.playlistUrl !== undefined) {
    try {
      await deletePlaylistCatalogSnapshotForUser(userId);
    } catch (error) {
      console.warn('[Admin] Falha ao invalidar snapshot antigo da playlist:', error);
    }
  }

  return updatedUser;
}

export async function setManagedUserBlocked(
  userId: string,
  blocked: boolean,
): Promise<ManagedUser> {
  return runSingleUserUpdate(
    userId,
    { is_blocked: blocked },
    'Nao foi possivel atualizar o status do usuario.',
  );
}

export async function deleteManagedUser(userId: string): Promise<void> {
  assertSupabaseConfigured();

  const { data, error } = await withTimeout(
    supabase
      .from('xandeflix_users')
      .delete()
      .eq('id', userId)
      .select('id')
      .maybeSingle(),
    ADMIN_REQUEST_TIMEOUT_MS,
    'Tempo limite ao remover usuario no painel admin.',
  );

  if (error) {
    throw new Error(formatSupabaseError(error, 'Nao foi possivel remover o usuario.'));
  }

  if (!data) {
    throw new Error('Usuario nao encontrado.');
  }
}

export async function saveManagedUserCatalogFilters(
  userId: string,
  input: {
    hiddenCategories: string[];
    categoryOverrides: Record<string, string>;
    mediaOverrides: Record<string, any>;
  },
): Promise<ManagedUser> {
  return runSingleUserUpdate(
    userId,
    {
      hidden_categories: input.hiddenCategories,
      category_overrides: input.categoryOverrides,
      media_overrides: input.mediaOverrides,
    },
    'Nao foi possivel salvar os filtros remotos.',
  );
}

export async function upsertGlobalMediaOverride(
  itemTitle: string,
  override: Record<string, any>,
): Promise<void> {
  assertSupabaseConfigured();

  const normalizedTitle = normalizeTitleForMatching(itemTitle);
  if (!normalizedTitle) {
    throw new Error('Informe um titulo valido para o override global.');
  }

  const { error } = await withTimeout(
    supabase
      .from('global_media_overrides')
      .upsert(
        {
          title_match: normalizedTitle,
          override_data: override,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'title_match' },
      ),
    ADMIN_REQUEST_TIMEOUT_MS,
    'Tempo limite ao salvar override global no painel admin.',
  );

  if (error) {
    throw new Error(formatSupabaseError(error, 'Nao foi possivel salvar o override global.'));
  }
}

export async function getPlayerTelemetrySummary(
  windowHours = DEFAULT_WINDOW_HOURS,
): Promise<PlayerTelemetrySummary> {
  const safeWindowHours = Math.round(clampNumber(windowHours, 1, MAX_WINDOW_HOURS));
  const overview = {
    reportCount: 0,
    affectedChannels: 0,
    sampledReports: 0,
    watchSeconds: 0,
    bufferSeconds: 0,
    bufferEventCount: 0,
    stallRecoveryCount: 0,
    errorRecoveryCount: 0,
    endedRecoveryCount: 0,
    manualRetryCount: 0,
    qualityFallbackCount: 0,
    fatalErrorCount: 0,
  };

  if (!isSupabaseConfigured) {
    return {
      enabled: true,
      windowHours: safeWindowHours,
      storage: 'unavailable',
      overview,
      channels: [],
      message: 'Supabase indisponivel para leitura da telemetria.',
    };
  }

  const since = new Date(Date.now() - safeWindowHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await withTimeout(
    supabase
      .from('player_telemetry_reports')
      .select(
        'media_id, media_title, media_category, stream_host, watch_seconds, buffer_seconds, buffer_event_count, stall_recovery_count, error_recovery_count, ended_recovery_count, manual_retry_count, quality_fallback_count, fatal_error_count, sampled',
      )
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000),
    ADMIN_REQUEST_TIMEOUT_MS,
    'Tempo limite ao carregar telemetria no painel admin.',
  );

  if (error) {
    if (isTelemetryTableMissing(error)) {
      return {
        enabled: true,
        windowHours: safeWindowHours,
        storage: 'unavailable',
        overview,
        channels: [],
        setupRequired: true,
        message: 'A tabela player_telemetry_reports ainda nao existe no Supabase. Execute o SQL de setup para habilitar a telemetria.',
      };
    }

    throw new Error(formatSupabaseError(error, 'Nao foi possivel carregar a telemetria do player.'));
  }

  const channels = new Map<string, PlayerTelemetryChannel>();

  for (const row of (data || []) as Pick<
    PlayerTelemetryReportRow,
    | 'media_id'
    | 'media_title'
    | 'media_category'
    | 'stream_host'
    | 'watch_seconds'
    | 'buffer_seconds'
    | 'buffer_event_count'
    | 'stall_recovery_count'
    | 'error_recovery_count'
    | 'ended_recovery_count'
    | 'manual_retry_count'
    | 'quality_fallback_count'
    | 'fatal_error_count'
    | 'sampled'
  >[]) {
    const key = sanitizeText(row.media_id, sanitizeText(row.media_title, 'canal-desconhecido'));
    const current = channels.get(key) || {
      key,
      mediaId: sanitizeText(row.media_id, ''),
      mediaTitle: sanitizeText(row.media_title, 'Canal desconhecido'),
      mediaCategory: sanitizeText(row.media_category, ''),
      streamHost: sanitizeText(row.stream_host, ''),
      sessions: 0,
      sampledReports: 0,
      watchSeconds: 0,
      bufferSeconds: 0,
      bufferEventCount: 0,
      stallRecoveryCount: 0,
      errorRecoveryCount: 0,
      endedRecoveryCount: 0,
      manualRetryCount: 0,
      qualityFallbackCount: 0,
      fatalErrorCount: 0,
      problemScore: 0,
    };

    current.sessions += 1;
    current.sampledReports += row.sampled ? 1 : 0;
    current.watchSeconds += clampNumber(row.watch_seconds, 0, 24 * 60 * 60);
    current.bufferSeconds += clampNumber(row.buffer_seconds, 0, 24 * 60 * 60);
    current.bufferEventCount += clampNumber(row.buffer_event_count, 0, 1000);
    current.stallRecoveryCount += clampNumber(row.stall_recovery_count, 0, 100);
    current.errorRecoveryCount += clampNumber(row.error_recovery_count, 0, 100);
    current.endedRecoveryCount += clampNumber(row.ended_recovery_count, 0, 100);
    current.manualRetryCount += clampNumber(row.manual_retry_count, 0, 100);
    current.qualityFallbackCount += clampNumber(row.quality_fallback_count, 0, 100);
    current.fatalErrorCount += clampNumber(row.fatal_error_count, 0, 100);
    current.problemScore = buildProblemScore(current);

    overview.reportCount += 1;
    overview.sampledReports += row.sampled ? 1 : 0;
    overview.watchSeconds += clampNumber(row.watch_seconds, 0, 24 * 60 * 60);
    overview.bufferSeconds += clampNumber(row.buffer_seconds, 0, 24 * 60 * 60);
    overview.bufferEventCount += clampNumber(row.buffer_event_count, 0, 1000);
    overview.stallRecoveryCount += clampNumber(row.stall_recovery_count, 0, 100);
    overview.errorRecoveryCount += clampNumber(row.error_recovery_count, 0, 100);
    overview.endedRecoveryCount += clampNumber(row.ended_recovery_count, 0, 100);
    overview.manualRetryCount += clampNumber(row.manual_retry_count, 0, 100);
    overview.qualityFallbackCount += clampNumber(row.quality_fallback_count, 0, 100);
    overview.fatalErrorCount += clampNumber(row.fatal_error_count, 0, 100);

    channels.set(key, current);
  }

  const channelList = Array.from(channels.values())
    .sort((left, right) => right.problemScore - left.problemScore)
    .slice(0, 12);

  overview.affectedChannels = channels.size;

  return {
    enabled: true,
    windowHours: safeWindowHours,
    storage: 'supabase',
    overview,
    channels: channelList,
  };
}
