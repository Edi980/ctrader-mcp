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

// ── OAuth shim ──
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
      <p>Lejo aksesin te Ctrader Trading MCP?</p>
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

// ── SMT BUNDLES (nga tool_mapping.md §7) ──
const SMT_BUNDLES = {
  XAUUSD: { primary: 'XAGUSD', inverse: 'EURUSD' },
  XAGUSD: { primary: 'XAUUSD', inverse: 'EURUSD' },
  BTCUSD: { primary: 'ETHUSD', inverse: null },
  ETHUSD: { primary: 'BTCUSD', inverse: null },
  NAS100: { primary: 'SPX500', inverse: null },
  US30:   { primary: 'SPX500', inverse: null },
  EURUSD: { primary: 'GBPUSD', inverse: null },
  GBPUSD: { primary: 'EURUSD', inverse: null },
};

// ── WATCH STATE ──
const activeWatches = new Map();

// ── MCP TOOL CALLER (via proxy) ──
async function callMcpTool(toolName, args, sessionId) {
  const token = process.env.CTRADER_MCP_TOKEN;
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args }
  };
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const r = await fetch(MCP_UPSTREAM, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await r.text();

  // parse SSE ose JSON direkt
  if (text.includes('data:')) {
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.replace('data:', '').trim());
        if (parsed.result) return parsed.result;
      } catch {}
    }
  }
  try {
    const parsed = JSON.parse(text);
    return parsed.result || parsed;
  } catch {
    return null;
  }
}

// ── TELEGRAM ──
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: 'missing_env' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    return await r.json();
  } catch (err) {
    console.error('[TELEGRAM] Gabim:', err.message);
    return { ok: false, error: err.message };
  }
}

app.get('/test-telegram', async (req, res) => {
  const result = await sendTelegram(
    '✅ <b>TEST — MULTISNIPER07</b>\nServeri u lidh me sukses me Telegram.\n🟢 Live dhe gati.'
  );
  res.json(result);
});

// ── ATR CALCULATOR ──
function calcATR(candles, period = 14) {
  if (!candles || candles.length < 2) return 1;
  const trs = candles.slice(-period).map(c => c.high - c.low);
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ── WICK CLASSIFIER ──
function classifyWick(candle, atr, direction) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (body === 0 || range === 0) return 'none';

  let wick;
  if (direction === 'buy') {
    wick = Math.min(candle.open, candle.close) - candle.low;
  } else {
    wick = candle.high - Math.max(candle.open, candle.close);
  }

  const wickRatio = wick / body;
  const closesStrong = direction === 'buy'
    ? candle.close >= candle.high - 0.25 * range
    : candle.close <= candle.low + 0.25 * range;
  const isDisplacement = range >= 1.5 * atr;

  // WICK I FORTË: fluturim real (3x + mbyllje fort + displacement)
  if (wickRatio >= 3 && closesStrong && isDisplacement) return 'strong';
  // WICK I BUTË: refuzim normal
  if (wickRatio >= 2) return 'soft';
  return 'none';
}

// ── ENGULFING CLASSIFIER ──
function classifyEngulfing(candles, direction, timeframe) {
  if (!candles || candles.length < 2) return 'none';
  const curr = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const currBody = Math.abs(curr.close - curr.open);
  const prevBody = Math.abs(prev.close - prev.open);
  if (prevBody === 0) return 'none';

  const isBullishEngulf = direction === 'buy' &&
    curr.close > prev.open &&
    curr.open < prev.close &&
    curr.close > prev.open;

  const isBearishEngulf = direction === 'sell' &&
    curr.close < prev.open &&
    curr.open > prev.close;

  const engulfs = isBullishEngulf || isBearishEngulf;
  if (!engulfs) return 'none';

  const isStrong = currBody >= 1.5 * prevBody;

  // M5 engulfing i fortë = FORT
  if (timeframe === 'M5' && isStrong) return 'strong';
  // M1 engulfing ose M5 i dobët = BUTË
  if (timeframe === 'M1' || (timeframe === 'M5' && !isStrong)) return 'soft';
  return 'none';
}

