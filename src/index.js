import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MCP_UPSTREAM = 'https://mcp.ctrader.com/trading/mcp';
const REQ_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'];
const RES_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version'];

// ── OAuth shim (personal, single-user — kënaq handshake-un e Claude.ai, s'kufizon akses real) ──
const clients = new Map();
const authCodes = new Map();
const accessTokens = new Map();

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function baseUrl(req) { return `${req.protocol}://${req.get('host')}`; }

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post']
  });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = baseUrl(req);
  res.json({ resource: `${base}/icmarkets/mcp`, authorization_servers: [base] });
});

app.post('/register', (req, res) => {
  const client_id = randomToken(12);
  const client_secret = randomToken(24);
  const redirect_uris = req.body?.redirect_uris || [];
  clients.set(client_id, { redirect_uris });
  res.status(201).json({
    client_id, client_secret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  });
});

app.get('/authorize', (req, res) => {
  const { redirect_uri } = req.query;
  if (!redirect_uri) return res.status(400).send('Missing redirect_uri');
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#111;color:#eee;">
      <h2>Autorizo Claude.ai</h2>
      <p>Lejo aksesin te Ctrader Trading MCP (të dhëna cTrader/IC Markets)?</p>
      <a href="/authorize/confirm?${new URLSearchParams(req.query).toString()}"
         style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;">Lejo</a>
    </body></html>
  `);
});

app.get('/authorize/confirm', (req, res) => {
  const { redirect_uri, state, code_challenge } = req.query;
  const code = randomToken(24);
  authCodes.set(code, { code_challenge, expires: Date.now() + 5 * 60 * 1000 });
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/token', (req, res) => {
  const { grant_type, code, code_verifier } = req.body;
  if (grant_type === 'authorization_code') {
    const entry = authCodes.get(code);
    if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'invalid_grant' });
    if (entry.code_challenge) {
      const hash = crypto.createHash('sha256').update(code_verifier || '').digest('base64url');
      if (hash !== entry.code_challenge) return res.status(400).json({ error: 'invalid_grant' });
    }
    authCodes.delete(code);
    const access_token = randomToken(32);
    const refresh = randomToken(32);
    accessTokens.set(access_token, { expires: Date.now() + 3600 * 1000 });
    return res.json({ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh });
  }
  if (grant_type === 'refresh_token') {
    const access_token = randomToken(32);
    accessTokens.set(access_token, { expires: Date.now() + 3600 * 1000 });
    return res.json({ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token: req.body.refresh_token });
  }
  res.status(400).json({ error: 'unsupported_grant_type' });
});
// ── Fund OAuth shim ──

async function proxyToUpstream(req, res) {
  try {
    const token = process.env.CTRADER_MCP_TOKEN;
    if (!token) {
      return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Missing CTRADER_MCP_TOKEN env variable' }, id: null });
    }
    const headers = { 'Authorization': `Bearer ${token}` };
    for (const h of REQ_HEADERS) { if (req.headers[h]) headers[h] = req.headers[h]; }
    const fetchOptions = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') fetchOptions.body = JSON.stringify(req.body);
    const upstream = await fetch(MCP_UPSTREAM, fetchOptions);
    res.status(upstream.status);
    for (const h of RES_HEADERS) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
    const text = await upstream.text();
    res.send(text);
  } catch (err) {
    console.error('Proxy error:', err);
    if (!res.headersSent) res.status(502).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Proxy error: ' + err.message }, id: null });
  }
}

app.all('/icmarkets/mcp', proxyToUpstream);
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'MULTISNIPER07 MCP v1.0' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[MULTISNIPER07 MCP] Server aktiv ne port ${PORT}`));

