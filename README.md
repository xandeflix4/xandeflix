# Xandeflix

Aplicativo Android-first em React + Capacitor para reproduzir listas IPTV direto no dispositivo, sem VPS para proxy de stream.

## Arquitetura

- `Android app`: autenticação, download nativo da playlist/EPG e reprodução no player nativo.
- `Supabase`: auth, banco, preferências, catálogo resumido e telemetria.
- `Vercel`: opcional para hospedar o painel web/admin.

O fluxo de stream é direto entre o dispositivo e o provedor IPTV.

## Desenvolvimento

Pré-requisitos:

- Node.js
- Android Studio + SDK Android, se for testar no app nativo
- projeto Supabase configurado

Configuração mínima em `.env`:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_TMDB_API_KEY=
CAPACITOR_DEV_SERVER_URL=
```

Variáveis opcionais de hardening do proxy web (`/api/proxy`):

```env
PROXY_ALLOWED_HOSTS=iptv.exemplo.com,*.provedor.tv
PROXY_REQUIRE_ALLOWLIST=true
PROXY_ALLOWED_PORTS=80,443,8080
PROXY_ALLOWED_ORIGINS=https://seu-app.vercel.app
```

Observacao: em `NODE_ENV=production`, o proxy exige whitelist por padrao (`PROXY_REQUIRE_ALLOWLIST=true`).

Rodar o frontend web:

```bash
npm install
npm run dev
```

Build web:

```bash
npm run build
```

Build Android:

```bash
npm run build:android
```

Qualidade de código:

```bash
npm run lint
npm run lint:fix
npm run typecheck:strict
```

## Samsung + Android Studio (tempo real)

Para otimizar em tempo real em um dispositivo Samsung fisico (USB):

1. Ative `Opcoes do desenvolvedor` e `Depuracao USB` no Samsung.
2. Inicie o servidor web local:

```bash
npm run dev
```

3. Em outro terminal, configure o app Android para live reload e `adb reverse`:

```bash
npm run android:realtime:setup
```

4. Abra o projeto no Android Studio:

```bash
npm run android:studio
```

5. No Android Studio:
- Selecione o dispositivo Samsung.
- Execute o app em modo `Debug`.
- Abra `View > Tool Windows > Profiler` para acompanhar CPU, memoria e rede em tempo real.

Observacao: o fluxo usa `CAPACITOR_DEV_SERVER_URL=http://localhost:5173` com `adb reverse`, evitando depender do IP local da maquina.

## SQL do Supabase

Execute estes arquivos no SQL Editor do Supabase na ordem:

1. `supabase_setup.sql`
2. `supabase_repair_legacy_schema.sql` se a base for legada
3. `supabase_seed_legacy.sql` se quiser migrar `users.json`
4. `supabase_phase2_auth.sql`
5. `supabase_phase6_adult_access.sql`
6. `supabase_phase7_rls_hardening.sql` para hardening de RLS, RPC e RBAC (admin-only)

## Observações

- O backend Express legado foi removido do runtime.
- O painel admin opera direto no Supabase.
- O controle adulto final usa senha/PIN salvo no Supabase; o TOTP legado não faz mais parte do fluxo suportado.
