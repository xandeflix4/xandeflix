-- Xandeflix - Phase 6 Adult Access
-- Execute este SQL antes de testar o novo fluxo de PIN/senha adulta sem backend Express.

begin;

create or replace function public.adult_access_unlock(
  p_password text
)
returns table (
  enabled boolean,
  totp_enabled boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.xandeflix_users%rowtype;
begin
  select *
  into v_user
  from public.xandeflix_users
  where auth_user_id = auth.uid()
  limit 1;

  if v_user.id is null then
    raise exception 'Perfil do usuario nao encontrado no Supabase.';
  end if;

  if v_user.is_blocked then
    raise exception 'Este acesso esta bloqueado.';
  end if;

  if coalesce(v_user.adult_password, '') = '' then
    raise exception 'O controle adulto ainda nao foi configurado.';
  end if;

  if coalesce(trim(p_password), '') = '' then
    raise exception 'Informe a senha do conteudo adulto.';
  end if;

  if extensions.crypt(p_password, v_user.adult_password) <> v_user.adult_password then
    raise exception 'Senha do conteudo adulto invalida.';
  end if;

  return query
  select true, false;
end;
$$;

create or replace function public.adult_access_set_password(
  p_new_password text,
  p_current_password text default null
)
returns table (
  enabled boolean,
  totp_enabled boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.xandeflix_users%rowtype;
  v_new_password text;
begin
  select *
  into v_user
  from public.xandeflix_users
  where auth_user_id = auth.uid()
  limit 1;

  if v_user.id is null then
    raise exception 'Perfil do usuario nao encontrado no Supabase.';
  end if;

  if v_user.is_blocked then
    raise exception 'Este acesso esta bloqueado.';
  end if;

  v_new_password := trim(coalesce(p_new_password, ''));

  if length(v_new_password) < 4 then
    raise exception 'A senha adulta precisa ter pelo menos 4 caracteres.';
  end if;

  if coalesce(v_user.adult_password, '') <> '' then
    if coalesce(trim(p_current_password), '') = '' then
      raise exception 'Informe a senha adulta atual.';
    end if;

    if extensions.crypt(p_current_password, v_user.adult_password) <> v_user.adult_password then
      raise exception 'Senha adulta atual invalida.';
    end if;
  end if;

  update public.xandeflix_users
  set adult_password = extensions.crypt(v_new_password, extensions.gen_salt('bf')),
      adult_totp_enabled = false,
      adult_totp_secret = null,
      updated_at = timezone('utc', now())
  where id = v_user.id;

  return query
  select true, false;
end;
$$;

grant execute on function public.adult_access_unlock(text) to authenticated, service_role;
grant execute on function public.adult_access_set_password(text, text) to authenticated, service_role;

commit;
