import 'dotenv/config';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getAccounts, getAccountDetails, getQuote, getOHLCV, getOpenPositions, getPendingOrders, getDealHistory, getSymbols } from './ctrader.js';
import { getAuthorizationUrl, exchangeCode } from './auth.js';

const app = express();
app.use(express.json());

app.get('/.well-known/mcp', (req, res) => {
  res.json({
    name: 'MULTISNIPER07 MCP',
    version: '1.0.0',
    description: 'cTrader IC Markets live data for MULTISNIPER07',
    mcp_version: '1.0',
    endpoints: { sse: '/sse', messages: '/messages', mcp: '/mcp', icmarkets: '/icmarkets/mcp' }
  });
});

function createMCPServer() {
  const server = new Server({ name: 'ctrader-multisniper07', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'get_auth_url', description: 'Gjeneron URL autorizimi cTrader', inputSchema: { type: 'object', properties: {} } },
    { name: 'exchange_auth_code', description: 'Shkemben code me token', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
    { name: 'get_accounts', description: 'Merr llogarite IC Markets', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_account_details', description: 'Balance equity margin', inputSchema: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] } },
    { name: 'get_quote', description: 'Cmimi live bid ask per simbol', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, symbol: { type: 'string' } }, required: ['account_id','symbol'] } },
    { name: 'get_ohlcv', description: 'Candlestick OHLCV data', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, symbol: { type: 'string' }, timeframe: { type: 'string' }, count: { type: 'number' } }, required: ['account_id','symbol','timeframe'] } },
    { name: 'get_multiframe_data', description: 'W1 D1 H4 H1 M15 njeheresh per ILOS', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, symbol: { type: 'string' }, timeframes: { type: 'array', items: { type: 'string' } } }, required: ['account_id','symbol'] } },
    { name: 'get_open_positions', description: 'Pozicionet aktuale', inputSchema: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] } },
    { name: 'search_symbols', description: 'Kerko simbole XAUUSD BTCUSD', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, query: { type: 'string' } }, required: ['account_id'] } }
  ]}));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      if (name === 'get_auth_url') result = { auth_url: getAuthorizationUrl() };
      else if (name === 'exchange_auth_code') result = await exchangeCode(args.code);
      else if (name === 'get_accounts') result = await getAccounts();
      else if (name === 'get_account_details') result = await getAccountDetails(args.account_id);
      else if (name === 'get_quote') result = await getQuote(args.account_id, args.symbol);
      else if (name === 'get_ohlcv') result = await getOHLCV(args.account_id, args.symbol, args.timeframe||'H4', args.count||100);
      else if (name === 'get_multiframe_data') {
        const tfs = args.timeframes||['W1','D1','H4','H1','M15'];
        const results = {};
        await Promise.allSettled(tfs.map(async tf => { try { results[tf] = await getOHLCV(args.account_id, args.symbol, tf, 50); } catch(e) { results[tf]={error:e.message}; } }));
        result = { symbol: args.symbol.toUpperCase(), timestamp: new Date().toISOString(), timeframes: results };
      }
      else if (name === 'get_open_positions') result = await getOpenPositions(args.account_id);
      else if (name === 'search_symbols') {
        const all = await getSymbols(args.account_id);
        const filtered = args.query ? all.filter(s=>s.name?.toUpperCase().includes(args.query.toUpperCase())) : all.slice(0,50);
        result = { found: filtered.length, symbols: filtered.map(s=>({id:s.symbolId,name:s.name})) };
      }
      else throw new Error(`Tool "${name}" nuk njihet.`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch(error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: true, message: error.message }) }], isError: true };
    }
  });
  return server;
}

const transports = {};
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => { delete transports[transport.sessionId]; });
  const server = createMCPServer();
  await server.connect(transport);
});
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (transport) { await transport.handlePostMessage(req, res); }
  else { res.status(400).json({ error: 'Session not found' }); }
});

app.post('/mcp', async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    const server = createMCPServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});
app.get('/mcp', (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

app.post('/icmarkets/mcp', async (req, res) => {
  try {
    const token = process.env.CTRADER_MCP_TOKEN;
    if (!token) {
      return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Missing CTRADER_MCP_TOKEN env variable' }, id: null });
    }
    const upstream = await fetch('https://mcp.ctrader.com/trading/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': req.headers['accept'] || 'application/json, text/event-stream',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(req.body)
    });
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const text = await upstream.text();
    res.send(text);
  } catch (err) {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.status(502).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Proxy error: ' + err.message }, id: null });
    }
  }
});
app.get('/icmarkets/mcp', (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'MULTISNIPER07 MCP v1.0' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[MULTISNIPER07 MCP] Server aktiv ne port ${PORT}`));
