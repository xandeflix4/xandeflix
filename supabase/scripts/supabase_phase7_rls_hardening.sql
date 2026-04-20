-- Xandeflix - Phase 7 RLS/RPC Hardening
-- Objetivo:
-- 1) Remover policy insegura de update direto em public.xandeflix_users.
-- 2) Endurecer helpers de RLS para nunca aceitarem auth_user_id arbitrario.
-- 3) Restringir sync_auth_users_to_xandeflix_users para admin/service_role.
-- 4) Impedir escalonamento de role via raw_user_meta_data no trigger de auth.
-- 5) Restringir cleanup_old_telemetry para admin/service_role.

begin;

-- -----------------------------------------------------------------------------
-- 1) Bloqueio de UPDATE direto por usuarios comuns
-- -----------------------------------------------------------------------------
drop policy if exists "users_update_own_basic_profile" on public.xandeflix_users;

-- -----------------------------------------------------------------------------
-- 2) Hardening dos helpers usados por policies de RLS
-- -----------------------------------------------------------------------------
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
-- 3) Hardening do trigger auth.users -> public.xandeflix_users
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 4) Hardening do sync de Auth -> public.xandeflix_users
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 5) Hardening da limpeza de telemetria
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

commit;

-- Validacao opcional (execute manualmente com conta admin):
-- select * from public.sync_auth_users_to_xandeflix_users();
