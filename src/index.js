import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getAccounts, getAccountDetails, getQuote, getOHLCV, getOpenPositions, getPendingOrders, getDealHistory, getSymbols } from './ctrader.js';
import { getAuthorizationUrl, exchangeCode } from './auth.js';
const server = new Server({ name: 'ctrader-multisniper07', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'get_auth_url', description: 'Gjeneron URL autorizimi cTrader', inputSchema: { type: 'object', properties: {} } },
  { name: 'exchange_auth_code', description: 'Shkemben code me token', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'get_accounts', description: 'Merr llogarite IC Markets', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_account_details', description: 'Balance, equity, margin', inputSchema: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] } },
  { name: 'get_quote', description: 'Cmimi live bid/ask per simbol', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, symbol: { type: 'string' } }, required: ['account_id','symbol'] } },
  { name: 'get_ohlcv', description: 'Candlestick data OHLCV', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, symbol: { type: 'string' }, timeframe: { type: 'string', enum: ['M1','M5','M15','M30','H1','H4','D1','W1','MN1'] }, count: { type: 'number' } }, required: ['account_id','symbol','timeframe'] } },
  { name: 'get_multiframe_data', description: 'W1+D1+H4+H1+M15 njeheresh per ILOS pipeline', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, symbol: { type: 'string' }, timeframes: { type: 'array', items: { type: 'string' } }, count_per_tf: { type: 'number' } }, required: ['account_id','symbol'] } },
  { name: 'get_open_positions', description: 'Pozicionet aktuale', inputSchema: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] } },
  { name: 'get_pending_orders', description: 'Urdhrat pending', inputSchema: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] } },
  { name: 'get_deal_history', description: 'Historiku i trades', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, from_date: { type: 'string' }, to_date: { type: 'string' } }, required: ['account_id'] } },
  { name: 'search_symbols', description: 'Kerko simbole (XAUUSD, BTCUSD etj)', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, query: { type: 'string' } }, required: ['account_id'] } }
]}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    if (name === 'get_auth_url') result = { auth_url: getAuthorizationUrl(), instructions: ['1. Hap URL ne browser', '2. Logo me IC Markets', '3. Kopjo code= nga URL', '4. Thirr exchange_auth_code'] };
    else if (name === 'exchange_auth_code') result = await exchangeCode(args.code);
    else if (name === 'get_accounts') result = await getAccounts();
    else if (name === 'get_account_details') result = await getAccountDetails(args.account_id);
    else if (name === 'get_quote') result = await getQuote(args.account_id, args.symbol);
    else if (name === 'get_ohlcv') result = await getOHLCV(args.account_id, args.symbol, args.timeframe || 'H4', args.count || 100);
    else if (name === 'get_multiframe_data') {
      const tfs = args.timeframes || ['W1','D1','H4','H1','M15'];
      const results = {};
      await Promise.allSettled(tfs.map(async tf => { try { results[tf] = await getOHLCV(args.account_id, args.symbol, tf, args.count_per_tf || 50); } catch(e) { results[tf] = { error: e.message }; } }));
      result = { symbol: args.symbol.toUpperCase(), timestamp: new Date().toISOString(), timeframes: results };
    }
    else if (name === 'get_open_positions') result = await getOpenPositions(args.account_id);
    else if (name === 'get_pending_orders') result = await getPendingOrders(args.account_id);
    else if (name === 'get_deal_history') result = await getDealHistory(args.account_id, args.from_date, args.to_date);
    else if (name === 'search_symbols') {
      const all = await getSymbols(args.account_id);
      const filtered = args.query ? all.filter(s => s.name?.toUpperCase().includes(args.query.toUpperCase())) : all.slice(0,50);
      result = { found: filtered.length, symbols: filtered.map(s => ({ id: s.symbolId, name: s.name, description: s.description })) };
    }
    else throw new Error(`Tool "${name}" nuk njihet.`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: true, message: error.response?.data ? JSON.stringify(error.response.data) : error.message }) }], isError: true };
  }
});
async function main() {
  const missing = ['CTRADER_CLIENT_ID','CTRADER_CLIENT_SECRET'].filter(v => !process.env[v]);
  if (missing.length) { console.error(`Mungojne: ${missing.join(', ')}`); process.exit(1); }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MULTISNIPER07 MCP] Server aktiv');
}
main().catch(e => { console.error(e); process.exit(1); });
