/**
 * EPG Worker - Optimized for huge XMLTV files
 * Processes XML tags iteratively without inflating a full DOM tree
 */

interface EPGProgram {
  id: string;
  start: number;
  stop: number;
  title: string;
  description: string;
}

interface WorkerTask {
  xmlText: string;
  chunkSize?: number;
}

function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function parseXmltvTimestamp(value: string | null): number | null {
  const rawValue = normalizeText(value);
  if (!rawValue) {
    return null;
  }

  const match = rawValue.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}|Z))?/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, zone] = match;
  const baseUtcTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  if (!zone || zone === 'Z') {
    return baseUtcTime;
  }

  const sign = zone.startsWith('-') ? -1 : 1;
  const offsetHours = Number(zone.slice(1, 3));
  const offsetMinutes = Number(zone.slice(3, 5));
  const offsetMs = sign * ((offsetHours * 60) + offsetMinutes) * 60 * 1000;

  return baseUtcTime - offsetMs;
}

if (typeof self !== 'undefined') {
  self.onmessage = async (e: MessageEvent<WorkerTask>) => {
  const { xmlText, chunkSize = 1000 } = e.data; // Reduzido de 2000 para 1000 para evitar OOM

  if (!xmlText || typeof xmlText !== 'string' || xmlText.trim().length === 0) {
    self.postMessage({ type: 'ERROR', message: 'O arquivo de guia (EPG) está vazio ou é inválido.' });
    return;
  }

  const MAX_EPG_PROGRAMS = 100000; // Limite maximo para EPG

  try {
    let totalItemsProcessed = 0;
    let itemsInCurrentChunk = 0;
    let pendingChunk: Record<string, EPGProgram[]> = {};

    const flushChunk = () => {
      if (Object.keys(pendingChunk).length > 0) {
        self.postMessage({
          type: 'CHUNK',
          data: pendingChunk,
          totalLoaded: totalItemsProcessed
        });
        pendingChunk = {};
        itemsInCurrentChunk = 0;
        
        // Ajuda garbage collector
        if (typeof (globalThis as any).gc === 'function') {
          (globalThis as any).gc();
        }
      }
    };

    // Regex capture for <programme channel="..." start="..." stop="..."> ... </programme>
    // [^>]*? for attributes to be non-greedy
    // [\s\S]*? for inner content to match everything including newlines
    const programmeRegex = /<programme([^>]+)>([\s\S]*?)<\/programme>/g;

    // Sub-regex for attributes and tags inside <programme>
    const attrRegex = /(\w+)="([^"]*)"/g;
    const titleRegex = /<title[^>]*>([\s\S]*?)<\/title>/;
    const descRegex = /<desc[^>]*>([\s\S]*?)<\/desc>/;

    let match;
    while ((match = programmeRegex.exec(xmlText)) !== null) {
      // Verifica limite para evitar OOM
      if (totalItemsProcessed >= MAX_EPG_PROGRAMS) {
        self.postMessage({ 
          type: 'ERROR', 
          message: `Guia EPG excede limite de ${MAX_EPG_PROGRAMS} programas. Contato o administrador.` 
        });
        return;
      }

      const attrString = match[1];
      const innerContent = match[2];

      // Parse attributes
      let channelId = '';
      let startStr = '';
      let stopStr = '';

      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrString)) !== null) {
        const key = attrMatch[1];
        const val = attrMatch[2];
        if (key === 'channel') channelId = val;
        else if (key === 'start') startStr = val;
        else if (key === 'stop') stopStr = val;
      }

      if (!channelId) continue;

      const start = parseXmltvTimestamp(startStr);
      const stop = parseXmltvTimestamp(stopStr);

      if (start === null) continue;

      // Parse title and desc
      const titleMatch = innerContent.match(titleRegex);
      const descMatch = innerContent.match(descRegex);

      const title = normalizeText(titleMatch ? titleMatch[1] : 'Programação indisponível');
      const description = normalizeText(descMatch ? descMatch[1] : '');

      if (!pendingChunk[channelId]) {
        pendingChunk[channelId] = [];
      }

      pendingChunk[channelId].push({
        id: `${channelId}:${start}:${totalItemsProcessed}`,
        start,
        stop: stop ?? start,
        title,
        description,
      });

      totalItemsProcessed++;
      itemsInCurrentChunk++;

      if (itemsInCurrentChunk >= chunkSize) {
        flushChunk();
        // Yield thread for potential termination
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Final flush
    flushChunk();
    self.postMessage({ type: 'DONE', totalLoaded: totalItemsProcessed });

  } catch (error: any) {
    const errorMsg = error.message || 'Erro inesperado ao processar o guia EPG.';
    self.postMessage({ type: 'ERROR', message: `EPG Error: ${errorMsg}` });
  }
};
}
