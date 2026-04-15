-- Xandeflix - Phase 4 Legacy Cleanup
-- Objetivo:
-- 1) Remover usuarios legados sem vinculo com auth.users.
-- 2) Opcionalmente remover os usuarios importados de users.json (ids fixos).
-- 3) Re-sincronizar auth.users -> xandeflix_users para manter apenas usuarios do Supabase Auth.

begin;

-- Diagnostico antes
select
  count(*) as total_profiles,
  count(*) filter (where auth_user_id is not null) as auth_linked_profiles,
  count(*) filter (where auth_user_id is null) as legacy_profiles
from public.xandeflix_users;

-- Etapa 1 (recomendada): remove somente perfis legados (sem auth_user_id)
delete from public.xandeflix_users
where auth_user_id is null
  and role <> 'admin';

-- Etapa 2 (opcional): remove ids do seed legado, mesmo que algum ja tenha sido vinculado.
-- Descomente se quiser remover explicitamente os 3 registros de users.json:
--
-- delete from public.xandeflix_users
-- where id in (
--   '02df2f82-f51a-484b-ba69-a6781d2fa75a', -- alexandre
--   '4440f813-5195-4175-961a-b9e66927fa70', -- janaina
--   'a04789d9-a76f-4291-8ed8-07318dfce4b8'  -- teste
-- )
-- and role <> 'admin';

-- Re-sincroniza auth.users para garantir que apenas usuarios do Auth sejam recriados
-- no catalogo do painel admin.
select * from public.sync_auth_users_to_xandeflix_users();

-- Diagnostico depois
select
  count(*) as total_profiles,
  count(*) filter (where auth_user_id is not null) as auth_linked_profiles,
  count(*) filter (where auth_user_id is null) as legacy_profiles
from public.xandeflix_users;

commit;
