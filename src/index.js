// src/index.js — MULTISNIPER07 MCP proxy v2.0 (ESM, MCP-compliant)
import express from 'express';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json({ limit: '10mb' }));

const UPSTREAM = 'https://mcp.ctrader.com/trading/mcp';
const SLUG = process.env.CTRADER_MCP_TOKEN;
if (!SLUG) { console.error('FATAL: CTRADER_MCP_TOKEN missing'); process.exit(1); }

const SERVER_INFO = { name: 'MULTISNIPER07 MCP', version: '2.0.0' };
const SUPPORTED_PROTOCOL = '2025-03-26';

const sessions = new Map();
const watches  = new Map();
let toolCache = null;
let toolCacheAt = 0;
const TOOL_TTL_MS = 60 * 60 * 1000;

const newSid = () => randomUUID();

function getOrCreateSid(req) {
  const incoming = req.get('mcp-session-id');
  if (incoming && sessions.has(incoming)) {
    const s = sessions.get(incoming); s.lastSeen = Date.now(); return incoming;
  }
  const sid = newSid();
  sessions.set(sid, { createdAt: Date.now(), lastSeen: Date.now() });
  return sid;
}

function applyHeaders(res, sid) {
  res.setHeader('Mcp-Session-Id', sid);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, mcp-session-id, mcp-protocol-version, authorization');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
}

async function refreshTools() {
  try {
    const r = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + SLUG,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'cache', method: 'tools/list', params: {} }),
    });
    const j = await r.json();
    if (j && j.result && j.result.tools) {
      toolCache = j.result.tools;
      toolCacheAt = Date.now();
      console.log('[cache] ' + toolCache.length + ' tools loaded');
    } else {
      console.error('[cache] failed: ' + JSON.stringify(j).slice(0, 300));
    }
  } catch (e) {
    console.error('[cache] error: ' + e.message);
  }
}

app.options('*', (req, res) => { setCors(res); res.status(204).end(); });

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: SERVER_INFO.name + ' v' + SERVER_INFO.version,
    sessions: sessions.size,
    watches: watches.size,
    toolsCached: toolCache ? toolCache.length : 0,
    uptime: Math.floor(process.uptime()) + 's',
  });
});

app.post('/icmarkets/mcp', async (req, res) => {
  const sid = getOrCreateSid(req);
  applyHeaders(res, sid);
  const body = req.body;
  if (!body || body.jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: (body && body.id) || null, error: { code: -32700, message: 'Parse error' } });
  }
  const id = body.id, method = body.method, params = body.params;

  if (method === 'initialize') {
    const requested = (params && params.protocolVersion) || SUPPORTED_PROTOCOL;
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'cTrader MCP proxy for IC Markets demo. Use tools/list to enumerate, tools/call to invoke.',
      },
    });
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(202).end();
  if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });

  if (method === 'tools/list') {
    if (!toolCache || (Date.now() - toolCacheAt) > TOOL_TTL_MS) await refreshTools();
    return res.json({ jsonrpc: '2.0', id, result: { tools: toolCache || [] } });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    if (name === 'register_watch') {
      const wid = newSid();
      watches.set(wid, Object.assign({ id: wid, createdAt: Date.now() }, (params && params.arguments) || {}));
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Watch registered: ' + wid }] } });
    }
    if (name === 'list_watches') {
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(Array.from(watches.values()), null, 2) }] } });
    }
    try {
      const r = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': 'Bearer ' + SLUG,
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      res.setHeader('Content-Type', 'application/json');
      return res.status(r.status).send(text);
    } catch (e) {
      return res.status(502).json({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Upstream: ' + e.message } });
    }
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not supported: ' + method } });
});

app.get('/icmarkets/mcp', (req, res) => {
  const sid = getOrCreateSid(req);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Mcp-Session-Id', sid);
  setCors(res);
  res.flushHeaders();
  const ka = setInterval(() => res.write(': ka ' + Date.now() + '\n\n'), 15000);
  req.on('close', () => clearInterval(ka));
});

setInterval(() => {
  const now = Date.now(), TTL = 30 * 60 * 1000;
  for (const [sid, s] of sessions) if (now - s.lastSeen > TTL) sessions.delete(sid);
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('[boot] ' + SERVER_INFO.name + ' v' + SERVER_INFO.version + ' on :' + PORT);
  try { await refreshTools(); } catch (e) { console.error('[boot] preload failed: ' + e.message); }
});
