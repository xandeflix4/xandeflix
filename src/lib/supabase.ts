import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';

function sanitizeEnvValue(value?: string): string {
  if (!value) {
    return '';
  }

  return value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^(VITE_SUPABASE_URL|SUPABASE_URL|NEXT_PUBLIC_SUPABASE_URL)=/i, '')
    .replace(/^(SUPABASE_SERVICE_ROLE_KEY|VITE_SUPABASE_ANON_KEY|SUPABASE_ANON_KEY)=/i, '');
}

export const supabaseUrl = sanitizeEnvValue(import.meta.env.VITE_SUPABASE_URL);
export const supabaseAnonKey = sanitizeEnvValue(import.meta.env.VITE_SUPABASE_ANON_KEY);
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  console.warn('[SUPABASE] Variaveis do cliente ausentes. Verifique o arquivo .env.');
}

function createBrowserSupabaseClient(): SupabaseClient<Database> {
  return createClient<Database>(
    supabaseUrl || 'https://placeholder.supabase.co',
    supabaseAnonKey || 'placeholder',
    {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
      },
    },
  );
}

export const supabase = createBrowserSupabaseClient();
