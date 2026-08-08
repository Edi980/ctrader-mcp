import express from 'express';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json({ limit: '10mb' }));

const UPSTREAM = 'https://mcp.ctrader.com/trading/mcp';
const SLUG = process.env.CTRADER_MCP_TOKEN;
if (!SLUG) { console.error('FATAL: CTRADER_MCP_TOKEN missing'); process.exit(1); }

const watches = new Map();

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, mcp-session-id, mcp-protocol-version, authorization');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
}

app.options('*', (req, res) => { setCors(res); res.status(204).end(); });
app.get('/health', (req, res) => res.json({ status: 'ok', watches: watches.size }));

app.get('/icmarkets/mcp', async (req, res) => {
  setCors(res);
  const sid = req.get('mcp-session-id') || randomUUID();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Mcp-Session-Id', sid);
  res.flushHeaders();

  try {
    const up = await fetch(UPSTREAM, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + SLUG, 'Mcp-Session-Id': sid }
    });
    if (!up.ok) return res.end();
    for await (const chunk of up.body) res.write(chunk);
  } catch (e) {
    res.end();
  }
});

app.post('/icmarkets/mcp', async (req, res) => {
  setCors(res);
  const sid = req.get('mcp-session-id');
  if (sid) res.setHeader('Mcp-Session-Id', sid);
  
  const body = req.body;
  if (!body || body.jsonrpc !== '2.0') return res.status(400).json({ error: 'Parse error' });

  const { id, method, params } = body;

  if (method === 'tools/call' && params?.name === 'register_watch') {
    const wid = randomUUID();
    watches.set(wid, { id: wid, createdAt: Date.now(), ...params.arguments });
    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Watch registered: ' + wid }] } });
  }
  if (method === 'tools/call' && params?.name === 'list_watches') {
    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(Array.from(watches.values()), null, 2) }] } });
  }

  try {
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SLUG };
    if (sid) headers['Mcp-Session-Id'] = sid;

    const r = await fetch(UPSTREAM, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();

    if (method === 'tools/list' && r.ok) {
      try {
        const j = JSON.parse(text);
        if (j.result && Array.isArray(j.result.tools)) {
          j.result.tools.push({
            name: 'register_watch',
            description: 'Register a technical condition to monitor (e.g. price crosses level).',
            inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, condition: { type: 'string' } }, required: ['symbol', 'condition'] }
          });
          j.result.tools.push({
            name: 'list_watches',
            description: 'List all currently active technical watches.',
            inputSchema: { type: 'object', properties: {} }
          });
        }
        res.setHeader('Content-Type', 'application/json');
        return res.status(r.status).json(j);
      } catch (e) {}
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('[boot] MULTISNIPER07 on :' + PORT));
