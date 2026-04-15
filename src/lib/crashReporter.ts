/**
 * Xandeflix Global Crash Reporter
 * Captures unhandled errors and rejections, persisting them to localStorage
 * to help debug crashes on hardware like Firestick/Android TV.
 */

const CRASH_KEY = 'XANDEFLIX_LAST_CRASH';

export interface CrashReport {
  message: string;
  stack?: string;
  source?: string;
  lineno?: number;
  colno?: number;
  timestamp: string;
  userAgent: string;
}

/**
 * Initializes global exception handlers as early as possible.
 */
export function initGlobalExceptionHandler() {
  if (typeof window === 'undefined') return;

  // Handle Synchronous Errors (and some async)
  window.onerror = function(message, source, lineno, colno, error) {
    const report: CrashReport = {
      message: String(message),
      stack: error?.stack,
      source: String(source),
      lineno,
      colno,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent
    };
    
    saveCrash(report);
    return false; // Let browser handle it too
  };

  // Handle Unhandled Promise Rejections
  window.onunhandledrejection = function(event) {
    const report: CrashReport = {
      message: `Unhandled Rejection: ${event.reason?.message || event.reason}`,
      stack: event.reason?.stack,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent
    };

    saveCrash(report);
  };

  console.log('[SRE] Global Exception Handlers Initialized.');
}

function saveCrash(report: CrashReport) {
  try {
    localStorage.setItem(CRASH_KEY, JSON.stringify(report));
  } catch (e) {
    console.error('[SRE] Failed to save crash report to localStorage', e);
  }
}

/**
 * Retrieves the last captured crash report.
 */
export function getLastCrash(): CrashReport | null {
  try {
    const data = localStorage.getItem(CRASH_KEY);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

/**
 * Clears the crash report from storage.
 */
export function clearLastCrash() {
  localStorage.removeItem(CRASH_KEY);
}
