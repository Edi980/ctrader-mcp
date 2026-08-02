import axios from 'axios';
import { getAccessToken } from './auth.js';
const BASE_URL = 'https://openapi.ctrader.com';
async function apiClient() {
  const token = await getAccessToken();
  return axios.create({ baseURL: BASE_URL, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 });
}
export async function getAccounts() { const c = await apiClient(); const r = await c.get('/v2/tradingaccounts'); return r.data; }
export async function getAccountDetails(id) { const c = await apiClient(); const r = await c.get(`/v2/tradingaccounts/${id}`); return r.data; }
export async function getSymbols(id) { const c = await apiClient(); const r = await c.get(`/v2/tradingaccounts/${id}/symbols`); return r.data; }
export async function getQuote(accountId, symbolName) {
  const c = await apiClient();
  const sr = await c.get(`/v2/tradingaccounts/${accountId}/symbols`);
  const symbol = sr.data.find(s => s.name?.toUpperCase() === symbolName.toUpperCase());
  if (!symbol) throw new Error(`Simboli "${symbolName}" nuk u gjet.`);
  const qr = await c.get(`/v2/tradingaccounts/${accountId}/symbols/${symbol.symbolId}/quote`);
  return { symbol: symbolName.toUpperCase(), bid: qr.data.bid, ask: qr.data.ask, spread: (qr.data.ask - qr.data.bid).toFixed(5), timestamp: new Date().toISOString() };
}
export async function getOHLCV(accountId, symbolName, timeframe = 'H4', count = 100) {
  const c = await apiClient();
  const sr = await c.get(`/v2/tradingaccounts/${accountId}/symbols`);
  const symbol = sr.data.find(s => s.name?.toUpperCase() === symbolName.toUpperCase());
  if (!symbol) throw new Error(`Simboli "${symbolName}" nuk u gjet.`);
  const r = await c.get(`/v2/tradingaccounts/${accountId}/symbols/${symbol.symbolId}/trendbars`, { params: { period: timeframe, toTimestamp: Date.now(), count: Math.min(count, 500) } });
  return { symbol: symbolName.toUpperCase(), timeframe, count: r.data.length, bars: r.data.map(b => ({ time: new Date(b.timestamp).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), latest: r.data[r.data.length-1] || null };
}
export async function getOpenPositions(id) { const c = await apiClient(); const r = await c.get(`/v2/tradingaccounts/${id}/positions`); return r.data; }
export async function getPendingOrders(id) { const c = await apiClient(); const r = await c.get(`/v2/tradingaccounts/${id}/orders`); return r.data; }
export async function getDealHistory(id, from, to) { const c = await apiClient(); const r = await c.get(`/v2/tradingaccounts/${id}/deals`, { params: { fromTimestamp: from ? new Date(from).getTime() : Date.now()-7*86400000, toTimestamp: to ? new Date(to).getTime() : Date.now() } }); return r.data; }
