import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Falta o parametro URL' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Erro ao buscar URL: ${response.statusText}` });
    }

    const contentType = response.headers.get('content-type');
    const content = await response.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); // Cache no Edge por 1 hora
    
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    return res.status(200).send(content);
  } catch (error: any) {
    console.error('[Proxy Error]:', error);
    return res.status(500).json({ error: error.message || 'Erro interno no proxy' });
  }
}
