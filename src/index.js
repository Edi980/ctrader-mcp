import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json());

const MCP_UPSTREAM = 'https://mcp.ctrader.com/trading/mcp';
const REQ_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'];
const RES_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version'];

async function proxyToUpstream(req, res) {
  try {
    const token = process.env.CTRADER_MCP_TOKEN;
    if (!token) {
      return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Missing CTRADER_MCP_TOKEN env variable' }, id: null });
    }
    const headers = { 'Authorization': `Bearer ${token}` };
    for (const h of REQ_HEADERS) { if (req.headers[h]) headers[h] = req.headers[h]; }

    const fetchOptions = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(MCP_UPSTREAM, fetchOptions);
    res.status(upstream.status);
    for (const h of RES_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const text = await upstream.text();
    res.send(text);
  } catch (err) {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.status(502).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Proxy error: ' + err.message }, id: null });
    }
  }
}

app.all('/icmarkets/mcp', proxyToUpstream);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'MULTISNIPER07 MCP v1.0' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[MULTISNIPER07 MCP] Server aktiv ne port ${PORT}`));
