import type { EPGProgram } from '../types';

function normalizeText(value: string | null | undefined): string {
  return (value || '').trim();
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

export function parseXMLTV(xmlString: string): Record<string, EPGProgram[]> {
  const xmlSource = normalizeText(xmlString);
  if (!xmlSource || typeof DOMParser === 'undefined') {
    return {};
  }

  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlSource, 'application/xml');
  const groupedPrograms: Record<string, EPGProgram[]> = {};
  
  // 1. Mapear IDs de canais para Display Names
  const channelNodes = xml.getElementsByTagName('channel');
  const channelIdToNames: Record<string, string[]> = {};
  for (let i = 0; i < channelNodes.length; i++) {
    const channelNode = channelNodes[i];
    const id = normalizeText(channelNode.getAttribute('id'));
    if (!id) continue;
    
    const displayNames: string[] = [];
    const nameNodes = channelNode.getElementsByTagName('display-name');
    for (let j = 0; j < nameNodes.length; j++) {
      const name = normalizeText(nameNodes[j].textContent);
      if (name) displayNames.push(name);
    }
    channelIdToNames[id] = displayNames;
  }

  const programmeNodes = xml.getElementsByTagName('programme');
  const now = Date.now();
  const sixHoursAgo = now - (6 * 60 * 60 * 1000);
  const twentyFourHoursAhead = now + (24 * 60 * 60 * 1000);

  for (let i = 0; i < programmeNodes.length; i++) {
    const programmeNode = programmeNodes[i];
    const channelId = normalizeText(programmeNode.getAttribute('channel'));
    const start = parseXmltvTimestamp(programmeNode.getAttribute('start'));
    const stop = parseXmltvTimestamp(programmeNode.getAttribute('stop')) || start;

    if (!channelId || start === null || stop === null) continue;
    if (stop < sixHoursAgo || start > twentyFourHoursAhead) continue;

    const titleNode = programmeNode.getElementsByTagName('title')[0];
    const descNode = programmeNode.getElementsByTagName('desc')[0];
    const title = normalizeText(titleNode?.textContent) || 'Sem título';

    const program: EPGProgram = {
      id: `${channelId}:${start}:${i}`,
      channelId,
      start,
      stop,
      title,
      description: normalizeText(descNode?.textContent),
    };

    // Indexar pelo ID original (normalizado para lowercase)
    const normalizedId = channelId.toLowerCase();
    if (!groupedPrograms[normalizedId]) groupedPrograms[normalizedId] = [];
    groupedPrograms[normalizedId].push(program);

    // Indexar por todos os Display Names (normalizados para lowercase)
    const names = channelIdToNames[channelId] || [];
    names.forEach(name => {
      const normalizedName = name.toLowerCase();
      if (normalizedName !== normalizedId) {
        if (!groupedPrograms[normalizedName]) groupedPrograms[normalizedName] = [];
        groupedPrograms[normalizedName].push(program);
      }
    });
  }

  // Ordenação final e remoção de duplicatas por canal
  for (const key in groupedPrograms) {
    groupedPrograms[key].sort((a, b) => a.start - b.start);
  }

  return groupedPrograms;
}
