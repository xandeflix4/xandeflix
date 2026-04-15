/**
 * Utilitario de Limpeza de Titulos para IPTV (Xandeflix)
 * Remove "sujeira" tecnica das listas e extrai metadados para busca no TMDB.
 */

export interface CleanedMedia {
  cleanTitle: string;
  year?: string;
  originalTitle: string;
}

export const cleanMediaTitle = (rawTitle: string): CleanedMedia => {
  if (!rawTitle) return { cleanTitle: '', originalTitle: '' };

  let title = rawTitle;

  // 1. Extrair o ano se estiver entre parenteses (ex: "Movie Name (2024)")
  const yearMatch = title.match(/\((\d{4})\)/);
  const year = yearMatch ? yearMatch[1] : undefined;

  // 2. Remover o ano e parenteses do titulo para a limpeza
  title = title.replace(/\(\d{4}\)/g, '');

  // 3. Remover Tags de Categoria/Lançamento (Ex: |LANCAMENTOS|, [VOD], |ACAO|)
  title = title.replace(/\|[^|]+\||\[[^\]]+\]/g, '');

  // 4. Remover Resoluções e Qualidade (case insensitive)
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

  // 6. Limpeza final de espaços extras e caracteres residuais
  title = title
    .replace(/\s+/g, ' ')           // Espaços duplos
    .replace(/^\s+|\s+$/g, '')      // Trim
    .replace(/^[-.| ]+|[-.| ]+$/g, '') // Caracteres especiais no inicio/fim
    .trim();

  if (title.length === 0) {
    title = rawTitle.trim();
  }

  return {
    cleanTitle: title,
    year,
    originalTitle: rawTitle
  };
};
