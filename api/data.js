// Vercel serverless function: proxies /api/data to Tailscale local server
// This lets Vercel-hosted jarvis.html get real-time data from the local Crucix server

const TAILSCALE_URL = 'https://desktop-tatot3u.tailf401c5.ts.net';

export default async function handler(req, res) {
  try {
    const response = await fetch(`${TAILSCALE_URL}/api/data`, {
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Upstream error', detail: response.statusText });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/data] Proxy error:', err.message);
    return res.status(503).json({ error: 'Data unavailable', detail: err.message });
  }
}
