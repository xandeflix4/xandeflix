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

## SQL do Supabase

Execute estes arquivos no SQL Editor do Supabase na ordem:

1. `supabase_setup.sql`
2. `supabase_repair_legacy_schema.sql` se a base for legada
3. `supabase_seed_legacy.sql` se quiser migrar `users.json`
4. `supabase_phase2_auth.sql`
5. `supabase_phase6_adult_access.sql`

## Observações

- O backend Express legado foi removido do runtime.
- O painel admin opera direto no Supabase.
- O controle adulto final usa senha/PIN salvo no Supabase; o TOTP legado não faz mais parte do fluxo suportado.
