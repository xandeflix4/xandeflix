-- Xandeflix - Supabase Setup
-- Execute este script no SQL Editor do Supabase antes da Fase 1.
-- Ele prepara a base para a arquitetura final sem VPS:
-- Auth + Postgres + RLS + tabelas para app/admin.

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.xandeflix_jsonb_to_text_array(input jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(value), array[]::text[])
  from jsonb_array_elements_text(coalesce(input, '[]'::jsonb)) as t(value);
$$;

-- -----------------------------------------------------------------------------
-- Main user profile table
-- -----------------------------------------------------------------------------
-- Mantemos o nome xandeflix_users para reduzir atrito com a base atual.
-- O id continua independente de auth.users durante a transicao.
-- O vinculo com Supabase Auth fica em auth_user_id.

create table if not exists public.xandeflix_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  email citext unique,
  access_id citext unique,
  name text not null default '',
  username citext unique,
  password text,
  playlist_url text not null default '',
  is_blocked boolean not null default false,
  role text not null default 'user' check (role in ('admin', 'user')),
  last_access timestamptz,
  hidden_categories text[] not null default '{}'::text[],
  category_overrides jsonb not null default '{}'::jsonb,
  media_overrides jsonb not null default '{}'::jsonb,
  adult_password text,
  adult_totp_secret text,
  adult_totp_enabled boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Compatibilidade com bases onde public.xandeflix_users ja existe sem os
-- campos novos exigidos pela migracao para Supabase Auth.
alter table public.xandeflix_users
  add column if not exists auth_user_id uuid unique references auth.users (id) on delete set null;

alter table public.xandeflix_users
  add column if not exists email citext unique;

alter table public.xandeflix_users
  add column if not exists access_id citext unique;

alter table public.xandeflix_users
  add column if not exists name text not null default '';

alter table public.xandeflix_users
  add column if not exists username citext;

alter table public.xandeflix_users
  add column if not exists password text;

alter table public.xandeflix_users
  add column if not exists playlist_url text not null default '';

alter table public.xandeflix_users
  add column if not exists is_blocked boolean not null default false;

alter table public.xandeflix_users
  add column if not exists role text not null default 'user';

alter table public.xandeflix_users
  add column if not exists last_access timestamptz;

alter table public.xandeflix_users
  add column if not exists hidden_categories text[] not null default '{}'::text[];

alter table public.xandeflix_users
  add column if not exists category_overrides jsonb not null default '{}'::jsonb;

alter table public.xandeflix_users
  add column if not exists media_overrides jsonb not null default '{}'::jsonb;

alter table public.xandeflix_users
  add column if not exists adult_password text;

alter table public.xandeflix_users
  add column if not exists adult_totp_secret text;

alter table public.xandeflix_users
  add column if not exists adult_totp_enabled boolean not null default false;

alter table public.xandeflix_users
  add column if not exists created_at timestamptz not null default timezone('utc', now());

alter table public.xandeflix_users
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'xandeflix_users'
      and column_name = 'hidden_categories'
      and udt_name = 'jsonb'
  ) then
    alter table public.xandeflix_users
      alter column hidden_categories drop default;

    alter table public.xandeflix_users
      alter column hidden_categories type text[]
      using public.xandeflix_jsonb_to_text_array(hidden_categories);

    alter table public.xandeflix_users
      alter column hidden_categories set default '{}'::text[];
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'xandeflix_users_role_check'
      and conrelid = 'public.xandeflix_users'::regclass
  ) then
    alter table public.xandeflix_users
      add constraint xandeflix_users_role_check
      check (role in ('admin', 'user'));
  end if;
end $$;

create unique index if not exists idx_xandeflix_users_username_unique
  on public.xandeflix_users (username)
  where username is not null;

create unique index if not exists idx_xandeflix_users_access_id_unique
  on public.xandeflix_users (access_id)
  where access_id is not null;

create unique index if not exists idx_xandeflix_users_email_unique
  on public.xandeflix_users (email)
  where email is not null;

create index if not exists idx_xandeflix_users_role
  on public.xandeflix_users (role);

create index if not exists idx_xandeflix_users_auth_user_id
  on public.xandeflix_users (auth_user_id);

create index if not exists idx_xandeflix_users_is_blocked
  on public.xandeflix_users (is_blocked);

