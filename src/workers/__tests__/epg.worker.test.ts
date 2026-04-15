import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelf = {
  postMessage: vi.fn(),
  onmessage: null as any,
};

vi.stubGlobal('self', mockSelf);
vi.stubGlobal('postMessage', mockSelf.postMessage);

await import('../epg.worker');

describe('EPG Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve processar XMLTV válido', async () => {
    const xmlContent = `
<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme channel="HBO" start="20240413100000 +0000" stop="20240413120000 +0000">
    <title>Interestelar</title>
    <desc>Um explorador espacial viaja através de um buraco de minhoca.</desc>
  </programme>
</tv>
    `.trim();

    await mockSelf.onmessage({ data: { xmlText: xmlContent, chunkSize: 100 } } as any);

    const doneMsg = mockSelf.postMessage.mock.calls.find(call => call[0].type === 'DONE');
    expect(doneMsg[0].totalLoaded).toBe(1);
    
    const chunkMsg = mockSelf.postMessage.mock.calls.find(call => call[0].type === 'CHUNK');
    expect(chunkMsg[0].data['HBO']).toBeDefined();
    expect(chunkMsg[0].data['HBO'][0].title).toBe('Interestelar');
  });

  it('deve lidar com tags malformadas ou vazias sem crashar', async () => {
    const malformedXml = `
<tv>
  <programme channel="EXTREME">
    <title></title>
    <desc>Vazio</desc>
  </programme>
  <programme start="123">
    <title>Sem Canal</title>
  </programme>
  <programme channel="VALID" start="20240413100000">
    <title>Valid</title>
  </programme>
</tv>
    `.trim();

    await mockSelf.onmessage({ data: { xmlText: malformedXml } } as any);

    const doneMsg = mockSelf.postMessage.mock.calls.find(call => call[0].type === 'DONE');
    // Deve ignorar os malformados e processar apenas o válido
    expect(doneMsg[0].totalLoaded).toBe(1);
  });

  it('deve enviar erro amigável se o XML for inválido ou nulo', async () => {
    await mockSelf.onmessage({ data: { xmlText: null as any } } as any);

    const errorMsg = mockSelf.postMessage.mock.calls.find(call => call[0].type === 'ERROR');
    expect(errorMsg).toBeDefined();
  });
});
