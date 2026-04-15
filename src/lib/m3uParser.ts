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

/**
 * Função simplificada para uso direto no Store
 */
export function parseM3U(content: string): PlaylistItem[] {
  if (!content || !content.includes('#EXTM3U')) {
    return [];
  }

  const lines = content.split('\n');
  const items: PlaylistItem[] = [];
  let currentItem: Partial<PlaylistItem> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const idMatch = line.match(/tvg-id="([^"]*)"/i);
      const commaIndex = line.lastIndexOf(',');
      const title = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : 'Canal Sem Título';

      currentItem = {
        id: idMatch ? idMatch[1] : `item-${i}`,
        logo: logoMatch ? logoMatch[1] : '',
        group: groupMatch ? groupMatch[1] : 'OUTROS',
        title: title
      };
    } else if (line.startsWith('http')) {
      if (currentItem.title) {
        items.push({
          id: currentItem.id || `stream-${items.length}`,
          title: currentItem.title,
          group: currentItem.group || 'CANAIS',
          logo: currentItem.logo || '',
          url: line
        });
        currentItem = {};
      }
    }
  }

  return items;
}
