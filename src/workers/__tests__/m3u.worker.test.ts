import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelf = {
  postMessage: vi.fn(),
  onmessage: null as any,
};

vi.stubGlobal('self', mockSelf);
vi.stubGlobal('postMessage', mockSelf.postMessage);

await import('../m3u.worker');

describe('M3U Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve processar uma lista M3U valida e enviar CHUNKs', async () => {
    const m3uContent = `
#EXTM3U
#EXTINF:-1 tvg-id="CNN" group-title="Noticias",CNN Brasil
http://stream.com/cnn
#EXTINF:-1 tvg-id="HBO" group-title="Filmes",HBO HD
http://stream.com/hbo
    `.trim();

    await mockSelf.onmessage({ data: { m3uText: m3uContent, batchSize: 1 } } as any);

    expect(mockSelf.postMessage).toHaveBeenCalled();

    const calls = mockSelf.postMessage.mock.calls;
    const chunkMessages = calls.filter((call) => call[0].type === 'CHUNK');
    const doneMessage = calls.find((call) => call[0].type === 'DONE');

    expect(chunkMessages.length).toBeGreaterThan(0);
    expect(doneMessage).toBeDefined();
    expect(doneMessage?.[0].count).toBe(2);
  });

  it('deve lidar com stress test de 50.000 itens', async () => {
    let largeM3U = '#EXTM3U\n';
    for (let i = 0; i < 50000; i += 1) {
      largeM3U += `#EXTINF:-1 tvg-id="id${i}" group-title="Stress",Channel ${i}\nhttp://stream.com/${i}\n`;
    }

    await mockSelf.onmessage({ data: { m3uText: largeM3U, batchSize: 10000 } } as any);

    const doneMessage = mockSelf.postMessage.mock.calls.find((call) => call[0].type === 'DONE');
    expect(doneMessage?.[0].count).toBe(50000);
  });

  it('deve capturar erros e enviar mensagem amigavel', async () => {
    await mockSelf.onmessage({ data: { m3uText: null as any } } as any);

    const errorMessage = mockSelf.postMessage.mock.calls.find((call) => call[0].type === 'ERROR');
    expect(errorMessage).toBeDefined();
    expect(errorMessage?.[0].message).toBeDefined();
  });
});
