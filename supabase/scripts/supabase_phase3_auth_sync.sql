-- Xandeflix - Phase 3 Auth User Sync
-- Execute este SQL para sincronizar usuarios criados em Authentication > Users
-- com a tabela public.xandeflix_users (usada pelo painel admin).

begin;

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

select * from public.sync_auth_users_to_xandeflix_users();

commit;