// ── CISD CHECKER ──
function checkCISD(candles, direction) {
  if (!candles || candles.length < 3) return false;

  // Gjej swing high/low të fundit
  const lookback = candles.slice(-20);
  let swingLevel = null;

  if (direction === 'buy') {
    // Kërko swing low — CISD kur body close kalon poshtë swing low-in
    // pastaj kthehet lart me body close mbi swing low
    let swingLow = Math.min(...lookback.slice(0, -1).map(c => c.low));
    const lastCandle = candles[candles.length - 1];
    // CISD bullish: çmimi shkoi poshtë swing low, pastaj mbylli mbi të
    const prevCandle = candles[candles.length - 2];
    if (prevCandle.low < swingLow && lastCandle.close > swingLow) return true;
  } else {
    // CISD bearish: çmimi shkoi mbi swing high, pastaj mbylli nën të
    let swingHigh = Math.max(...lookback.slice(0, -1).map(c => c.high));
    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    if (prevCandle.high > swingHigh && lastCandle.close < swingHigh) return true;
  }
  return false;
}

// ── SMT DIVERGENCE CHECKER ──
function checkSMT(mainCandles, smt1Candles, smt2Candles, direction) {
  if (!mainCandles || mainCandles.length < 3) return false;

  const mainRecent = mainCandles[mainCandles.length - 1];
  const mainPrev   = mainCandles[mainCandles.length - 2];

  function diverges(smtCandles, isInverse) {
    if (!smtCandles || smtCandles.length < 2) return false;
    const smtRecent = smtCandles[smtCandles.length - 1];
    const smtPrev   = smtCandles[smtCandles.length - 2];

    if (direction === 'buy') {
      // Main bën lower low, SMT nuk e bën (divergjencë bullish)
      const mainLowerLow = mainRecent.low < mainPrev.low;
      if (!isInverse) {
        const smtLowerLow = smtRecent.low < smtPrev.low;
        return mainLowerLow && !smtLowerLow;
      } else {
        // EURUSD është inverse proxy: kur XAU bie, EUR duhet të rritet
        const eurHigherHigh = smtRecent.high > smtPrev.high;
        return mainLowerLow && !eurHigherHigh;
      }
    } else {
      // Main bën higher high, SMT nuk e bën (divergjencë bearish)
      const mainHigherHigh = mainRecent.high > mainPrev.high;
      if (!isInverse) {
        const smtHigherHigh = smtRecent.high > smtPrev.high;
        return mainHigherHigh && !smtHigherHigh;
      } else {
        const eurLowerLow = smtRecent.low < smtPrev.low;
        return mainHigherHigh && !eurLowerLow;
      }
    }
  }

  const bundle = SMT_BUNDLES[mainCandles.symbol] || { primary: null, inverse: null };
  const primaryDiverges = smt1Candles ? diverges(smt1Candles, false) : false;
  const inverseDiverges  = smt2Candles ? diverges(smt2Candles, true)  : false;

  // TRUE nëse të paktën njëri divergjon
  return primaryDiverges || inverseDiverges;
}

// ── LOGJIKA E VULËS FINALE (të gjitha kombinimet) ──
function evaluateConfirmation(signals) {
  const { cisd, smt, engulfM5, wickStrong, wickSoft, engulfM1 } = signals;

  // Sinjalet FORT (secili vetëm mjafton)
  const hasFort = cisd || smt || engulfM5 || wickStrong;

  // Numëro të gjitha sinjalet aktive
  const all = [cisd, smt, engulfM5, wickStrong, wickSoft, engulfM1];
  const total = all.filter(Boolean).length;

  // Numëro sinjalet e buta
  const softCount = [wickSoft, engulfM1].filter(Boolean).length;

  let enter = false;
  let reason = [];

  if (cisd)       reason.push('CISD');
  if (smt)        reason.push('SMT Divergence');
  if (engulfM5)   reason.push('Engulfing M5');
  if (wickStrong) reason.push('Wick 3× Fluturim');
  if (wickSoft)   reason.push('Wick Refuzim');
  if (engulfM1)   reason.push('Engulfing M1');

  // RREGULLA (të gjitha kombinimet):
  // 1. Ndonjë FORT vetëm → HYR menjëherë
  if (hasFort) {
    enter = true;
  }
  // 2. 2 të buta bashkë (wick soft + engulf M1) → HYR (quorum)
  else if (softCount >= 2) {
    enter = true;
  }
  // 3. Vetëm 1 sinjal i butë → JO
  else {
    enter = false;
  }

  return {
    enter,
    count: total,
    signals: reason,
    strength: hasFort ? 'FORT' : (total >= 2 ? 'QUORUM' : 'DOBËT')
  };
}

