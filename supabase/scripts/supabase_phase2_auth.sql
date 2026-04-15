-- Xandeflix - Phase 2 Auth bootstrap
-- Execute este SQL antes de ligar o app ao Supabase Auth no frontend.
-- Ele permite login por access_id sem VPS, validando o hash legado no banco
-- e criando a ponte para a conta do Supabase Auth no primeiro login.

begin;

create or replace function public.xandeflix_login_email(p_identifier text)
returns text
language sql
immutable
as $$
  select lower(
    regexp_replace(
      coalesce(nullif(trim(p_identifier), ''), 'user'),
      '[^a-z0-9._-]+',
      '-',
      'gi'
    )
  ) || '@users.xandeflix.example.com';
$$;

create or replace function public.authenticate_access_id(
  p_identifier text,
  p_password text
)
returns table (
  user_id uuid,
  access_id text,
  username text,
  name text,
  role text,
  is_blocked boolean,
  has_auth_user boolean,
  login_email text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_identifier text;
  v_auth_user_id uuid;
begin
  v_identifier := lower(trim(coalesce(p_identifier, '')));

  if v_identifier = '' or coalesce(p_password, '') = '' then
    return;
  end if;

  with matched_user as (
    select
      xu.id,
      coalesce(xu.access_id::text, xu.username::text, v_identifier) as resolved_access_id,
      coalesce(
        xu.email::text,
        public.xandeflix_login_email(coalesce(xu.access_id::text, xu.username::text, v_identifier))
      ) as resolved_login_email
    from public.xandeflix_users xu
    where (
        lower(coalesce(xu.access_id::text, '')) = v_identifier
        or lower(coalesce(xu.username::text, '')) = v_identifier
      )
      and xu.password is not null
      and extensions.crypt(p_password, xu.password) = xu.password
    limit 1
  )
  select au.id
  into v_auth_user_id
  from matched_user mu
  join auth.users au
    on lower(au.email) = lower(mu.resolved_login_email)
  limit 1;

  if v_auth_user_id is not null then
    update public.xandeflix_users xu
    set auth_user_id = coalesce(xu.auth_user_id, v_auth_user_id),
        email = coalesce(
          xu.email,
          public.xandeflix_login_email(coalesce(xu.access_id::text, xu.username::text, v_identifier))::citext
        ),
        updated_at = timezone('utc', now())
    where (
        lower(coalesce(xu.access_id::text, '')) = v_identifier
        or lower(coalesce(xu.username::text, '')) = v_identifier
      )
      and xu.password is not null
      and extensions.crypt(p_password, xu.password) = xu.password;
  end if;

  return query
  select
    xu.id,
    coalesce(xu.access_id::text, xu.username::text, v_identifier) as access_id,
    xu.username::text,
    xu.name,
    xu.role,
    xu.is_blocked,
    (xu.auth_user_id is not null or v_auth_user_id is not null) as has_auth_user,
    coalesce(xu.email::text, public.xandeflix_login_email(coalesce(xu.access_id::text, xu.username::text, v_identifier))) as login_email
  from public.xandeflix_users xu
  where (
      lower(coalesce(xu.access_id::text, '')) = v_identifier
      or lower(coalesce(xu.username::text, '')) = v_identifier
    )
    and xu.password is not null
    and extensions.crypt(p_password, xu.password) = xu.password
  limit 1;
end;
$$;

grant execute on function public.xandeflix_login_email(text) to anon, authenticated, service_role;
grant execute on function public.authenticate_access_id(text, text) to anon, authenticated, service_role;

commit;
