import { useEffect, useState } from 'react';

interface UseEmbeddableTrailerKeyOptions {
  timeoutMs?: number;
}

export const useEmbeddableTrailerKey = (
  rawTrailerKey: string | null | undefined,
  options?: UseEmbeddableTrailerKeyOptions,
) => {
  const [embeddableTrailerKey, setEmbeddableTrailerKey] = useState<string | null>(null);

  useEffect(() => {
    const normalizedRawValue = String(rawTrailerKey || '').trim();
    const normalizedKey = normalizedRawValue
      .replace(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=/i, '')
      .replace(/^https?:\/\/youtu\.be\//i, '')
      .split('&')[0]
      .split('?')[0]
      .trim();

    if (!normalizedKey) {
      setEmbeddableTrailerKey(null);
      return;
    }

    // YouTube IDs are typically 11 chars [A-Za-z0-9_-].
    if (!/^[A-Za-z0-9_-]{11}$/.test(normalizedKey)) {
      setEmbeddableTrailerKey(null);
      return;
    }

    setEmbeddableTrailerKey(normalizedKey);

  }, [rawTrailerKey]);

  return {
    trailerKey: embeddableTrailerKey,
    status: embeddableTrailerKey ? 'available' : 'idle',
    reason: 'ready',
    isChecking: false,
    isEmbeddable: !!embeddableTrailerKey,
  };
};
