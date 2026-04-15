if (typeof globalThis === 'undefined') {
  (window as any).globalThis = window;
}
// Protecao contra quebra por promessas nao tratadas no WebView
window.addEventListener('unhandledrejection', (event) => {
  console.warn('Unhandled promise rejection capturado:', event.reason);
  event.preventDefault();
});

import { getLastCrash, initGlobalExceptionHandler } from './lib/crashReporter';
initGlobalExceptionHandler();

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { ensureFreshBuildState } from './lib/appBootstrapCache';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Elemento #root nao encontrado no bootstrap.');
}

const shouldUseStrictMode = import.meta.env.DEV && !Capacitor.isNativePlatform();
const isNativePlatform = Capacitor.isNativePlatform();
const root = createRoot(rootElement);
const BOOTSTRAP_STEP_TIMEOUT_MS = 12000;
const APP_MOUNT_FLAG_KEY = '__xandeflixAppMounted';

async function runStepWithTimeout<T>(
  stepName: string,
  operation: Promise<T>,
  timeoutMs = BOOTSTRAP_STEP_TIMEOUT_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timeout na etapa de bootstrap: ${stepName}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

const resolveErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Falha desconhecida durante o bootstrap do app.';
};

const renderBootstrapFailure = (error: unknown) => {
  const message = resolveErrorMessage(error);

  root.render(
    <div
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#000',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        padding: 24,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 900,
          border: '2px solid rgba(239,68,68,0.65)',
          backgroundColor: 'rgba(239,68,68,0.12)',
          borderRadius: 14,
          padding: 26,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 38, lineHeight: 1.2, fontWeight: 900, color: '#f87171' }}>
          Erro Critico ao Iniciar
        </h1>
        <p style={{ marginTop: 12, marginBottom: 8, fontSize: 22, fontWeight: 700 }}>
          Limpe os dados do app e recarregue.
        </p>
        <p style={{ marginTop: 0, marginBottom: 20, fontSize: 14, color: 'rgba(255,255,255,0.8)' }}>
          Detalhes: {message}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            minWidth: 170,
            minHeight: 46,
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.25)',
            backgroundColor: '#ef4444',
            color: '#fff',
            fontSize: 17,
            fontWeight: 800,
            cursor: 'pointer',
            padding: '10px 20px',
          }}
        >
          Recarregar
        </button>
      </div>
    </div>,
  );
};

const renderMountWatchdogOverlay = (message: string) => {
  if (document.getElementById('__xandeflix_mount_watchdog__')) {
    return;
  }

  const panel = document.createElement('div');
  panel.id = '__xandeflix_mount_watchdog__';
  panel.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'background:#050505',
      'color:#ffffff',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'padding:24px',
      'text-align:center',
    ].join(';'),
  );
  panel.innerHTML = `<div style="max-width:900px;border:2px solid rgba(239,68,68,0.75);background:rgba(239,68,68,0.12);border-radius:14px;padding:24px;">
    <h1 style="margin:0 0 10px 0;color:#f87171;font-size:34px;font-weight:900;">Watchdog de Render Ativado</h1>
    <p style="margin:0 0 8px 0;font-size:20px;font-weight:800;">O React nao confirmou montagem inicial.</p>
    <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85);">${message}</p>
  </div>`;
  document.body.appendChild(panel);
};

const clearNativeServiceWorkerState = async () => {
  if (!isNativePlatform) {
    return;
  }

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch (error) {
    console.warn('[Bootstrap] Falha ao remover service workers nativos:', error);
  }

  try {
    if ('caches' in window) {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map((cacheKey) => caches.delete(cacheKey)));
    }
  } catch (error) {
    console.warn('[Bootstrap] Falha ao limpar Cache Storage nativo:', error);
  }
};


const bootstrap = async () => {
  try {
    console.info('[Bootstrap] Iniciando bootstrap principal.');
    await runStepWithTimeout('clearNativeServiceWorkerState', clearNativeServiceWorkerState(), 4000);
    await runStepWithTimeout('ensureFreshBuildState', ensureFreshBuildState(), 8000);
    console.info('[Bootstrap] Cache inicial validado.');

    const importedAppModule = await runStepWithTimeout('import(App.tsx)', import('./App.tsx'));
    console.log('[Bootstrap] Modulo App carregado:', {
      moduleType: typeof importedAppModule,
      moduleKeys: Object.keys(importedAppModule || {}),
    });

    const App = importedAppModule.default;
    console.log('[Bootstrap] Tipo do App default:', typeof App);
    if (typeof App !== 'function') {
      throw new Error(`Export default de App.tsx invalido: ${typeof App}`);
    }

    console.info('[Bootstrap] App importado. Renderizando UI.');

    const app = (
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    );

    (window as any)[APP_MOUNT_FLAG_KEY] = false;
    const appTree = shouldUseStrictMode ? <StrictMode>{app}</StrictMode> : app;
    const appSymbol = String((app as any)?.$$typeof ?? '<undefined>');
    const appTreeSymbol = String((appTree as any)?.$$typeof ?? '<undefined>');
    console.log('[Bootstrap] React element symbols:', {
      appSymbol,
      appTreeSymbol,
    });
    if (isNativePlatform) {
      flushSync(() => {
        root.render(appTree);
      });
    } else {
      root.render(appTree);
    }
    console.info('[Bootstrap] Render inicial concluido.');

    window.setTimeout(() => {
      const rootHtmlLength = rootElement.innerHTML.length;
      const rootChildCount = rootElement.childElementCount;
      const mountConfirmed = Boolean((window as any)[APP_MOUNT_FLAG_KEY]);
      const rootPreview = rootElement.innerHTML.slice(0, 220).replace(/\s+/g, ' ').trim();
      console.log(
        `[Bootstrap] Watchdog de montagem: mounted=${mountConfirmed} rootChildCount=${rootChildCount} rootHtmlLength=${rootHtmlLength} rootPreview=${rootPreview || '<vazio>'}`,
      );

      if (mountConfirmed) {
        return;
      }

      const crash = getLastCrash();
      const crashSummary = crash
        ? `${crash.message}${crash.source ? ` (${crash.source}:${crash.lineno ?? 0})` : ''}`
        : 'Nenhum crash global registrado.';
      const watchdogMessage = 'Nenhum efeito de montagem do App foi detectado em ate 4.5s.';
      console.error(`[Bootstrap] ${watchdogMessage} Crash: ${crashSummary}`);
      renderMountWatchdogOverlay(`${watchdogMessage} Crash: ${crashSummary}`);
    }, 4500);
  } catch (error) {
    console.error('[Bootstrap] Falha ao carregar App.tsx:', error);
    renderBootstrapFailure(error);
  }
};

void bootstrap();
