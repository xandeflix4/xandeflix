import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { AccessIdAuthRow, XandeflixUserRow } from '../types/supabase';

export interface SessionUserData {
  id: string;
  name: string;
  username: string;
  playlistUrl: string;
  epgUrl?: string | null;
  isBlocked: boolean;
  lastAccess?: string;
  adultAccess: {
    enabled: boolean;
    totpEnabled: boolean;
  };
}

export interface SessionSnapshot {
  accessToken: string;
  role: 'admin' | 'user';
  data?: SessionUserData;
}

const PROFILE_LOOKUP_RETRY_DELAYS_MS = [0, 120, 300] as const;
const AUTH_REQUEST_TIMEOUT_MS = 10_000;

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

function isEmailIdentifier(identifier: string): boolean {
  return identifier.includes('@');
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

function buildSyntheticLoginEmail(identifier: string): string {
  const normalized = normalizeIdentifier(identifier).replace(/[^a-z0-9._-]+/g, '-');
  return `${normalized || 'user'}@users.xandeflix.example.com`;
}

function isUsableSyntheticLoginEmail(candidate: string | null | undefined): boolean {
  if (!candidate) {
    return false;
  }

  const normalized = normalizeIdentifier(candidate);
  if (!normalized || normalized.endsWith('.local')) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function resolveAccessIdLoginEmail(candidate: string | null | undefined, accessId: string): string {
  if (isUsableSyntheticLoginEmail(candidate)) {
    return normalizeIdentifier(candidate as string);
  }

  return buildSyntheticLoginEmail(accessId);
}

function mapUserRowToSessionUserData(user: XandeflixUserRow): SessionUserData {
  const userWithEpg = user as XandeflixUserRow & { epg_url?: string | null };
  return {
    id: user.id,
    name: user.name,
    username: user.username || user.access_id || user.id,
    playlistUrl: user.playlist_url || '',
    epgUrl: userWithEpg.epg_url || null,
    isBlocked: user.is_blocked,
    lastAccess: user.last_access || undefined,
    adultAccess: {
      enabled: Boolean(user.adult_password),
      totpEnabled: false,
    },
  };
}

function normalizeAuthErrorMessage(message: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes('invalid login credentials')) {
    return 'ID de acesso, email ou senha invalidos.';
  }

  if (normalized.includes('email not confirmed')) {
    return 'O Supabase exige confirmacao de email. Desative o email confirmation para este fluxo.';
  }

  if (normalized.includes('user already registered')) {
    return 'A conta ja existe. Tente entrar novamente.';
  }

  if (normalized.includes('rate limit')) {
    return 'O Supabase bloqueou temporariamente novas tentativas de cadastro por email. Desative o email confirmation no projeto ou aguarde o cooldown.';
  }

  if (normalized.includes('email address') && normalized.includes('is invalid')) {
    return 'O email sintetico gerado para este ID de acesso foi rejeitado pelo Supabase. Reexecute o SQL da Fase 2 e atualize o app.';
  }

  return message;
}

function normalizeAccessIdRpcErrorMessage(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code).toUpperCase()
    : '';
  const rawMessage =
    typeof (error as { message?: unknown })?.message === 'string'
      ? String((error as { message: string }).message)
      : 'Falha ao validar o ID de acesso no Supabase.';
  const normalized = rawMessage.toLowerCase();

  if (
    code === 'PGRST202' ||
    normalized.includes('authenticate_access_id') && normalized.includes('could not find')
  ) {
    return 'A funcao authenticate_access_id nao foi encontrada no Supabase. Execute o SQL da Fase 2.';
  }

  if (code === '42883') {
    return 'A funcao authenticate_access_id existe com assinatura diferente. Reexecute o SQL da Fase 2.';
  }

  if (code === '42501') {
    return 'A funcao authenticate_access_id existe, mas o projeto atual nao tem permissao para executa-la.';
  }

  return `Falha ao validar o ID de acesso no Supabase: ${rawMessage}${code ? ` (${code})` : ''}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function fetchCurrentUserProfile(authUserId: string): Promise<XandeflixUserRow | null> {
  for (const waitMs of PROFILE_LOOKUP_RETRY_DELAYS_MS) {
    if (waitMs > 0) {
      await delay(waitMs);
    }

    const { data, error } = await withTimeout(
      supabase
        .from('xandeflix_users')
        .select('*')
        .eq('auth_user_id', authUserId)
        .maybeSingle(),
      AUTH_REQUEST_TIMEOUT_MS,
      'Tempo limite ao buscar o perfil do usuario no Supabase.',
    );

    if (error) {
      throw new Error('Nao foi possivel carregar o perfil do usuario no Supabase.');
    }

    if (data) {
      return data as XandeflixUserRow;
    }
  }

  return null;
}

async function buildSessionSnapshotFromSession(session: Session | null): Promise<SessionSnapshot> {
  const accessToken = session?.access_token;
  const authUserId = session?.user?.id;

  if (!accessToken || !authUserId) {
    throw new Error('Sessao do Supabase indisponivel apos o login.');
  }

  const profile = await fetchCurrentUserProfile(authUserId);
  if (!profile) {
    throw new Error('Perfil do usuario nao encontrado no Supabase.');
  }

  if (profile.is_blocked) {
    await supabase.auth.signOut();
    throw new Error('Este acesso esta bloqueado.');
  }

  return {
    accessToken,
    role: profile.role,
    data: profile.role === 'user' ? mapUserRowToSessionUserData(profile) : undefined,
  };
}

async function getAccessIdAuthRecord(
  identifier: string,
  password: string,
): Promise<AccessIdAuthRow | null> {
  const { data, error } = await withTimeout(
    supabase.rpc('authenticate_access_id', {
      p_identifier: normalizeIdentifier(identifier),
      p_password: password,
    }),
    AUTH_REQUEST_TIMEOUT_MS,
    'Tempo limite ao validar o ID de acesso no Supabase.',
  );

  if (error) {
    throw new Error(normalizeAccessIdRpcErrorMessage(error));
  }

  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
}

async function finishSessionFromSupabase(session: Session | null): Promise<SessionSnapshot> {
  return buildSessionSnapshotFromSession(session);
}

async function signInWithEmail(email: string, password: string): Promise<SessionSnapshot> {
  const { data, error } = await withTimeout(
    supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    }),
    AUTH_REQUEST_TIMEOUT_MS,
    'Tempo limite ao autenticar no Supabase. Verifique sua conexao e tente novamente.',
  );

  if (error) {
    throw new Error(normalizeAuthErrorMessage(error.message));
  }

  return finishSessionFromSupabase(data.session);
}

export async function authenticateWithSupabase(
  identifier: string,
  password: string,
): Promise<SessionSnapshot> {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const normalizedPassword = password.trim();

  if (!normalizedIdentifier) {
    throw new Error('Informe seu email ou ID de acesso.');
  }

  if (!normalizedPassword) {
    throw new Error('Informe sua senha.');
  }

  if (isEmailIdentifier(normalizedIdentifier)) {
    return signInWithEmail(normalizedIdentifier, normalizedPassword);
  }

  const authRecord = await getAccessIdAuthRecord(normalizedIdentifier, normalizedPassword);
  if (!authRecord) {
    throw new Error('ID de acesso ou senha invalidos.');
  }

  if (authRecord.is_blocked) {
    throw new Error('Este acesso esta bloqueado.');
  }

  const loginEmail = resolveAccessIdLoginEmail(authRecord.login_email, authRecord.access_id);

  if (authRecord.has_auth_user) {
    return signInWithEmail(loginEmail, normalizedPassword);
  }

  const signUpResponse = await withTimeout(
    supabase.auth.signUp({
      email: loginEmail,
      password: normalizedPassword,
      options: {
        data: {
          access_id: authRecord.access_id,
          username: authRecord.username || authRecord.access_id,
          name: authRecord.name,
          role: authRecord.role,
        },
      },
    }),
    Math.min(AUTH_REQUEST_TIMEOUT_MS, 45000),
    'Tempo limite ao criar a conta no Supabase. Tente novamente em instantes.',
  );

  if (signUpResponse.error) {
    const normalizedSignUpMessage = signUpResponse.error.message.toLowerCase();

    if (
      normalizedSignUpMessage.includes('already registered') ||
      normalizedSignUpMessage.includes('rate limit')
    ) {
      try {
        return await signInWithEmail(loginEmail, normalizedPassword);
      } catch {
        throw new Error(normalizeAuthErrorMessage(signUpResponse.error.message));
      }
    }

    throw new Error(normalizeAuthErrorMessage(signUpResponse.error.message));
  }

  if (signUpResponse.data.session) {
    return finishSessionFromSupabase(signUpResponse.data.session);
  }

  return signInWithEmail(loginEmail, normalizedPassword);
}

export async function getSessionSnapshot(): Promise<SessionSnapshot | null> {
  const { data, error } = await withTimeout(
    supabase.auth.getSession(),
    AUTH_REQUEST_TIMEOUT_MS,
    'Tempo limite ao validar a sessao atual no Supabase.',
  );
  if (error || !data.session) {
    return null;
  }

  try {
    return await buildSessionSnapshotFromSession(data.session);
  } catch {
    return null;
  }
}

export async function getServerSessionSnapshot(): Promise<SessionSnapshot | null> {
  return getSessionSnapshot();
}

export async function signOutSupabaseSession(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' });
    return;
  } catch {
    // noop
  }

  try {
    await supabase.auth.signOut();
  } catch {
    // noop
  }
}
