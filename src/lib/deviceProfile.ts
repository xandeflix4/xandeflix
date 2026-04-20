import { Capacitor } from '@capacitor/core';

const TV_USER_AGENT_PATTERNS = [
  /android tv/i,
  /\bgoogle tv\b/i,
  /\bsmart[- ]?tv\b/i,
  /\bhbbtv\b/i,
  /\bbravia\b/i,
  /\bviera\b/i,
  /\bnetcast\b/i,
  /\bweb0s\b/i,
  /\btizen tv\b/i,
  /\bfire tv\b/i,
  /\baft[a-z0-9]+\b/i,
  /\bshield android tv\b/i,
  /\bmibox\b/i,
  /\bchromecast\b/i,
];

export const detectTvEnvironment = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  // DEV: Allow forcing TV mode via URL param (?forceTv=true) for tablet preview.
  // The flag is persisted in sessionStorage so it survives in-app navigation.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('forceTv') === 'true') {
      sessionStorage.setItem('__xf_forceTv', '1');
    } else if (params.get('forceTv') === 'false') {
      sessionStorage.removeItem('__xf_forceTv');
    }
    if (sessionStorage.getItem('__xf_forceTv') === '1') {
      return true;
    }
  } catch {
    // sessionStorage may be unavailable; ignore silently.
  }

  const userAgent = String(navigator.userAgent || '');
  const vendor = String(navigator.vendor || '');
  const deviceSignature = `${userAgent} ${vendor}`;
  const hasTvUserAgent = TV_USER_AGENT_PATTERNS.some((pattern) => pattern.test(deviceSignature));

  // Prioridade 1: User Agent específico de TV (Firestick, Android TV, etc)
  if (hasTvUserAgent) {
    return true;
  }

  // Prioridade 2: Se tem touch, muito provavelmente é um Tablet ou Celular (a menos que seja forçado)
  const hasTouchInput = (navigator.maxTouchPoints || 0) > 0;
  if (hasTouchInput) {
    return false;
  }

  // Fallback: Se não tem touch e a tela é grande, tratamos como ambiente de TV (DPad)
  const viewportWidth = Math.max(window.innerWidth || 0, window.screen?.width || 0);
  const viewportHeight = Math.max(window.innerHeight || 0, window.screen?.height || 0);
  const shortestSide = Math.min(viewportWidth, viewportHeight);
  const longestSide = Math.max(viewportWidth, viewportHeight);

  return shortestSide >= 720 && longestSide >= 1280;
};
