-- Xandeflix - Legacy schema repair
-- Execute este arquivo se o projeto Supabase ja tinha uma tabela
-- public.xandeflix_users antiga e o seed legado falhar por coluna ausente.

begin;

create or replace function public.xandeflix_jsonb_to_text_array(input jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(value), array[]::text[])
  from jsonb_array_elements_text(coalesce(input, '[]'::jsonb)) as t(value);
$$;

alter table if exists public.xandeflix_users
  add column if not exists auth_user_id uuid references auth.users (id) on delete set null;

alter table if exists public.xandeflix_users
  add column if not exists email citext;

alter table if exists public.xandeflix_users
  add column if not exists access_id citext;

alter table if exists public.xandeflix_users
  add column if not exists name text not null default '';

alter table if exists public.xandeflix_users
  add column if not exists username citext;

alter table if exists public.xandeflix_users
  add column if not exists password text;

alter table if exists public.xandeflix_users
  add column if not exists playlist_url text not null default '';

alter table if exists public.xandeflix_users
  add column if not exists is_blocked boolean not null default false;

alter table if exists public.xandeflix_users
  add column if not exists role text not null default 'user';

alter table if exists public.xandeflix_users
  add column if not exists last_access timestamptz;

alter table if exists public.xandeflix_users
  add column if not exists hidden_categories text[] not null default '{}'::text[];

alter table if exists public.xandeflix_users
  add column if not exists category_overrides jsonb not null default '{}'::jsonb;

alter table if exists public.xandeflix_users
  add column if not exists media_overrides jsonb not null default '{}'::jsonb;

alter table if exists public.xandeflix_users
  add column if not exists adult_password text;

alter table if exists public.xandeflix_users
  add column if not exists adult_totp_secret text;

alter table if exists public.xandeflix_users
  add column if not exists adult_totp_enabled boolean not null default false;

alter table if exists public.xandeflix_users
  add column if not exists created_at timestamptz not null default timezone('utc', now());

alter table if exists public.xandeflix_users
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
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'xandeflix_users'
      and column_name = 'role'
  ) and not exists (
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

create unique index if not exists idx_xandeflix_users_auth_user_id_unique
  on public.xandeflix_users (auth_user_id)
  where auth_user_id is not null;

create unique index if not exists idx_xandeflix_users_email_unique
  on public.xandeflix_users (email)
  where email is not null;

create unique index if not exists idx_xandeflix_users_access_id_unique
  on public.xandeflix_users (access_id)
  where access_id is not null;

create unique index if not exists idx_xandeflix_users_username_unique
  on public.xandeflix_users (username)
  where username is not null;

commit;
