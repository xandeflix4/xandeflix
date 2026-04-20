-- Xandeflix - Phase 5 Playlist Output Rotation Test
-- Objetivo:
-- Testar rapidamente formatos de playlist (ts -> mpegts -> hls)
-- com rollback imediato para a URL original.
--
-- Como usar:
-- 1) Iniciar teste (aplica output=ts):
--    select * from public.playlist_output_test_start('teste');
--
-- 2) Avancar formato a cada tentativa no app:
--    select * from public.playlist_output_test_next('teste'); -- mpegts
--    select * from public.playlist_output_test_next('teste'); -- hls
--    select * from public.playlist_output_test_next('teste'); -- rollback original
--
-- 3) Rollback imediato (a qualquer momento):
--    select * from public.playlist_output_test_rollback('teste');

begin;

create table if not exists public.playlist_output_test_state (
  user_id uuid primary key references public.xandeflix_users (id) on delete cascade,
  identifier text not null,
  original_playlist_url text not null,
  current_step integer not null default 0 check (current_step between 0 and 3),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.playlist_output_test_state enable row level security;

drop policy if exists "admins_manage_playlist_output_test_state" on public.playlist_output_test_state;
create policy "admins_manage_playlist_output_test_state"
on public.playlist_output_test_state
for all
to authenticated
using (public.is_xandeflix_admin())
with check (public.is_xandeflix_admin());

create or replace function public.resolve_playlist_output_url(
  p_original_url text,
  p_output text
)
returns text
language plpgsql
immutable
as $$
declare
  v_url text := trim(coalesce(p_original_url, ''));
  v_output text := lower(trim(coalesce(p_output, '')));
begin
  if v_url = '' then
    return '';
  end if;

  if v_output not in ('ts', 'mpegts', 'hls') then
    return v_url;
  end if;

  if v_url ~* '([?&])output=' then
    return regexp_replace(v_url, '([?&])output=[^&]*', '\1output=' || v_output, 'i');
  end if;

  if position('?' in v_url) > 0 then
    return v_url || '&output=' || v_output;
  end if;

  return v_url || '?output=' || v_output;
end;
$$;

create or replace function public.resolve_xandeflix_user_for_test(
  p_identifier text
)
returns public.xandeflix_users
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user public.xandeflix_users%rowtype;
  v_identifier text := lower(trim(coalesce(p_identifier, '')));
begin
  if auth.role() = 'anon' then
    raise exception 'Apenas usuarios autenticados podem executar o teste de output da playlist.'
      using errcode = '42501';
  elsif auth.role() = 'authenticated' and not public.is_xandeflix_admin() then
    raise exception 'Apenas administradores podem executar o teste de output da playlist.'
      using errcode = '42501';
  end if;

  if v_identifier = '' then
    raise exception 'Informe username, access_id ou email.';
  end if;

  select *
  into v_user
  from public.xandeflix_users xu
  where lower(coalesce(xu.username::text, '')) = v_identifier
     or lower(coalesce(xu.access_id::text, '')) = v_identifier
     or lower(coalesce(xu.email::text, '')) = v_identifier
  order by
    case when lower(coalesce(xu.username::text, '')) = v_identifier then 0 else 1 end,
    case when lower(coalesce(xu.access_id::text, '')) = v_identifier then 0 else 1 end,
    case when lower(coalesce(xu.email::text, '')) = v_identifier then 0 else 1 end
  limit 1;

  if v_user.id is null then
    raise exception 'Usuario nao encontrado para o identificador: %', p_identifier;
  end if;

  return v_user;
end;
$$;

create or replace function public.playlist_output_test_start(
  p_identifier text
)
returns table (
  user_id uuid,
  identifier text,
  applied_output text,
  playlist_url text,
  next_action text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.xandeflix_users%rowtype;
  v_original_url text;
  v_target_url text;
begin
  v_user := public.resolve_xandeflix_user_for_test(p_identifier);

  if coalesce(trim(v_user.playlist_url), '') = '' then
    raise exception 'Usuario % nao possui playlist_url configurada.', p_identifier;
  end if;

  insert into public.playlist_output_test_state (
    user_id,
    identifier,
    original_playlist_url,
    current_step
  )
  values (
    v_user.id,
    p_identifier,
    v_user.playlist_url,
    0
  )
  on conflict on constraint playlist_output_test_state_pkey do nothing;

  select original_playlist_url
  into v_original_url
  from public.playlist_output_test_state st
  where st.user_id = v_user.id;

  v_target_url := public.resolve_playlist_output_url(v_original_url, 'ts');

  update public.xandeflix_users
  set playlist_url = v_target_url,
      updated_at = timezone('utc', now())
  where id = v_user.id;

  update public.playlist_output_test_state
  set current_step = 1,
      updated_at = timezone('utc', now())
  where playlist_output_test_state.user_id = v_user.id;

  return query
  select
    v_user.id,
    p_identifier,
    'ts'::text,
    v_target_url,
    'Execute public.playlist_output_test_next(...) para mpegts.'::text;
end;
$$;

create or replace function public.playlist_output_test_next(
  p_identifier text
)
returns table (
  user_id uuid,
  identifier text,
  applied_output text,
  playlist_url text,
  finished boolean,
  next_action text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.xandeflix_users%rowtype;
  v_state public.playlist_output_test_state%rowtype;
  v_next_step integer;
  v_output text;
  v_target_url text;
begin
  v_user := public.resolve_xandeflix_user_for_test(p_identifier);

  select *
  into v_state
  from public.playlist_output_test_state st
  where st.user_id = v_user.id;

  if v_state.user_id is null then
    return query
    select
      s.user_id,
      s.identifier,
      s.applied_output,
      s.playlist_url,
      false,
      s.next_action
    from public.playlist_output_test_start(p_identifier) s;
    return;
  end if;

  v_next_step := case v_state.current_step
    when 1 then 2 -- mpegts
    when 2 then 3 -- hls
    else 0        -- rollback original
  end;

  v_output := case v_next_step
    when 1 then 'ts'
    when 2 then 'mpegts'
    when 3 then 'hls'
    else 'original'
  end;

  if v_next_step = 0 then
    v_target_url := v_state.original_playlist_url;
  else
    v_target_url := public.resolve_playlist_output_url(v_state.original_playlist_url, v_output);
  end if;

  update public.xandeflix_users
  set playlist_url = v_target_url,
      updated_at = timezone('utc', now())
  where id = v_user.id;

  if v_next_step = 0 then
    delete from public.playlist_output_test_state
    where playlist_output_test_state.user_id = v_user.id;

    return query
    select
      v_user.id,
      p_identifier,
      'original'::text,
      v_target_url,
      true,
      'Teste finalizado. URL original restaurada.'::text;
  else
    update public.playlist_output_test_state
    set current_step = v_next_step,
        updated_at = timezone('utc', now())
    where playlist_output_test_state.user_id = v_user.id;

    return query
    select
      v_user.id,
      p_identifier,
      v_output,
      v_target_url,
      false,
      case v_next_step
        when 2 then 'Execute public.playlist_output_test_next(...) para hls.'
        when 3 then 'Execute public.playlist_output_test_next(...) para rollback original.'
        else 'Execute public.playlist_output_test_next(...).'
      end;
  end if;
end;
$$;

create or replace function public.playlist_output_test_rollback(
  p_identifier text
)
returns table (
  user_id uuid,
  identifier text,
  restored boolean,
  playlist_url text,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.xandeflix_users%rowtype;
  v_state public.playlist_output_test_state%rowtype;
begin
  v_user := public.resolve_xandeflix_user_for_test(p_identifier);

  select *
  into v_state
  from public.playlist_output_test_state st
  where st.user_id = v_user.id;

  if v_state.user_id is null then
    return query
    select
      v_user.id,
      p_identifier,
      false,
      v_user.playlist_url,
      'Nenhum teste ativo encontrado para este usuario.'::text;
    return;
  end if;

  update public.xandeflix_users
  set playlist_url = v_state.original_playlist_url,
      updated_at = timezone('utc', now())
  where id = v_user.id;

  delete from public.playlist_output_test_state
  where playlist_output_test_state.user_id = v_user.id;

  return query
  select
    v_user.id,
    p_identifier,
    true,
    v_state.original_playlist_url,
    'URL original restaurada com sucesso.'::text;
end;
$$;

revoke all on function public.resolve_playlist_output_url(text, text) from public, anon;
revoke all on function public.resolve_xandeflix_user_for_test(text) from public, anon;
revoke all on function public.playlist_output_test_start(text) from public, anon;
revoke all on function public.playlist_output_test_next(text) from public, anon;
revoke all on function public.playlist_output_test_rollback(text) from public, anon;

grant execute on function public.resolve_playlist_output_url(text, text) to authenticated, service_role;
grant execute on function public.resolve_xandeflix_user_for_test(text) to authenticated, service_role;
grant execute on function public.playlist_output_test_start(text) to authenticated, service_role;
grant execute on function public.playlist_output_test_next(text) to authenticated, service_role;
grant execute on function public.playlist_output_test_rollback(text) to authenticated, service_role;

commit;
