// Vercel serverless function: receives data pushed from local Crucix server
// POST /api/push-data with JSON body → stores to /tmp/latest.json
// GET /api/data → serves from /tmp/latest.json
// Both POST and GET share the same function instance so /tmp is accessible

import { writeFileSync, readFileSync, existsSync } from 'fs';

const TMP_PATH = '/tmp/latest.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    if (!existsSync(TMP_PATH)) {
      return res.status(503).json({ error: 'No data yet — send POST first' });
    }
    try {
      const data = readFileSync(TMP_PATH, 'utf8');
      return res.status(200).json(JSON.parse(data));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const data = req.body;
      if (!data) return res.status(400).json({ error: 'No body' });
      writeFileSync(TMP_PATH, JSON.stringify(data));
      console.log('[push-data] Written timestamp:', data?.meta?.timestamp);
      return res.status(200).json({ ok: true, timestamp: data?.meta?.timestamp });
    } catch (err) {
      console.error('[push-data] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
