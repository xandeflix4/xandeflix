import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

const DEFAULT_REMOTE_TIMEOUT_MS = 120000;

const NATIVE_IPTV_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'User-Agent': 'VLC/3.0.21 LibVLC/3.0.21',
};

const WEB_IPTV_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const XTREAM_IPTV_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; SM-S928B Build/UP1A.231005.007)',
  Connection: 'keep-alive',
};

const MOJIBAKE_PATTERN = /\u{FFFD}|\u00C3[\u0080-\u00BF]/u;
const LATIN1_ALIASES = ['iso-8859-1', 'latin1', 'windows-1252', 'iso_8859-1'];

function extractCharsetFromContentType(contentType: string | undefined | null): string | null {
  if (!contentType) return null;
  const match = contentType.match(/charset=(["']?)([\w-]+)\1/i);
  return match?.[2]?.toLowerCase() || null;
}

function decodeWithFallback(buffer: ArrayBuffer, hintCharset: string | null): string {
  const forceCharset = hintCharset && LATIN1_ALIASES.includes(hintCharset) ? 'windows-1252' : null;

  if (forceCharset) {
    return new TextDecoder(forceCharset, { fatal: false }).decode(buffer);
  }

  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (!MOJIBAKE_PATTERN.test(utf8Text)) {
    return utf8Text;
  }

  console.warn('[Encoding] Mojibake detectado em UTF-8. Re-decodificando como Windows-1252.');
  return new TextDecoder('windows-1252', { fatal: false }).decode(buffer);
}

function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error(`Tempo limite excedido (${timeoutMs}ms).`));
    }, timeoutMs);

    promise
      .then((value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes('tempo limite excedido')
  );
}

