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

  const userAgent = String(navigator.userAgent || '');
  const vendor = String(navigator.vendor || '');
  const deviceSignature = `${userAgent} ${vendor}`;
  const hasTvUserAgent = TV_USER_AGENT_PATTERNS.some((pattern) => pattern.test(deviceSignature));

  if (hasTvUserAgent) {
    return true;
  }

  if (!Capacitor.isNativePlatform()) {
    return false;
  }

  const viewportWidth = Math.max(window.innerWidth || 0, window.screen?.width || 0);
  const viewportHeight = Math.max(window.innerHeight || 0, window.screen?.height || 0);
  const shortestSide = Math.min(viewportWidth, viewportHeight);
  const longestSide = Math.max(viewportWidth, viewportHeight);
  const hasTouchInput = (navigator.maxTouchPoints || 0) > 0;
  const coarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const looksLikeTvViewport = shortestSide >= 720 && longestSide >= 1280;

  return looksLikeTvViewport && !hasTouchInput && !coarsePointer;
};