// ── MONITOR LOOP PËR NJË WATCH ──
async function monitorWatch(watchId) {
  const watch = activeWatches.get(watchId);
  if (!watch || watch.status !== 'ACTIVE') return;

  console.log(`[MONITOR] ${watchId} — duke kontrolluar...`);

  try {
    const bundle = SMT_BUNDLES[watch.symbol] || {};
    const symbols = [watch.symbol];
    if (bundle.primary) symbols.push(bundle.primary);
    if (bundle.inverse) symbols.push(bundle.inverse);

    // 1. Merr çmimin live
    const spotResult = await callMcpTool('get_spot_prices', { symbols });
    if (!spotResult) {
      console.error(`[MONITOR] ${watchId} — get_spot_prices dështoi`);
      return;
    }

    // Parse spot prices
    let spots = {};
    const spotText = JSON.stringify(spotResult);
    try {
      const arr = extractArray(spotResult);
      for (const s of arr) {
        if (s.symbol) spots[s.symbol] = s;
      }
    } catch {}

    const mainSpot = spots[watch.symbol];
    if (!mainSpot) {
      console.error(`[MONITOR] ${watchId} — spot price për ${watch.symbol} nuk u gjet`);
      return;
    }

    const mid = (mainSpot.bid + mainSpot.ask) / 2;
    const direction = watch.direction.toLowerCase();

    console.log(`[MONITOR] ${watchId} — ${watch.symbol} mid=${mid} entry=${watch.entry} sl=${watch.sl} tp1=${watch.tp1}`);

    // 2. KONTROLLO SKADIMIN (TP1 preket para entry)
    if (!watch.entryTouched) {
      if (direction === 'buy' && mid >= watch.tp1) {
        await expireWatch(watchId, 'TP1 u prek pa u aktivizuar entry — setup skadoi');
        return;
      }
      if (direction === 'sell' && mid <= watch.tp1) {
        await expireWatch(watchId, 'TP1 u prek pa u aktivizuar entry — setup skadoi');
        return;
      }
    }

    // 3. KONTROLLO SL PA KONFIRMIM
    if (!watch.entryTouched) {
      if (direction === 'buy' && mid <= watch.sl) {
        await expireWatch(watchId, 'SL u prek pa u aktivizuar entry — setup skadoi');
        return;
      }
      if (direction === 'sell' && mid >= watch.sl) {
        await expireWatch(watchId, 'SL u prek pa u aktivizuar entry — setup skadoi');
        return;
      }
    }

    // 4. KONTROLLO ENTRY TOUCH
    const entryLow  = watch.entry - (watch.symbol === 'XAUUSD' ? 0.10 : 0.0001);
    const entryHigh = watch.entry + (watch.symbol === 'XAUUSD' ? 0.10 : 0.0001);
    const entryTouched = direction === 'buy'
      ? mid <= entryHigh && mid >= watch.sl
      : mid >= entryLow  && mid <= watch.sl;

    if (entryTouched && !watch.entryTouched) {
      watch.entryTouched = true;
      watch.entryTouchedAt = Date.now();
      console.log(`[MONITOR] ${watchId} — ENTRY PREKUR @ ${mid}`);
    }

    // 5. PAS ENTRY TOUCH — KONTROLLO 4 SINJALET
    if (watch.entryTouched) {

      // SL preket pas entry → dështim
      if (direction === 'buy' && mid <= watch.sl) {
        await failWatch(watchId, mid);
        return;
      }
      if (direction === 'sell' && mid >= watch.sl) {
        await failWatch(watchId, mid);
        return;
      }

      // Merr qirinjtë M5 dhe M1 për analizë
      const [m5Main, m1Main, m5Smt1, m5Smt2] = await Promise.all([
        callMcpTool('get_trendbars', { symbol: watch.symbol, timeframe: 'M5', count: 30 }),
        callMcpTool('get_trendbars', { symbol: watch.symbol, timeframe: 'M1', count: 20 }),
        bundle.primary ? callMcpTool('get_trendbars', { symbol: bundle.primary, timeframe: 'M5', count: 20 }) : Promise.resolve(null),
        bundle.inverse ? callMcpTool('get_trendbars', { symbol: bundle.inverse, timeframe: 'M5', count: 20 }) : Promise.resolve(null),
      ]);

      const m5Candles = extractArray(m5Main);
      const m1Candles = extractArray(m1Main);
      const smt1Candles = extractArray(m5Smt1);
      const smt2Candles = extractArray(m5Smt2);

      if (!m5Candles || m5Candles.length < 3) return;

      const atr = calcATR(m5Candles);
      const lastM5 = m5Candles[m5Candles.length - 1];
      const lastM1 = m1Candles ? m1Candles[m1Candles.length - 1] : null;

      // Llogarit të gjitha sinjalet
      const wickTypeM5 = classifyWick(lastM5, atr, direction);
      const wickTypeM1 = lastM1 ? classifyWick(lastM1, calcATR(m1Candles), direction) : 'none';
      const engulfTypeM5 = classifyEngulfing(m5Candles, direction, 'M5');
      const engulfTypeM1 = m1Candles ? classifyEngulfing(m1Candles, direction, 'M1') : 'none';
      const cisd = checkCISD(m5Candles, direction);
      const smt  = checkSMT(m5Candles, smt1Candles, smt2Candles, direction);

      const signals = {
        cisd,
        smt,
        engulfM5:   engulfTypeM5 === 'strong',
        wickStrong: wickTypeM5 === 'strong' || wickTypeM1 === 'strong',
        wickSoft:   wickTypeM5 === 'soft'   || wickTypeM1 === 'soft',
        engulfM1:   engulfTypeM1 !== 'none'
      };

      console.log(`[MONITOR] ${watchId} — Sinjalet:`, signals);

      const result = evaluateConfirmation(signals);

      if (result.enter) {
        await confirmWatch(watchId, mid, result);
      } else {
        console.log(`[MONITOR] ${watchId} — Konfirmim i pamjaftueshëm (${result.count} sinjale): ${result.signals.join(', ')}`);
      }
    }

  } catch (err) {
    console.error(`[MONITOR] ${watchId} — Gabim:`, err.message);
  }
}

