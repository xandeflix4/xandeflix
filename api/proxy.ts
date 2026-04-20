import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { VercelRequest, VercelResponse } from '@vercel/node';

type ProxyError = Error & { status?: number };

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = toBoundedInt(process.env.PROXY_FETCH_TIMEOUT_MS, 15000, 1000, 120000);
const MAX_RESPONSE_BYTES = toBoundedInt(process.env.PROXY_MAX_RESPONSE_BYTES, 15 * 1024 * 1024, 1024, 100 * 1024 * 1024);
const MAX_REDIRECTS = toBoundedInt(process.env.PROXY_MAX_REDIRECTS, 3, 0, 8);
const REQUIRE_HOST_ALLOWLIST =
  String(process.env.PROXY_REQUIRE_ALLOWLIST || '').trim().toLowerCase() === 'true' ||
  process.env.NODE_ENV === 'production';

const ALLOWED_HOST_PATTERNS = parseCsv(process.env.PROXY_ALLOWED_HOSTS);
const ALLOWED_ORIGINS = parseCsv(process.env.PROXY_ALLOWED_ORIGINS);
const ALLOWED_PORTS = parsePortSet(process.env.PROXY_ALLOWED_PORTS);

function toBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function parseCsv(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function parsePortSet(raw: string | undefined): Set<number> {
  const ports = new Set<number>();
  const values = parseCsv(raw);
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      ports.add(parsed);
    }
  }
  return ports;
}

function httpError(status: number, message: string): ProxyError {
  const error = new Error(message) as ProxyError;
  error.status = status;
  return error;
}

function shouldAllowOrigin(originHeader: string | undefined): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  if (!originHeader) return true;

  const origin = originHeader.toLowerCase();
  return ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
}

function applyCorsHeaders(req: VercelRequest, res: VercelResponse): void {
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return;
  }

  if (originHeader && shouldAllowOrigin(originHeader)) {
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Vary', 'Origin');
  }
}

function isHttpRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAllowedHostByPattern(hostname: string): boolean {
  if (ALLOWED_HOST_PATTERNS.length === 0) {
    return !REQUIRE_HOST_ALLOWLIST;
  }

  const host = hostname.toLowerCase();
  return ALLOWED_HOST_PATTERNS.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === pattern;
  });
}

function normalizeIPv4Mapped(ip: string): string {
  const value = ip.trim().toLowerCase();
  if (!value.startsWith('::ffff:')) {
    return value;
  }

  const mapped = value.slice('::ffff:'.length);
  if (isIP(mapped) === 4) {
    return mapped;
  }

  return value;
}

function isPrivateIPv4(ipv4: string): boolean {
  const parts = ipv4.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;

  return false;
}

function isPrivateIPv6(ipv6: string): boolean {
  const value = ipv6.trim().toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // ULA fc00::/7
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true; // fe80::/10
  if (value.startsWith('ff')) return true; // multicast ff00::/8
  return false;
}

function isDisallowedIpAddress(ipAddress: string): boolean {
  const normalized = normalizeIPv4Mapped(ipAddress);
  const family = isIP(normalized);

  if (family === 4) {
    return isPrivateIPv4(normalized);
  }

  if (family === 6) {
    return isPrivateIPv6(normalized);
  }

  return true;
}

async function assertPublicResolvableHost(hostname: string): Promise<void> {
  const host = hostname.trim().toLowerCase();

  if (!host) {
    throw httpError(400, 'Host de destino invalido.');
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw httpError(403, 'Destino bloqueado pela politica de seguranca do proxy.');
  }

  if (isIP(host) !== 0) {
    if (isDisallowedIpAddress(host)) {
      throw httpError(403, 'Destino bloqueado pela politica de seguranca do proxy.');
    }
    return;
  }

  let records: Array<{ address: string }>;
  try {
    records = (await lookup(host, { all: true, verbatim: true })) as Array<{ address: string }>;
  } catch {
    throw httpError(400, 'Nao foi possivel resolver o host informado.');
  }

  if (records.length === 0) {
    throw httpError(400, 'Host de destino sem endereco IP resolvido.');
  }

  for (const record of records) {
    if (isDisallowedIpAddress(record.address)) {
      throw httpError(403, 'Destino bloqueado pela politica de seguranca do proxy.');
    }
  }
}

