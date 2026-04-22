import { Media, MediaType, PlaylistItem } from '../types';

/**
 * M3U Parser de Alta Performance (O(n))
 */
export class M3UParser {
  static normalizeCategoryTitle(title: string): string {
    return (title || 'GERAL')
      .trim()
      .replace(/^-(.*)-$/, '$1')
      .trim()
      .toUpperCase();
  }

  static parseAttributes(attributesStr: string, name: string, lineNumber: number): Partial<Media> {
    const media: Partial<Media> = {
      id: `m3u-${lineNumber}`,
      title: name,
      category: 'GERAL',
      type: MediaType.LIVE,
    };

    const regex = /([\w-]+)="([^"]*)"/g;
    let match;
    while ((match = regex.exec(attributesStr)) !== null) {
      const key = match[1].toLowerCase();
      const value = match[2];

      if (key === 'tvg-id') media.id = value;
      if (key === 'tvg-logo') media.thumbnail = value;
      if (key === 'group-title') media.category = this.normalizeCategoryTitle(value);
    }

    return media;
  }
}

export interface M3UParseResult {
  items: PlaylistItem[];
  epgUrl: string | null;
}

function normalizeHeaderHintName(rawName: string): string {
  const key = String(rawName || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/_/g, '-')
    .toLowerCase();

  if (!key) return '';
  if (key === 'user-agent' || key === 'http-user-agent') return 'User-Agent';
  if (key === 'referer' || key === 'referrer' || key === 'http-referer' || key === 'http-referrer') return 'Referer';
  if (key === 'origin' || key === 'http-origin') return 'Origin';
  if (key === 'cookie' || key === 'http-cookie') return 'Cookie';
  if (key === 'authorization' || key === 'http-authorization') return 'Authorization';

  return key
    .split('-')
    .map((segment) => (segment ? `${segment[0].toUpperCase()}${segment.slice(1)}` : segment))
    .join('-');
}

function parseHeaderHintLine(line: string): { name: string; value: string } | null {
  const prefixIndex = line.indexOf(':');
  if (prefixIndex < 0) return null;

  const payload = line.slice(prefixIndex + 1).trim();
  if (!payload) return null;

  const equalsIndex = payload.indexOf('=');
  if (equalsIndex <= 0) return null;

  const rawName = payload.slice(0, equalsIndex).trim();
  const rawValue = payload.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!rawValue) return null;

  const name = normalizeHeaderHintName(rawName);
  if (!name) return null;

  return { name, value: rawValue };
}

function appendHeaderHintsToUrl(rawUrl: string, headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  if (entries.length === 0) return rawUrl;

  const serialized = entries
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  if (!serialized) return rawUrl;

  if (rawUrl.includes('|')) {
    return `${rawUrl}&${serialized}`;
  }

  return `${rawUrl}|${serialized}`;
}

/**
 * Função simplificada para uso direto no Store
 */
export function parseM3U(content: string): M3UParseResult {
  if (!content || !content.includes('#EXTM3U')) {
    return { items: [], epgUrl: null };
  }

  const lines = content.split('\n');
  const items: PlaylistItem[] = [];
  let epgUrl: string | null = null;
  let currentItem: Partial<PlaylistItem> = {};
  let currentHeaderHints: Record<string, string> = {};

  // Extrair EPG URL do cabeçalho #EXTM3U
  const firstLine = lines.find(l => l.startsWith('#EXTM3U'));
  if (firstLine) {
    const epgMatch = firstLine.match(/url-tvg="([^"]*)"/i);
    if (epgMatch) epgUrl = epgMatch[1];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const idMatch = line.match(/tvg-id="([^"]*)"/i);
      const nameMatch = line.match(/tvg-name="([^"]*)"/i);
      const commaIndex = line.lastIndexOf(',');
      const title = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : 'Canal Sem Título';

      currentItem = {
        id: idMatch ? idMatch[1] : `item-${i}`,
        logo: logoMatch ? logoMatch[1] : '',
        group: groupMatch ? groupMatch[1] : 'OUTROS',
        title: title,
        tvgId: idMatch ? idMatch[1] : undefined,
        tvgName: nameMatch ? nameMatch[1] : undefined,
      };
      currentHeaderHints = {};
    } else if (line.toUpperCase().startsWith('#EXTVLCOPT:') || line.toUpperCase().startsWith('#KODIPROP:')) {
      if (currentItem.title) {
        const parsedHeader = parseHeaderHintLine(line);
        if (parsedHeader) {
          currentHeaderHints[parsedHeader.name] = parsedHeader.value;
        }
      }
    } else if (line.startsWith('http')) {
      if (currentItem.title) {
        const finalUrl = appendHeaderHintsToUrl(line, currentHeaderHints);
        items.push({
          id: currentItem.id || `stream-${items.length}`,
          title: currentItem.title,
          group: currentItem.group || 'CANAIS',
          logo: currentItem.logo || '',
          url: finalUrl,
          tvgId: currentItem.tvgId,
          tvgName: currentItem.tvgName,
        });
        currentItem = {};
        currentHeaderHints = {};
      }
    }
  }

  return { items, epgUrl };
}
