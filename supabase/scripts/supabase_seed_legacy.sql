-- Xandeflix - Legacy seed generated from users.json

-- Execute este arquivo depois de supabase_setup.sql.

-- Gerado em 2026-04-03T07:21:27.168Z.



begin;



-- Usuarios legados

insert into public.xandeflix_users (
  id,
  auth_user_id,
  email,
  access_id,
  name,
  username,
  password,
  playlist_url,
  is_blocked,
  role,
  last_access,
  hidden_categories,
  category_overrides,
  media_overrides,
  adult_password,
  adult_totp_secret,
  adult_totp_enabled
)
values (
  '02df2f82-f51a-484b-ba69-a6781d2fa75a',
  null,
  null,
  'alexandre',
  'alexandre',
  'alexandre',
  '$2b$10$LRIWoH6Roa92tvkWwININuCzxy.ENGHmqzg.bGq8ydy628Ottni4m',
  'http://nt.chavedelta.site/get.php?username=212305365&password=678335832&type=m3u_plus&output=hls',
  false,
  'user',
  '2026-03-25T21:28:34.775Z',
  array[]::text[],
  '{}'::jsonb,
  '{}'::jsonb,
  null,
  null,
  false
)
on conflict (username) do update
set access_id = excluded.access_id,
    name = excluded.name,
    password = coalesce(excluded.password, public.xandeflix_users.password),
    playlist_url = excluded.playlist_url,
    is_blocked = excluded.is_blocked,
    role = excluded.role,
    last_access = excluded.last_access,
    hidden_categories = excluded.hidden_categories,
    category_overrides = excluded.category_overrides,
    media_overrides = excluded.media_overrides,
    adult_password = coalesce(excluded.adult_password, public.xandeflix_users.adult_password),
    adult_totp_secret = coalesce(excluded.adult_totp_secret, public.xandeflix_users.adult_totp_secret),
    adult_totp_enabled = excluded.adult_totp_enabled,
    updated_at = timezone('utc', now());

insert into public.xandeflix_users (
  id,
  auth_user_id,
  email,
  access_id,
  name,
  username,
  password,
  playlist_url,
  is_blocked,
  role,
  last_access,
  hidden_categories,
  category_overrides,
  media_overrides,
  adult_password,
  adult_totp_secret,
  adult_totp_enabled
)
values (
  '4440f813-5195-4175-961a-b9e66927fa70',
  null,
  null,
  'janaina',
  'janaina',
  'janaina',
  '$2b$10$zDyE3/Sp8gYP.BISjWv3FuzmSB7c2OPTX4JXOOUIoiSd7Lj3ArrLa',
  'https://real.cdnbr.site/get.php?username=482638992&password=266442292&type=m3u_plus&output=mpegts',
  false,
  'user',
  '2026-03-28T21:59:28.637Z',
  array[]::text[],
  '{}'::jsonb,
  '{}'::jsonb,
  null,
  null,
  false
)
on conflict (username) do update
set access_id = excluded.access_id,
    name = excluded.name,
    password = coalesce(excluded.password, public.xandeflix_users.password),
    playlist_url = excluded.playlist_url,
    is_blocked = excluded.is_blocked,
    role = excluded.role,
    last_access = excluded.last_access,
    hidden_categories = excluded.hidden_categories,
    category_overrides = excluded.category_overrides,
    media_overrides = excluded.media_overrides,
    adult_password = coalesce(excluded.adult_password, public.xandeflix_users.adult_password),
    adult_totp_secret = coalesce(excluded.adult_totp_secret, public.xandeflix_users.adult_totp_secret),
    adult_totp_enabled = excluded.adult_totp_enabled,
    updated_at = timezone('utc', now());

insert into public.xandeflix_users (
  id,
  auth_user_id,
  email,
  access_id,
  name,
  username,
  password,
  playlist_url,
  is_blocked,
  role,
  last_access,
  hidden_categories,
  category_overrides,
  media_overrides,
  adult_password,
  adult_totp_secret,
  adult_totp_enabled
)
values (
  'a04789d9-a76f-4291-8ed8-07318dfce4b8',
  null,
  null,
  'teste',
  'teste',
  'teste',
  '$2b$10$rC/RjUQku3jwaUm0COIpAeIFNOxKz0WOC1zi/NlbSQ.DbP/tMZf4e',
  'http://btopx.space/get.php?username=5fyh8373qu&password=fmbk2bqe4y&type=m3u_plus&output=ts',
  false,
  'user',
  '2026-03-30T15:41:23.957Z',
  array[]::text[],
  '{"canais-i-sess-o-cinema":"live","cine-filmes-hd-24hrs":"live"}'::jsonb,
  '{}'::jsonb,
  null,
  null,
  false
)
on conflict (username) do update
set access_id = excluded.access_id,
    name = excluded.name,
    password = coalesce(excluded.password, public.xandeflix_users.password),
    playlist_url = excluded.playlist_url,
    is_blocked = excluded.is_blocked,
    role = excluded.role,
    last_access = excluded.last_access,
    hidden_categories = excluded.hidden_categories,
    category_overrides = excluded.category_overrides,
    media_overrides = excluded.media_overrides,
    adult_password = coalesce(excluded.adult_password, public.xandeflix_users.adult_password),
    adult_totp_secret = coalesce(excluded.adult_totp_secret, public.xandeflix_users.adult_totp_secret),
    adult_totp_enabled = excluded.adult_totp_enabled,
    updated_at = timezone('utc', now());



-- Global media overrides

-- Nenhum global override encontrado.



-- Garantir preferencias para todos os usuarios sincronizados

insert into public.user_preferences (user_id)

select xu.id

from public.xandeflix_users xu

on conflict (user_id) do nothing;



commit;