create index if not exists idx_xandeflix_users_last_access
  on public.xandeflix_users (last_access desc nulls last);

drop trigger if exists trg_xandeflix_users_updated_at on public.xandeflix_users;
create trigger trg_xandeflix_users_updated_at
before update on public.xandeflix_users
for each row
execute function public.set_updated_at();

create or replace function public.current_xandeflix_user_id(
  p_auth_user_id uuid default auth.uid()
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select xu.id
  from public.xandeflix_users xu
  where xu.auth_user_id = auth.uid()
  limit 1;
$$;

create or replace function public.is_xandeflix_admin(
  p_auth_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.xandeflix_users xu
    where xu.auth_user_id = auth.uid()
      and xu.role = 'admin'
      and xu.is_blocked = false
  );
$$;

revoke all on function public.current_xandeflix_user_id(uuid) from public, anon;
revoke all on function public.is_xandeflix_admin(uuid) from public, anon;
grant execute on function public.current_xandeflix_user_id(uuid) to authenticated, service_role;
grant execute on function public.is_xandeflix_admin(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- User preferences
-- -----------------------------------------------------------------------------
-- Preferencias que hoje vivem em Zustand/localStorage e podem migrar
-- gradualmente para o banco.

create table if not exists public.user_preferences (
  user_id uuid primary key references public.xandeflix_users (id) on delete cascade,
  favorites jsonb not null default '[]'::jsonb,
  watch_history jsonb not null default '{}'::jsonb,
  playback_progress jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_user_preferences_updated_at on public.user_preferences;
create trigger trg_user_preferences_updated_at
before update on public.user_preferences
for each row
execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Watch history & Favorites (Dedicated tables for performance)
-- -----------------------------------------------------------------------------

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
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, media_id)
);

create index if not exists idx_watch_history_user_id on public.watch_history (user_id);
create index if not exists idx_watch_history_updated_at on public.watch_history (updated_at desc);

drop trigger if exists trg_watch_history_updated_at on public.watch_history;
create trigger trg_watch_history_updated_at
before update on public.watch_history
for each row execute function public.set_updated_at();

create table if not exists public.favorites (
  user_id uuid not null references public.xandeflix_users (id) on delete cascade,
  media_id text not null,
  media_type text not null default 'live',
  media_title text not null,
  tmdb_id integer,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, media_id)
);

create index if not exists idx_favorites_user_id on public.favorites (user_id);

create or replace function public.handle_xandeflix_user_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_xandeflix_users_after_insert on public.xandeflix_users;
create trigger trg_xandeflix_users_after_insert
after insert on public.xandeflix_users
for each row
execute function public.handle_xandeflix_user_insert();

-- -----------------------------------------------------------------------------
-- Global media overrides
-- -----------------------------------------------------------------------------