function assertUrlPolicy(targetUrl: URL): void {
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    throw httpError(400, 'Apenas protocolos HTTP/HTTPS sao permitidos.');
  }

  if (targetUrl.username || targetUrl.password) {
    throw httpError(400, 'URL com credenciais embutidas nao e permitida.');
  }

  if (REQUIRE_HOST_ALLOWLIST && ALLOWED_HOST_PATTERNS.length === 0) {
    throw httpError(503, 'Proxy sem whitelist configurada. Defina PROXY_ALLOWED_HOSTS.');
  }

  if (!isAllowedHostByPattern(targetUrl.hostname)) {
    throw httpError(403, 'Host nao permitido pela whitelist do proxy.');
  }

  if (ALLOWED_PORTS.size > 0) {
    const resolvedPort = targetUrl.port
      ? Number(targetUrl.port)
      : targetUrl.protocol === 'https:'
      ? 443
      : 80;

    if (!ALLOWED_PORTS.has(resolvedPort)) {
      throw httpError(403, 'Porta nao permitida pela politica do proxy.');
    }
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw httpError(504, 'Timeout ao buscar URL no proxy.');
    }
    throw httpError(502, 'Falha ao conectar ao host remoto.');
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function fetchWithValidatedRedirects(initialUrl: URL): Promise<Response> {
  let currentUrl = initialUrl;

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    assertUrlPolicy(currentUrl);
    await assertPublicResolvableHost(currentUrl.hostname);

    const response = await fetchWithTimeout(currentUrl.toString());
    if (!isHttpRedirectStatus(response.status)) {
      return response;
    }

    const redirectLocation = response.headers.get('location');
    if (!redirectLocation) {
      throw httpError(502, 'Redirecionamento remoto sem cabecalho Location.');
    }

    if (attempt === MAX_REDIRECTS) {
      throw httpError(502, 'Quantidade maxima de redirecionamentos excedida.');
    }

    try {
      currentUrl = new URL(redirectLocation, currentUrl);
    } catch {
      throw httpError(502, 'URL de redirecionamento invalida.');
    }
  }

  throw httpError(502, 'Falha inesperada ao processar redirecionamento.');
}

function parseUrlQueryParam(urlParam: string | string[] | undefined): string {
  if (typeof urlParam === 'string') {
    return urlParam.trim();
  }

  if (Array.isArray(urlParam) && typeof urlParam[0] === 'string') {
    return urlParam[0].trim();
  }

  return '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!shouldAllowOrigin(originHeader)) {
    return res.status(403).json({ error: 'Origem nao permitida pelo proxy.' });
  }

  applyCorsHeaders(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader(
    'X-Proxy-Policy',
    ALLOWED_HOST_PATTERNS.length > 0 ? 'allowlist' : REQUIRE_HOST_ALLOWLIST ? 'allowlist-required-not-configured' : 'public-only',
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Metodo nao permitido. Use GET.' });
  }

  const rawUrl = parseUrlQueryParam(req.query.url);
  if (!rawUrl) {
    return res.status(400).json({ error: 'Falta o parametro url.' });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'Parametro url invalido.' });
  }

  try {
    const response = await fetchWithValidatedRedirects(targetUrl);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Erro ao buscar URL: HTTP ${response.status}` });
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        return res.status(413).json({ error: 'Conteudo remoto excede limite maximo permitido.' });
      }
    }

    const bodyBuffer = Buffer.from(await response.arrayBuffer());
    if (bodyBuffer.length > MAX_RESPONSE_BYTES) {
      return res.status(413).json({ error: 'Conteudo remoto excede limite maximo permitido.' });
    }

    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    return res.status(200).send(bodyBuffer);
  } catch (error: any) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const message = typeof error?.message === 'string' ? error.message : 'Erro interno no proxy.';

    if (status >= 500) {
      console.error('[Proxy Error]:', error);
    }

    return res.status(status).json({ error: message });
  }
}
