import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const usersFile = path.join(rootDir, 'users.json');
const globalOverridesFile = path.join(rootDir, 'globalOverrides.json');
const outputFile = path.join(rootDir, 'supabase_seed_legacy.sql');

function escapeSqlString(value) {
  return value.replace(/'/g, "''");
}

function sqlString(value) {
  if (value == null) {
    return 'null';
  }

  return `'${escapeSqlString(String(value))}'`;
}

function sqlBoolean(value) {
  return value ? 'true' : 'false';
}

function sqlJson(value) {
  return `'${escapeSqlString(JSON.stringify(value ?? {}))}'::jsonb`;
}

function sqlTextArray(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 'array[]::text[]';
  }

  return `array[${values.map((value) => sqlString(value)).join(', ')}]::text[]`;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeUser(user) {
  return {
    id: String(user.id),
    name: String(user.name?.trim() || user.username?.trim() || 'Usuario'),
    username: String(user.username?.trim() || user.id),
    password: user.password?.trim() || null,
    playlistUrl: user.playlistUrl?.trim() || '',
    isBlocked: Boolean(user.isBlocked),
    role: user.role === 'admin' ? 'admin' : 'user',
    lastAccess: user.lastAccess?.trim() || null,
    hiddenCategories: Array.isArray(user.hiddenCategories) ? user.hiddenCategories : [],
    categoryOverrides: user.categoryOverrides || {},
    mediaOverrides: user.mediaOverrides || {},
    adultPassword: user.adultPassword?.trim() || null,
    adultTotpSecret: user.adultTotpSecret?.trim() || null,
    adultTotpEnabled: Boolean(user.adultTotpEnabled && user.adultTotpSecret),
  };
}

function buildUserUpsertSql(user) {
  return [
    'insert into public.xandeflix_users (',
    '  id,',
    '  auth_user_id,',
    '  email,',
    '  access_id,',
    '  name,',
    '  username,',
    '  password,',
    '  playlist_url,',
    '  is_blocked,',
    '  role,',
    '  last_access,',
    '  hidden_categories,',
    '  category_overrides,',
    '  media_overrides,',
    '  adult_password,',
    '  adult_totp_secret,',
    '  adult_totp_enabled',
    ')',
    'values (',
    `  ${sqlString(user.id)},`,
    '  null,',
    '  null,',
    `  ${sqlString(user.username)},`,
    `  ${sqlString(user.name)},`,
    `  ${sqlString(user.username)},`,
    `  ${sqlString(user.password)},`,
    `  ${sqlString(user.playlistUrl)},`,
    `  ${sqlBoolean(user.isBlocked)},`,
    `  ${sqlString(user.role)},`,
    `  ${sqlString(user.lastAccess)},`,
    `  ${sqlTextArray(user.hiddenCategories)},`,
    `  ${sqlJson(user.categoryOverrides || {})},`,
    `  ${sqlJson(user.mediaOverrides || {})},`,
    `  ${sqlString(user.adultPassword)},`,
    `  ${sqlString(user.adultTotpSecret)},`,
    `  ${sqlBoolean(user.adultTotpEnabled)}`,
    ')',
    'on conflict (username) do update',
    'set access_id = excluded.access_id,',
    '    name = excluded.name,',
    '    password = coalesce(excluded.password, public.xandeflix_users.password),',
    '    playlist_url = excluded.playlist_url,',
    '    is_blocked = excluded.is_blocked,',
    '    role = excluded.role,',
    '    last_access = excluded.last_access,',
    '    hidden_categories = excluded.hidden_categories,',
    '    category_overrides = excluded.category_overrides,',
    '    media_overrides = excluded.media_overrides,',
    '    adult_password = coalesce(excluded.adult_password, public.xandeflix_users.adult_password),',
    '    adult_totp_secret = coalesce(excluded.adult_totp_secret, public.xandeflix_users.adult_totp_secret),',
    '    adult_totp_enabled = excluded.adult_totp_enabled,',
    "    updated_at = timezone('utc', now());",
  ].join('\n');
}

function buildGlobalOverrideUpsertSql(titleMatch, override) {
  return [
    'insert into public.global_media_overrides (',
    '  title_match,',
    '  override_data',
    ')',
    'values (',
    `  ${sqlString(titleMatch)},`,
    `  ${sqlJson(override)}`,
    ')',
    'on conflict (title_match) do update',
    'set override_data = excluded.override_data,',
    "    updated_at = timezone('utc', now());",
  ].join('\n');
}

function main() {
  const users = readJsonFile(usersFile, []);
  const globalOverrides = readJsonFile(globalOverridesFile, {});

  const normalizedUsers = users
    .filter((user) => user && typeof user === 'object' && user.id && user.username)
    .map((user) => normalizeUser(user));

  const sqlBlocks = [
    '-- Xandeflix - Legacy seed generated from users.json',
    '-- Execute este arquivo depois de supabase_setup.sql.',
    `-- Gerado em ${new Date().toISOString()}.`,
    '',
    'begin;',
    '',
    '-- Usuarios legados',
  ];

  if (normalizedUsers.length === 0) {
    sqlBlocks.push('-- Nenhum usuario legado encontrado.');
  } else {
    sqlBlocks.push(...normalizedUsers.map((user) => buildUserUpsertSql(user)));
  }

  sqlBlocks.push('', '-- Global media overrides');

  const overrideEntries = Object.entries(globalOverrides);
  if (overrideEntries.length === 0) {
    sqlBlocks.push('-- Nenhum global override encontrado.');
  } else {
    sqlBlocks.push(
      ...overrideEntries.map(([titleMatch, override]) =>
        buildGlobalOverrideUpsertSql(titleMatch, override),
      ),
    );
  }

  sqlBlocks.push(
    '',
    '-- Garantir preferencias para todos os usuarios sincronizados',
    'insert into public.user_preferences (user_id)',
    'select xu.id',
    'from public.xandeflix_users xu',
    'on conflict (user_id) do nothing;',
    '',
    'commit;',
    '',
  );

  fs.writeFileSync(outputFile, `${sqlBlocks.join('\n\n')}\n`, 'utf8');

  console.log(`[supabase:seed:legacy] Seed gerado em ${outputFile}`);
  console.log(`[supabase:seed:legacy] Usuarios incluidos: ${normalizedUsers.length}`);
  console.log(`[supabase:seed:legacy] Global overrides incluidos: ${overrideEntries.length}`);
}

main();