// ── KONFIRMIM — VULA FINALE ──
async function confirmWatch(watchId, price, result) {
  const watch = activeWatches.get(watchId);
  if (!watch) return;
  watch.status = 'CONFIRMED';
  clearInterval(watch.intervalId);

  const msg =
    `🎯 <b>VULA FINALE — HYR TANI</b>\n\n` +
    `📊 <b>${watch.symbol}</b> — ${watch.direction.toUpperCase()}\n` +
    `💰 <b>Entry:</b> ${watch.entry}\n` +
    `🛑 <b>SL:</b> ${watch.sl}\n` +
    `🎯 <b>TP1:</b> ${watch.tp1}\n` +
    `🎯 <b>TP2:</b> ${watch.tp2 || '—'}\n` +
    `🎯 <b>TP3:</b> ${watch.tp3 || '—'}\n\n` +
    `✅ <b>Konfirmuar nga:</b> ${result.signals.join(' + ')}\n` +
    `💪 <b>Forca:</b> ${result.strength}\n` +
    `📈 <b>Model:</b> ${watch.setup_model || '—'}\n` +
    `⭐ <b>Conviction:</b> ${watch.conviction || '—'}\n\n` +
    `📍 <b>Çmimi live:</b> ${price}`;

  console.log(`[CONFIRM] ${watchId} — VULA FINALE @ ${price}`);
  await sendTelegram(msg);
  activeWatches.delete(watchId);
}

// ── DËSHTIM — SL PAS ENTRY ──
async function failWatch(watchId, price) {
  const watch = activeWatches.get(watchId);
  if (!watch) return;
  watch.status = 'FAILED';
  clearInterval(watch.intervalId);

  const msg =
    `❌ <b>SETUP DËSHTOI</b>\n\n` +
    `📊 <b>${watch.symbol}</b> — ${watch.direction.toUpperCase()}\n` +
    `🛑 SL u prek pa konfirmim të mjaftueshëm\n` +
    `📍 Çmimi: ${price}\n` +
    `⚠️ Mos hyr — setup i pavlefshëm`;

  console.log(`[FAIL] ${watchId} — SL prek @ ${price}`);
  await sendTelegram(msg);
  activeWatches.delete(watchId);
}

