-- Xandeflix - Fase 2: Escalabilidade e Segurança
-- Este script expande a estrutura base com tabelas dedicadas para histórico e favoritos,
-- implementa RLS rigoroso e índices de alta performance.

begin;

-- -----------------------------------------------------------------------------
-- 1. Tabela Dedicada de Histórico de Visualização (Watch History)
-- -----------------------------------------------------------------------------
-- Substitui o campo JSONB em user_preferences para maior escalabilidade.

create table if not exists public.watch_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.xandeflix_users (id) on delete cascade,
  media_id text not null,
  media_title text not null,
  media_type text not null default 'live',
  last_position integer not null default 0,
  duration integer not null default 0,
  tmdb_id integer,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Índices para Histórico
create index if not exists idx_watch_history_user_id on public.watch_history (user_id);
create unique index if not exists idx_watch_history_user_media on public.watch_history (user_id, media_id);
create index if not exists idx_watch_history_updated_at on public.watch_history (updated_at desc);

-- Trigger para updated_at
drop trigger if exists trg_watch_history_updated_at on public.watch_history;
create trigger trg_watch_history_updated_at
before update on public.watch_history
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Tabela de Favoritos
-- -----------------------------------------------------------------------------

create table if not exists public.favorites (
  user_id uuid not null references public.xandeflix_users (id) on delete cascade,
  media_id text not null,
  media_type text not null default 'live',
  media_title text not null,
  tmdb_id integer,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, media_id)
);

-- Índices para Favoritos
create index if not exists idx_favorites_user_id on public.favorites (user_id);

-- -----------------------------------------------------------------------------
-- 3. Refinamento de Tabelas Existentes
-- -----------------------------------------------------------------------------

-- Garantir chaves estrangeiras e índices em playlist_catalog_snapshots
create index if not exists idx_playlist_snapshots_user_id_url on public.playlist_catalog_snapshots (user_id, playlist_url);

-- -----------------------------------------------------------------------------
-- 4. Row Level Security (RLS) RIGOROSO
-- -----------------------------------------------------------------------------

-- Habilitar RLS nas novas tabelas
alter table public.watch_history enable row level security;
alter table public.favorites enable row level security;

-- Políticas para watch_history
drop policy if exists "users_manage_own_watch_history" on public.watch_history;
create policy "users_manage_own_watch_history"
on public.watch_history
for all
to authenticated
using (user_id = public.current_xandeflix_user_id())
with check (user_id = public.current_xandeflix_user_id());

drop policy if exists "admins_read_all_watch_history" on public.watch_history;
create policy "admins_read_all_watch_history"
on public.watch_history
for select
to authenticated
using (public.is_xandeflix_admin());

-- Políticas para favorites
drop policy if exists "users_manage_own_favorites" on public.favorites;
create policy "users_manage_own_favorites"
on public.favorites
for all
to authenticated
using (user_id = public.current_xandeflix_user_id())
with check (user_id = public.current_xandeflix_user_id());

drop policy if exists "admins_read_all_favorites" on public.favorites;
create policy "admins_read_all_favorites"
on public.favorites
for select
to authenticated
using (public.is_xandeflix_admin());

-- Reforço de RLS nas tabelas anteriores (Garantindo políticas granuladas)

-- playlist_catalog_snapshots: Garante que o usuário só salve snapshots se o user_id for dele
drop policy if exists "users_manage_own_playlist_snapshot" on public.playlist_catalog_snapshots;
create policy "users_manage_own_playlist_snapshot"
on public.playlist_catalog_snapshots
for all
to authenticated
using (user_id = public.current_xandeflix_user_id())
with check (user_id = public.current_xandeflix_user_id());

-- xandeflix_users: bloqueia UPDATE direto por usuarios comuns.
-- Qualquer alteracao de perfil sensivel deve passar por RPC/funcoes controladas
-- ou pela policy administrativa.
drop policy if exists "users_update_own_basic_profile" on public.xandeflix_users;

-- -----------------------------------------------------------------------------
-- 5. Função de Limpeza (Housekeeping)
-- -----------------------------------------------------------------------------
-- Ajuda a manter o banco performático removendo telemetria antiga.

create or replace function public.cleanup_old_telemetry(days_to_keep integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  if days_to_keep < 1 then
    raise exception 'days_to_keep deve ser >= 1.';
  end if;

  if auth.role() = 'anon' then
    raise exception 'Somente administradores podem executar cleanup de telemetria.'
      using errcode = '42501';
  elsif auth.role() = 'authenticated' and not public.is_xandeflix_admin() then
    raise exception 'Somente administradores podem executar cleanup de telemetria.'
      using errcode = '42501';
  end if;

  delete from public.player_telemetry_reports
  where created_at < now() - (days_to_keep || ' days')::interval;
  
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_old_telemetry(integer) from public, anon;
grant execute on function public.cleanup_old_telemetry(integer) to authenticated, service_role;

commit;

-- Instrução: Execute este script no SQL Editor do Supabase para aplicar a Fase 2.
