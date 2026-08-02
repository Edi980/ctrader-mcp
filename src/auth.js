import axios from 'axios';
const CTRADER_TOKEN_URL = 'https://openapi.ctrader.com/apps/token';
let tokenCache = { access_token: null, refresh_token: null, expires_at: null };
export async function getAccessToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at - 60000) return tokenCache.access_token;
  const response = await axios.post(CTRADER_TOKEN_URL, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.CTRADER_REFRESH_TOKEN, client_id: process.env.CTRADER_CLIENT_ID, client_secret: process.env.CTRADER_CLIENT_SECRET }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  tokenCache = { access_token: response.data.access_token, refresh_token: response.data.refresh_token || tokenCache.refresh_token, expires_at: Date.now() + (response.data.expires_in * 1000) };
  return tokenCache.access_token;
}
export function getAuthorizationUrl() {
  return `https://openapi.ctrader.com/apps/auth?${new URLSearchParams({ client_id: process.env.CTRADER_CLIENT_ID, redirect_uri: process.env.CTRADER_REDIRECT_URI || 'https://localhost:3000/callback', response_type: 'code', scope: 'trading' }).toString()}`;
}
export async function exchangeCode(code) {
  const response = await axios.post(CTRADER_TOKEN_URL, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.CTRADER_REDIRECT_URI || 'https://localhost:3000/callback', client_id: process.env.CTRADER_CLIENT_ID, client_secret: process.env.CTRADER_CLIENT_SECRET }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  tokenCache = { access_token: response.data.access_token, refresh_token: response.data.refresh_token, expires_at: Date.now() + (response.data.expires_in * 1000) };
  return response.data;
}
