/**
 * Utilitario de Limpeza de Titulos para IPTV (Xandeflix)
 * Remove "sujeira" tecnica das listas e extrai metadados para busca no TMDB.
 */

export interface CleanedMedia {
  cleanTitle: string;
  year?: string;
  originalTitle: string;
  season?: number;
  episode?: number;
  isSeries?: boolean;
}

export const extractSeriesInfo = (title: string): { cleanTitle: string, season?: number, episode?: number } => {
  let clean = title;
  let season: number | undefined;
  let episode: number | undefined;

  // Padrões comuns: S01E01, S01 E01, EP 01, T1 E1, etc.
  const patterns = [
    /s(\d+)\s*e(\d+)/i,           // S01E01 ou S01 E01
    /t(\d+)\s*e(\d+)/i,           // T01E01 ou T01 E01
    /s(\d+)\s*ep(\d+)/i,          // S01EP01
    /ep(\d+)/i,                  // EP01 (Assume season 1 se não houver)
    /cap(?:itulo)?\s*(\d+)/i,    // CAP 01 ou Capitulo 01
    /temporada\s*(\d+).*episodio\s*(\d+)/i, // Temporada 1 Episodio 1
    /season\s*(\d+).*episode\s*(\d+)/i      // Season 1 Episode 1
  ];

  for (const p of patterns) {
    const m = clean.match(p);
    if (m) {
      if (m[2]) {
        season = parseInt(m[1], 10);
        episode = parseInt(m[2], 10);
      } else {
        // Casos como EP01 sem temporada explícita
        season = 1;
        episode = parseInt(m[1], 10);
      }
      clean = clean.replace(p, '').trim();
      break;
    }
  }

  return { cleanTitle: clean, season, episode };
};

export const cleanMediaTitle = (rawTitle: string): CleanedMedia => {
  if (!rawTitle) return { cleanTitle: '', originalTitle: '' };

  const seriesInfo = extractSeriesInfo(rawTitle);
  let title = seriesInfo.cleanTitle;
  let year: string | undefined;

  // 1. Extrair o ano em vários formatos possíveis
  const yearPatterns = [
    /\((\d{4})\)/,        // (2024)
    /\[(\d{4})\]/,        // [2024]
    /\s(\d{4})(?:\s|$)/,  // " 2024 " ou " 2024" no final
    /-\s*(\d{4})(?:\s|$)/ // "- 2024" ou "-2024"
  ];

  for (const pattern of yearPatterns) {
    const match = title.match(pattern);
    if (match) {
      const candidate = match[1];
      const yearNum = parseInt(candidate, 10);
      if (yearNum >= 1900 && yearNum <= 2100) {
        year = candidate;
        title = title.replace(pattern, ' ');
        break;
      }
    }
  }

  // 2. Remover Tags de Categoria/Lançamento
  title = title.replace(/\|[^|]+\||\[[^\]]+\]/g, ' ');

  // 4. Remover Resoluções e Qualidade
  const technicalTags = [
    /\bFHD\b/gi, /\b4K\b/gi, /\b1080P\b/gi, /\b720P\b/gi, /\bHD\b/gi, 
    /\bSD\b/gi, /\bUHD\b/gi, /\bCAM\b/gi, /\bTS\b/gi, /\bWEB-DL\b/gi, /\bBLURAY\b/gi
  ];
  technicalTags.forEach(regex => {
    title = title.replace(regex, '');
  });

  // 5. Remover Idiomas e Dublagem
  const localeTags = [
    /\bLEG\b/gi, /\bDUBLADO\b/gi, /\bLEGENDADO\b/gi, /\bDUAL\b/gi, 
    /\bPT-BR\b/gi, /\bPORTUGUES\b/gi, /\bH264\b/gi, /\bH265\b/gi, /\bx264\b/gi
  ];
  localeTags.forEach(regex => {
    title = title.replace(regex, '');
  });

  // 6. Limpeza final
  title = title
    .replace(/\s+/g, ' ')           
    .replace(/^\s+|\s+$/g, '')      
    .replace(/^[-.| ]+|[-.| ]+$/g, '') 
    .trim();

  if (title.length === 0) {
    title = rawTitle.trim();
  }

  return {
    cleanTitle: title,
    year,
    originalTitle: rawTitle,
    season: seriesInfo.season,
    episode: seriesInfo.episode,
    isSeries: seriesInfo.season !== undefined
  };
};