function parseContentLength(headers: Record<string, string> | undefined): number | null {
  if (!headers) {
    return null;
  }

  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === 'content-length',
  );
  if (!entry) {
    return null;
  }

  const parsed = Number(entry[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  const normalized = new Headers(headers);
  const result: Record<string, string> = {};

  normalized.forEach((value, key) => {
    result[key] = value;
  });

  return result;
}

export interface RemoteTextStreamSource {
  streamUrl: string;
  cleanup: () => Promise<void>;
}

export interface RemoteTextOptions {
  headers?: HeadersInit;
  timeoutMs?: number;
  preflightHead?: boolean;
  maxContentLengthBytes?: number;
  retryWithoutNativeHeaders?: boolean;
}

export async function prepareRemoteTextStreamSource(
  targetUrl: string,
  options?: RemoteTextOptions,
): Promise<RemoteTextStreamSource> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const customHeaders = headersToRecord(options?.headers);

  if (!Capacitor.isNativePlatform()) {
    return {
      streamUrl: targetUrl,
      cleanup: async () => {},
    };
  }

  const shouldRetryWithAlternateHeaders = options?.retryWithoutNativeHeaders !== false;
  const tempPath = `temp_playlist_${Date.now()}_${Math.random().toString(36).slice(2)}.m3u`;

  if (options?.preflightHead && options.maxContentLengthBytes) {
    try {
      const headResponse = await withRequestTimeout(
        CapacitorHttp.request({
          url: targetUrl,
          method: 'HEAD',
          headers: {
            ...NATIVE_IPTV_HEADERS,
            ...customHeaders,
          },
          connectTimeout: Math.min(timeoutMs, 45000),
          readTimeout: Math.min(timeoutMs, 45000),
        }),
        Math.min(timeoutMs, 45000),
      );

      const contentLength = parseContentLength(headResponse.headers as Record<string, string> | undefined);
      if (contentLength && contentLength > options.maxContentLengthBytes) {
        throw new Error(
          `A playlist vinculada a esta conta e grande demais para sincronizacao no dispositivo (${Math.round(contentLength / (1024 * 1024))} MB).`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('grande demais')) {
        throw error;
      }
    }
  }

  const attempts = [
    { name: 'App Native (Dalvik)', headers: { ...XTREAM_IPTV_HEADERS, ...customHeaders } },
    { name: 'VLC Media Player', headers: { ...NATIVE_IPTV_HEADERS, ...customHeaders } },
    { name: 'Web Browser (Chrome)', headers: { ...WEB_IPTV_HEADERS, ...customHeaders } },
  ];

  let lastError: unknown = null;
  const fetchSessionStart = Date.now();

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const elapsedTotalMs = Date.now() - fetchSessionStart;
    const currentTimeoutMs = Math.max(timeoutMs - elapsedTotalMs, 60000);

    try {
      console.log(`[Fetch] Tentativa ${i + 1}/${attempts.length}: '${attempt.name}' para stream local...`);
      await withRequestTimeout(
        Filesystem.downloadFile({
          url: targetUrl,
          headers: attempt.headers,
          path: tempPath,
          directory: Directory.Cache,
          connectTimeout: currentTimeoutMs,
          readTimeout: currentTimeoutMs,
        }),
        currentTimeoutMs,
      );

      const uriResult = await Filesystem.getUri({
        path: tempPath,
        directory: Directory.Cache,
      });

      return {
        streamUrl: Capacitor.convertFileSrc(uriResult.uri),
        cleanup: async () => {
          try {
            await Filesystem.deleteFile({ path: tempPath, directory: Directory.Cache });
          } catch {
            // ignore cleanup failures
          }
        },
      };
    } catch (error) {
      lastError = error;
      if (!shouldRetryWithAlternateHeaders) {
        break;
      }
      if (i === attempts.length - 1) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Falha ao preparar stream remoto para parser.');
}

export async function fetchRemoteText(
  targetUrl: string,
  options?: RemoteTextOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const customHeaders = headersToRecord(options?.headers);

  if (Capacitor.isNativePlatform()) {
    if (options?.preflightHead && options.maxContentLengthBytes) {
      try {
        const headResponse = await withRequestTimeout(
          CapacitorHttp.request({
            url: targetUrl,
            method: 'HEAD',
            headers: {
              ...NATIVE_IPTV_HEADERS,
              ...customHeaders,
            },
            connectTimeout: Math.min(timeoutMs, 45000),
            readTimeout: Math.min(timeoutMs, 45000),
          }),
          Math.min(timeoutMs, 45000),
        );

        const contentLength = parseContentLength(headResponse.headers as Record<string, string> | undefined);
        if (contentLength && contentLength > options.maxContentLengthBytes) {
          throw new Error(
            `A playlist vinculada a esta conta e grande demais para sincronizacao no dispositivo (${Math.round(contentLength / (1024 * 1024))} MB).`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('grande demais')) {
          throw error;
        }
      }
    }

    const performNativeGet = async (headers: Record<string, string>, attemptTimeoutMs: number) => {
      // Step 1: Download huge 80MB text file natively via Java/OkHttp directly to Android Disk (Bypasses OutOfMemory JSON IPC)
      const downloadResult = await withRequestTimeout(
        Filesystem.downloadFile({
          url: targetUrl,
          headers,
          path: 'temp_playlist.m3u',
          directory: Directory.Cache,
          connectTimeout: attemptTimeoutMs,
          readTimeout: attemptTimeoutMs,
        }),
        attemptTimeoutMs,
      );

      // We only proceed if downloading actually passed
      if (typeof downloadResult === 'object' && 'path' in downloadResult) {
        // Find the native path on Android and convert to a Capacitor Webview URI.
        const uriResult = await Filesystem.getUri({
          path: 'temp_playlist.m3u',
          directory: Directory.Cache
        });

        // The webview wrapper URL looks like "capacitor://localhost/_capacitor_file_/..."
        const webviewUrl = Capacitor.convertFileSrc(uriResult.uri);

        // Step 2: Use Chrome/WebKit native JS `fetch` to read the LOCAL FILE directly into the V8 memory Engine.
        // This effectively reads the full MBs completely inside the Webkit/V8 thread, bypassing the JSON Serializer.
        const res = await fetch(webviewUrl);
        const buffer = await res.arrayBuffer();
        
        // Step 3: Decode using our robust Latin1/UTF-8 fallback directly inside Javascript
        const text = decodeWithFallback(buffer, null);
        
        // Clean up the temp file
        Filesystem.deleteFile({ path: 'temp_playlist.m3u', directory: Directory.Cache }).catch(() => null);

        return {
          status: downloadResult.path ? 200 : 500,
          data: text,
          headers: {}
        };
      }
      
      throw new Error(`File download failed silently: ${JSON.stringify(downloadResult)}`);
    };

    const shouldRetryWithAlternateHeaders = options?.retryWithoutNativeHeaders !== false;

    // Strategy 3-Tier:
    // 1. Dalvik UA (Mimics native Android IPTV apps, high success on Xtream Codes)
    // 2. VLC UA (Standard media player)
    // 3. Chrome UA (Last resort, often blocked but sometimes works on generic servers)
    const attempts = [
      { name: 'App Native (Dalvik)', headers: { ...XTREAM_IPTV_HEADERS, ...customHeaders } },
      { name: 'VLC Media Player', headers: { ...NATIVE_IPTV_HEADERS, ...customHeaders } },
      { name: 'Web Browser (Chrome)', headers: { ...WEB_IPTV_HEADERS, ...customHeaders } },
    ];

    let response;
    let lastError;
    const fetchSessionStart = Date.now();

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const elapsedTotalMs = Date.now() - fetchSessionStart;
      
      // Calculate remaining budget, but guarantee at least 60s for subsequent attempts
      // so a slow block on attempt 1 doesn't instantly kill attempt 2.
      let currentTimeoutMs = Math.max(timeoutMs - elapsedTotalMs, 60000);

      try {
        console.log(`[Fetch] Tentativa ${i + 1}/${attempts.length}: Ocultando como '${attempt.name}'...`);
        response = await performNativeGet(attempt.headers, currentTimeoutMs);
        
        // Se a resposta for um erro HTTP 403 (Cloudflare Block) tentamos o proximo
        if (response.status === 403 || response.status === 401) {
             console.warn(`[Fetch] Servidor bloqueou (HTTP ${response.status}) o UA '${attempt.name}'. Tentando o proximo.`);
             lastError = new Error(`HTTP ${response.status} - Bloqueado pelo servidor.`);
             continue;
        }

        break; // Sucesso, sai do loop
      } catch (err: any) {
        lastError = err;
        
        if (!shouldRetryWithAlternateHeaders) {
          throw err;
        }

        const reason = isTimeoutError(err) ? 'timeout' : `erro: ${err.message}`;
        console.warn(`[Fetch] Falha na tentativa ${i + 1} (${reason}).`);
        
        if (i === attempts.length - 1) {
            console.error(`[Fetch] Todas as ${attempts.length} tentativas esgotadas.`);
            throw err; // Joga o erro da ultima tentativa
        }
      }
    }

    if (!response) {
      throw lastError || new Error('Fetch falhou silenciosamente após todas as tentativas.');
    }

    if (response.status < 200 || response.status >= 300) {
      if (response.status === 404) throw new Error('O link da lista não foi encontrado (404). Verifique se a URL está correta.');
      if (response.status >= 500) throw new Error(`O servidor do provedor está fora do ar ou em manutenção (Erro ${response.status}).`);
      throw new Error(`Erro de conexão com o servidor: HTTP ${response.status}`);
    }

    const rawText = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    return rawText;
  }

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(targetUrl, {
      headers: {
        ...WEB_IPTV_HEADERS,
        ...customHeaders,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) throw new Error('O link da lista não foi encontrado (404). Verifique se a URL está correta.');
      if (response.status >= 500) throw new Error(`O servidor do provedor está com falhas (Erro ${response.status}).`);
      throw new Error(`Falha na conexão: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    const charset = extractCharsetFromContentType(contentType);

    if (charset && LATIN1_ALIASES.includes(charset)) {
      const buffer = await response.arrayBuffer();
      return decodeWithFallback(buffer, charset);
    }

    const buffer = await response.arrayBuffer();
    return decodeWithFallback(buffer, null);
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
