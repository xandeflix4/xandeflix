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

    // Otimização: Ignorar programas muito antigos ou muito distantes no futuro
    if (stop < sixHoursAgo || start > twentyFourHoursAhead) continue;

    const titleNode = programmeNode.getElementsByTagName('title')[0];
    const descNode = programmeNode.getElementsByTagName('desc')[0];
    const title = normalizeText(titleNode?.textContent) || 'Sem título';

    if (!groupedPrograms[channelId]) {
      groupedPrograms[channelId] = [];
    }

    groupedPrograms[channelId].push({
      id: `${channelId}:${start}:${i}`,
      channelId,
      start,
      stop,
      title,
      description: normalizeText(descNode?.textContent),
    });
  }

  // Ordenação final
  for (const channelId in groupedPrograms) {
    groupedPrograms[channelId].sort((a, b) => a.start - b.start);
  }

  return groupedPrograms;
}