// ── SKADIM — TP1/SL PA ENTRY ──
async function expireWatch(watchId, reason) {
  const watch = activeWatches.get(watchId);
  if (!watch) return;
  watch.status = 'EXPIRED';
  clearInterval(watch.intervalId);

  const msg =
    `⚠️ <b>SETUP SKADOI</b>\n\n` +
    `📊 <b>${watch.symbol}</b> — ${watch.direction.toUpperCase()}\n` +
    `📋 ${reason}\n` +
    `💡 Entry nuk u aktivizua — setup i vdekur`;

  console.log(`[EXPIRE] ${watchId} — ${reason}`);
  await sendTelegram(msg);
  activeWatches.delete(watchId);
}

// ── HELPER: nxjerr array nga MCP response ──
function extractArray(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (result.content) {
    for (const c of result.content) {
      if (c.type === 'text') {
        try { const p = JSON.parse(c.text); return Array.isArray(p) ? p : [p]; } catch {}
      }
    }
  }
  if (result.result) return extractArray(result.result);
  return [];
}

// ── REGISTER WATCH ENDPOINT (Spark e thërret këtë) ──
app.post('/register_watch', async (req, res) => {
  const { symbol, direction, entry, sl, tp1, tp2, tp3, setup_model, conviction } = req.body;

  // Validim bazik
  if (!symbol || !direction || !entry || !sl || !tp1) {
    return res.status(400).json({
      error: 'Mungojnë parametrat: symbol, direction, entry, sl, tp1 janë të detyrueshëm'
    });
  }

  const watchId = `${symbol}_${Date.now()}`;
  const watch = {
    id: watchId,
    symbol: symbol.toUpperCase(),
    direction: direction.toLowerCase(),
    entry: parseFloat(entry),
    sl: parseFloat(sl),
    tp1: parseFloat(tp1),
    tp2: tp2 ? parseFloat(tp2) : null,
    tp3: tp3 ? parseFloat(tp3) : null,
    setup_model: setup_model || 'Unknown',
    conviction: conviction || 'B',
    status: 'ACTIVE',
    entryTouched: false,
    entryTouchedAt: null,
    createdAt: Date.now()
  };

  // Nis monitor çdo 10 sekonda
  watch.intervalId = setInterval(() => monitorWatch(watchId), 10000);
  activeWatches.set(watchId, watch);

  console.log(`[WATCH] Regjistruar: ${watchId}`, watch);

  // Njofto Telegram që setup u regjistrua
  await sendTelegram(
    `👁️ <b>SETUP AKTIV — Duke monitoruar</b>\n\n` +
    `📊 <b>${watch.symbol}</b> — ${watch.direction.toUpperCase()}\n` +
    `💰 <b>Entry:</b> ${watch.entry}\n` +
    `🛑 <b>SL:</b> ${watch.sl}\n` +
    `🎯 <b>TP1:</b> ${watch.tp1}\n` +
    `🎯 <b>TP2:</b> ${watch.tp2 || '—'}\n` +
    `🎯 <b>TP3:</b> ${watch.tp3 || '—'}\n` +
    `📈 <b>Model:</b> ${watch.setup_model}\n` +
    `⭐ <b>Conviction:</b> ${watch.conviction}\n\n` +
    `⏱️ Duke pritur entry @ ${watch.entry}...`
  );

  res.json({
    status: 'WATCHING',
    watch_id: watchId,
    message: `Monitor aktiv për ${watch.symbol} — entry @ ${watch.entry}`
  });
});

// ── PROXY ──
async function proxyToUpstream(req, res) {
  try {
    const token = process.env.CTRADER_MCP_TOKEN;
    if (!token) {
      return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Missing CTRADER_MCP_TOKEN' }, id: null });
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

// ── HEALTH ──
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'MULTISNIPER07 MCP v1.0',
  watches: activeWatches.size,
  uptime: Math.floor(process.uptime()) + 's'
}));

// ── ANTI-SLEEP PING ──
const SERVER_URL = process.env.SERVER_URL || '';
if (SERVER_URL) {
  setInterval(async () => {
    try {
      await fetch(`${SERVER_URL}/health`);
      console.log('[PING] Server aktiv');
    } catch (e) {
      console.error('[PING] Gabim:', e.message);
    }
  }, 10 * 60 * 1000);
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[MULTISNIPER07 MCP] Server aktiv ne port ${PORT}`));
