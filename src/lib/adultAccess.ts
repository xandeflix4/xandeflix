import { supabase, isSupabaseConfigured } from './supabase';

export type AdultAccessSettings = {
  enabled: boolean;
  totpEnabled: boolean;
};

type AdultAccessRpcRow = {
  enabled?: boolean;
  totp_enabled?: boolean;
};

function assertSupabaseConfigured() {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase nao configurado. Verifique VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.');
  }
}

function normalizeAdultAccessRow(value: AdultAccessRpcRow | null | undefined): AdultAccessSettings {
  return {
    enabled: Boolean(value?.enabled),
    totpEnabled: false,
  };
}

function formatAdultAccessError(error: any, fallback: string): string {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  const message = typeof error?.message === 'string' ? error.message.trim() : '';

  if (code === 'PGRST202') {
    return 'Execute o SQL da Fase 6 no Supabase antes de usar o controle adulto.';
  }

  return message || fallback;
}

export async function verifyAdultAccessPassword(password: string): Promise<AdultAccessSettings> {
  assertSupabaseConfigured();

  const { data, error } = await supabase.rpc('adult_access_unlock', {
    p_password: password,
  });

  if (error) {
    throw new Error(formatAdultAccessError(error, 'Nao foi possivel validar a senha adulta.'));
  }

  const row = Array.isArray(data) ? data[0] : data;
  return normalizeAdultAccessRow(row);
}

export async function saveAdultAccessPassword(input: {
  currentPassword?: string;
  newPassword: string;
}): Promise<AdultAccessSettings> {
  assertSupabaseConfigured();

  const { data, error } = await supabase.rpc('adult_access_set_password', {
    p_current_password: input.currentPassword?.trim() || null,
    p_new_password: input.newPassword.trim(),
  });

  if (error) {
    throw new Error(formatAdultAccessError(error, 'Nao foi possivel salvar a senha adulta.'));
  }

  const row = Array.isArray(data) ? data[0] : data;
  return normalizeAdultAccessRow(row);
}
