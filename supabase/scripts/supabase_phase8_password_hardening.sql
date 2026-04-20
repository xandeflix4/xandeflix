-- Xandeflix - Phase 8 password hardening
-- Objetivo: remover hashing de senha do frontend e gerar hash legado
-- somente no banco, com controle de permissao por role admin.

begin;

create or replace function public.admin_hash_legacy_password(p_password text)
returns text
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_password text := trim(coalesce(p_password, ''));
  v_auth_user_id uuid := auth.uid();
  v_role text;
begin
  if v_password = '' then
    raise exception 'Senha obrigatoria.';
  end if;

  if length(v_password) < 4 then
    raise exception 'Senha deve ter pelo menos 4 caracteres.';
  end if;

  if length(v_password) > 128 then
    raise exception 'Senha excede o tamanho maximo permitido.';
  end if;

  if v_auth_user_id is null then
    raise exception 'Sessao autenticada obrigatoria.' using errcode = '42501';
  end if;

  select xu.role
    into v_role
  from public.xandeflix_users xu
  where xu.auth_user_id = v_auth_user_id
  limit 1;

  if coalesce(v_role, 'user') <> 'admin' then
    raise exception 'Apenas administradores podem gerar hash de senha legado.' using errcode = '42501';
  end if;

  return extensions.crypt(v_password, extensions.gen_salt('bf', 10));
end;
$$;

revoke all on function public.admin_hash_legacy_password(text) from public;
grant execute on function public.admin_hash_legacy_password(text) to authenticated, service_role;

comment on function public.admin_hash_legacy_password(text)
is 'Gera hash bcrypt legado para xandeflix_users.password com permissao restrita a administradores autenticados.';

commit;