create table if not exists public.global_media_overrides (
  title_match text primary key,
  override_data jsonb not null default '{}'::jsonb,
  created_by uuid references public.xandeflix_users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_global_media_overrides_updated_at on public.global_media_overrides;
create trigger trg_global_media_overrides_updated_at
before update on public.global_media_overrides
for each row
execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Playlist catalog snapshots
-- -----------------------------------------------------------------------------
-- Snapshot leve do catalogo para o painel admin consultar sem baixar a M3U
-- diretamente no navegador.

create table if not exists public.playlist_catalog_snapshots (
  user_id uuid primary key references public.xandeflix_users (id) on delete cascade,
  playlist_url text not null default '',
  epg_url text,
  category_count integer not null default 0 check (category_count >= 0),
  item_count integer not null default 0 check (item_count >= 0),
  source_hash text,
  snapshot jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_playlist_catalog_snapshots_generated_at
  on public.playlist_catalog_snapshots (generated_at desc);

drop trigger if exists trg_playlist_catalog_snapshots_updated_at on public.playlist_catalog_snapshots;
create trigger trg_playlist_catalog_snapshots_updated_at
before update on public.playlist_catalog_snapshots
for each row
execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Player telemetry
-- -----------------------------------------------------------------------------

create table if not exists public.player_telemetry_reports (
  id bigint generated always as identity primary key,
  user_id uuid references public.xandeflix_users (id) on delete set null,
  session_role text not null default 'anonymous',
  media_id text not null,
  media_title text not null,
  media_category text not null default '',
  media_type text not null default 'live',
  stream_host text not null default '',
  strategy text not null default 'unknown',
  session_seconds integer not null default 0 check (session_seconds >= 0),
  watch_seconds integer not null default 0 check (watch_seconds >= 0),
  buffer_seconds integer not null default 0 check (buffer_seconds >= 0),
  buffer_event_count integer not null default 0 check (buffer_event_count >= 0),
  stall_recovery_count integer not null default 0 check (stall_recovery_count >= 0),
  error_recovery_count integer not null default 0 check (error_recovery_count >= 0),
  ended_recovery_count integer not null default 0 check (ended_recovery_count >= 0),
  manual_retry_count integer not null default 0 check (manual_retry_count >= 0),
  quality_fallback_count integer not null default 0 check (quality_fallback_count >= 0),
  fatal_error_count integer not null default 0 check (fatal_error_count >= 0),
  sampled boolean not null default false,
  exit_reason text not null default 'unknown',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_player_telemetry_reports_created_at
  on public.player_telemetry_reports (created_at desc);

create index if not exists idx_player_telemetry_reports_user_id
  on public.player_telemetry_reports (user_id);

create index if not exists idx_player_telemetry_reports_media_id
  on public.player_telemetry_reports (media_id);

-- -----------------------------------------------------------------------------
-- Auth sync helpers
-- -----------------------------------------------------------------------------
-- O trigger abaixo suporta o caso em que o admin pre-cadastra um perfil
-- (email/access_id) antes de a conta existir em auth.users.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_user_id uuid;
  v_name text;
  v_username citext;
  v_access_id citext;
  v_role text;
begin
  v_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    split_part(coalesce(new.email, ''), '@', 1),
    'Usuario'
  );

  v_username := nullif(
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    ''
  )::citext;

  v_access_id := nullif(trim(new.raw_user_meta_data ->> 'access_id'), '')::citext;
  -- Nunca confiamos em role vindo de metadata de signup.
  -- Promocao para admin deve ser processo explicito no painel/SQL.
  v_role := 'user';

  select xu.id
  into v_existing_user_id
  from public.xandeflix_users xu
  where xu.auth_user_id = new.id
     or (new.email is not null and xu.email = new.email)
     or (v_access_id is not null and xu.access_id = v_access_id)
  order by case
    when xu.auth_user_id = new.id then 0
    when new.email is not null and xu.email = new.email then 1
    when v_access_id is not null and xu.access_id = v_access_id then 2
    else 3
  end
  limit 1;

  if v_existing_user_id is null then
    insert into public.xandeflix_users (
      auth_user_id,
      email,
      access_id,
      name,
      username,
      role
    )
    values (
      new.id,
      new.email,
      v_access_id,
      v_name,
      v_username,
      v_role
    )
    returning id into v_existing_user_id;
  else
    update public.xandeflix_users
    set auth_user_id = new.id,
        email = coalesce(public.xandeflix_users.email, new.email),
        access_id = coalesce(public.xandeflix_users.access_id, v_access_id),
        name = case
          when coalesce(trim(public.xandeflix_users.name), '') = '' then v_name
          else public.xandeflix_users.name
        end,
        username = coalesce(public.xandeflix_users.username, v_username),
        role = case
          when public.xandeflix_users.role in ('admin', 'user') then public.xandeflix_users.role
          else v_role
        end
    where public.xandeflix_users.id = v_existing_user_id;
  end if;

  insert into public.user_preferences (user_id)
  values (v_existing_user_id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_auth_user();

create or replace function public.sync_auth_users_to_xandeflix_users()
returns table (
  linked_count integer,
  inserted_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_linked_count integer := 0;
  v_inserted_count integer := 0;
begin
  if auth.role() = 'anon' then
    raise exception 'Apenas usuarios autenticados podem sincronizar usuarios do Authentication.'
      using errcode = '42501';
  elsif auth.role() = 'authenticated' and not public.is_xandeflix_admin() then
    raise exception 'Apenas administradores podem sincronizar usuarios do Authentication.'
      using errcode = '42501';
  end if;

  update public.xandeflix_users xu
  set auth_user_id = au.id,
      email = coalesce(xu.email, au.email),
      access_id = coalesce(
        xu.access_id,
        nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext
      ),
      name = case
        when coalesce(trim(xu.name), '') = '' then coalesce(
          nullif(trim(au.raw_user_meta_data ->> 'name'), ''),
          split_part(coalesce(au.email, ''), '@', 1),
          'Usuario'
        )
        else xu.name
      end,
      username = coalesce(
        xu.username,
        nullif(
          coalesce(
            nullif(trim(au.raw_user_meta_data ->> 'username'), ''),
            split_part(coalesce(au.email, ''), '@', 1)
          ),
          ''
        )::citext
      ),
      updated_at = timezone('utc', now())
  from auth.users au
  where (xu.auth_user_id is null or xu.auth_user_id <> au.id)
    and (
      (au.email is not null and xu.email = au.email)
      or (
        nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext is not null
        and xu.access_id = nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext
      )
      or (
        xu.username is not null
        and lower(xu.username::text) = lower(split_part(coalesce(au.email, ''), '@', 1))
      )
    );

  get diagnostics v_linked_count = row_count;

  insert into public.xandeflix_users (
    auth_user_id,
    email,
    access_id,
    name,
    username,
    role
  )
  select
    au.id,
    au.email,
    nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext,
    coalesce(
      nullif(trim(au.raw_user_meta_data ->> 'name'), ''),
      split_part(coalesce(au.email, ''), '@', 1),
      'Usuario'
    ),
    nullif(
      coalesce(
        nullif(trim(au.raw_user_meta_data ->> 'username'), ''),
        split_part(coalesce(au.email, ''), '@', 1)
      ),
      ''
    )::citext,
    'user'::text
  from auth.users au
  where not exists (
    select 1
    from public.xandeflix_users xu
    where xu.auth_user_id = au.id
       or (au.email is not null and xu.email = au.email)
       or (
         nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext is not null
         and xu.access_id = nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext
       )
  );

  get diagnostics v_inserted_count = row_count;

  insert into public.user_preferences (user_id)
  select xu.id
  from public.xandeflix_users xu
  on conflict (user_id) do nothing;

  return query
  select v_linked_count, v_inserted_count;
end;
$$;

revoke all on function public.sync_auth_users_to_xandeflix_users() from public, anon;
grant execute on function public.sync_auth_users_to_xandeflix_users() to authenticated, service_role;

-- Backfill para usuarios auth ja existentes
update public.xandeflix_users xu
set auth_user_id = au.id,
    email = coalesce(xu.email, au.email),
    access_id = coalesce(
      xu.access_id,
      nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext
    ),
    name = case
      when coalesce(trim(xu.name), '') = '' then coalesce(
        nullif(trim(au.raw_user_meta_data ->> 'name'), ''),
        split_part(coalesce(au.email, ''), '@', 1),
        'Usuario'
      )
      else xu.name
    end,
    username = coalesce(
      xu.username,
      nullif(
        coalesce(
          nullif(trim(au.raw_user_meta_data ->> 'username'), ''),
          split_part(coalesce(au.email, ''), '@', 1)
        ),
        ''
      )::citext
    )
from auth.users au
where xu.auth_user_id is null
  and (
    (au.email is not null and xu.email = au.email)
    or (
      nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext is not null
      and xu.access_id = nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext
    )
  );

insert into public.xandeflix_users (
  auth_user_id,
  email,
  access_id,
  name,
  username,
  role
)
select
  au.id,
  au.email,
  nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext,
  coalesce(
    nullif(trim(au.raw_user_meta_data ->> 'name'), ''),
    split_part(coalesce(au.email, ''), '@', 1),
    'Usuario'
  ),
  nullif(
    coalesce(
      nullif(trim(au.raw_user_meta_data ->> 'username'), ''),
      split_part(coalesce(au.email, ''), '@', 1)
    ),
    ''
  )::citext,
  'user'::text
from auth.users au
where not exists (
  select 1
  from public.xandeflix_users xu
  where xu.auth_user_id = au.id
     or (au.email is not null and xu.email = au.email)
     or (
       nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext is not null
       and xu.access_id = nullif(trim(au.raw_user_meta_data ->> 'access_id'), '')::citext
     )
);

insert into public.user_preferences (user_id)
select xu.id
from public.xandeflix_users xu
on conflict (user_id) do nothing;

select * from public.sync_auth_users_to_xandeflix_users();

-- -----------------------------------------------------------------------------
-- Housekeeping functions
-- -----------------------------------------------------------------------------

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

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.xandeflix_users enable row level security;
alter table public.user_preferences enable row level security;
alter table public.global_media_overrides enable row level security;
alter table public.playlist_catalog_snapshots enable row level security;
alter table public.player_telemetry_reports enable row level security;

-- xandeflix_users
drop policy if exists "users_select_own_xandeflix_profile" on public.xandeflix_users;
create policy "users_select_own_xandeflix_profile"
on public.xandeflix_users
for select
to authenticated
using (auth_user_id = auth.uid());

drop policy if exists "users_update_own_basic_profile" on public.xandeflix_users;
-- IMPORTANTE:
-- Nao permitimos UPDATE direto de usuarios comuns em xandeflix_users.
-- Campos sensiveis (role/is_blocked/password/adult_*) devem ser alterados
-- somente por funcoes controladas (security definer) ou por admins.
-- Mantemos apenas SELECT proprio + policy administrativa abaixo.

drop policy if exists "admins_manage_all_xandeflix_profiles" on public.xandeflix_users;
create policy "admins_manage_all_xandeflix_profiles"
on public.xandeflix_users
for all
to authenticated
using (public.is_xandeflix_admin())
with check (public.is_xandeflix_admin());

-- watch_history
alter table public.watch_history enable row level security;
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

-- favorites
alter table public.favorites enable row level security;
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

-- user_preferences
drop policy if exists "users_manage_own_preferences" on public.user_preferences;
create policy "users_manage_own_preferences"
on public.user_preferences
for all
to authenticated
using (user_id = public.current_xandeflix_user_id())
with check (user_id = public.current_xandeflix_user_id());

drop policy if exists "admins_manage_all_preferences" on public.user_preferences;
create policy "admins_manage_all_preferences"
on public.user_preferences
for all
to authenticated
using (public.is_xandeflix_admin())
with check (public.is_xandeflix_admin());

-- global_media_overrides
drop policy if exists "authenticated_read_global_media_overrides" on public.global_media_overrides;
create policy "authenticated_read_global_media_overrides"
on public.global_media_overrides
for select
to authenticated
using (true);

drop policy if exists "admins_manage_global_media_overrides" on public.global_media_overrides;
create policy "admins_manage_global_media_overrides"
on public.global_media_overrides
for all
to authenticated
using (public.is_xandeflix_admin())
with check (public.is_xandeflix_admin());

-- playlist_catalog_snapshots
drop policy if exists "users_manage_own_playlist_snapshot" on public.playlist_catalog_snapshots;
create policy "users_manage_own_playlist_snapshot"
on public.playlist_catalog_snapshots
for all
to authenticated
using (user_id = public.current_xandeflix_user_id())
with check (user_id = public.current_xandeflix_user_id());

drop policy if exists "admins_manage_all_playlist_snapshots" on public.playlist_catalog_snapshots;
create policy "admins_manage_all_playlist_snapshots"
on public.playlist_catalog_snapshots
for all
to authenticated
using (public.is_xandeflix_admin())
with check (public.is_xandeflix_admin());

-- player_telemetry_reports
drop policy if exists "users_insert_own_telemetry" on public.player_telemetry_reports;
create policy "users_insert_own_telemetry"
on public.player_telemetry_reports
for insert
to authenticated
with check (user_id = public.current_xandeflix_user_id());

drop policy if exists "users_select_own_telemetry" on public.player_telemetry_reports;
create policy "users_select_own_telemetry"
on public.player_telemetry_reports
for select
to authenticated
using (user_id = public.current_xandeflix_user_id());

drop policy if exists "admins_manage_all_telemetry" on public.player_telemetry_reports;
create policy "admins_manage_all_telemetry"
on public.player_telemetry_reports
for all
to authenticated
using (public.is_xandeflix_admin())
with check (public.is_xandeflix_admin());

commit;

-- -----------------------------------------------------------------------------
-- Pos-setup manual
-- -----------------------------------------------------------------------------
-- 1. Crie o primeiro usuario no Supabase Auth.
-- 2. Promova esse usuario a admin com um update manual como este:
--
-- update public.xandeflix_users
-- set role = 'admin',
--     access_id = 'admin',
--     username = 'admin',
--     name = 'Administrador'
-- where email = 'SEU_EMAIL@DOMINIO.COM';
--
-- 3. A coluna public.xandeflix_users.access_id ja esta pronta para continuar
--    suportando "ID de acesso" alem de email/senha.
