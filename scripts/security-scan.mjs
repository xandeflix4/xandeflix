#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();

const TEXT_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.html',
  '.css',
  '.md',
  '.sql',
  '.yml',
  '.yaml',
  '.sh',
  '.env',
  '.txt',
]);

const SKIP_PATHS = [
  'node_modules/',
  'dist/',
  'android/',
  '.git/',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
];

const ALLOWED_LITERAL_SUBSTRINGS = [
  'https://placeholder.supabase.co',
  'https://xxxxx.supabase.co',
  'users.xandeflix.example.com',
  'VITE_SUPABASE_URL=',
  'VITE_SUPABASE_ANON_KEY=',
  'VITE_TMDB_API_KEY=',
  'SUPABASE_ANON_KEY=',
  'TMDB_API_KEY=',
  'Supabase URL (https://xxxxx.supabase.co)',
];

const JWT_LIKE_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const SUPABASE_URL_RE = /https:\/\/[a-z0-9-]+\.supabase\.co\b/i;
const TMDB_KEY_ASSIGN_RE = /(?:VITE_)?TMDB_API_KEY\s*[:=]\s*['"]?[a-f0-9]{32}\b/i;
const SUPABASE_ANON_ASSIGN_RE = /(?:VITE_)?SUPABASE_ANON_KEY\s*[:=]\s*['"]?eyJ[A-Za-z0-9_.-]+/i;

function shouldSkipPath(filePath) {
  return SKIP_PATHS.some((prefix) => filePath === prefix || filePath.startsWith(prefix));
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
  if (!ext) return true;
  return false;
}

function isAllowedLine(line) {
  return ALLOWED_LITERAL_SUBSTRINGS.some((allowed) => line.includes(allowed));
}

function getTrackedFiles() {
  const output = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => !shouldSkipPath(filePath))
    .filter((filePath) => isTextFile(filePath));
}

function scanFile(filePath) {
  const absolutePath = path.join(cwd, filePath);
  let content = '';

  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return [];
  }

  const findings = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (!line.trim() || isAllowedLine(line)) return;

    const checks = [
      {
        ok: JWT_LIKE_RE.test(line) && /supabase|anon|master_key|api[_ -]?key|token/i.test(line),
        reason: 'JWT-like token hardcoded',
      },
      {
        ok: SUPABASE_ANON_ASSIGN_RE.test(line),
        reason: 'Supabase anon key assignment hardcoded',
      },
      {
        ok: TMDB_KEY_ASSIGN_RE.test(line),
        reason: 'TMDB API key assignment hardcoded',
      },
      {
        ok:
          SUPABASE_URL_RE.test(line) &&
          /\.(ts|tsx|js|jsx|mjs|cjs|html)$/i.test(filePath) &&
          !/example|placeholder|xxxxx/i.test(line),
        reason: 'Supabase URL hardcoded in source file',
      },
    ];

    checks.forEach((check) => {
      if (check.ok) {
        findings.push({ filePath, lineNo, reason: check.reason, snippet: line.trim().slice(0, 200) });
      }
    });
  });

  return findings;
}

function main() {
  const trackedFiles = getTrackedFiles();
  const findings = [];

  for (const filePath of trackedFiles) {
    findings.push(...scanFile(filePath));
  }

  if (findings.length === 0) {
    console.log('Security scan passed: no hardcoded secrets detected in tracked source files.');
    process.exit(0);
  }

  console.error('Security scan failed: possible hardcoded secrets found.');
  for (const finding of findings) {
    console.error(`- ${finding.filePath}:${finding.lineNo} [${finding.reason}]`);
  }
  process.exit(1);
}

main();
