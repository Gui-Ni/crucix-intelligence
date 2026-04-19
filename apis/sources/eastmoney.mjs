// 中国市场行情 — 腾讯/东方财富多源
// 腾讯行情 API (qt.gtimg.cn) 返回 GBK 编码，单独处理避免 safeFetch 的 JSON.parse 干扰
// 备用：东方财富 datacenter-web

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─── GBK Decoder ───────────────────────────────────────────────────────────
function decodeGBK(bytes) {
  return new TextDecoder('gbk').decode(bytes);
}

// ─── Direct fetch for Tencent (bypasses safeFetch JSON.parse) ─────────────
async function tencentFetch(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    clearTimeout(timer);
    const buf = await res.arrayBuffer();
    const text = decodeGBK(new Uint8Array(buf));
    return text;
  } catch (e) {
    clearTimeout(timer);
    return '';
  }
}

// ─── Symbols ───────────────────────────────────────────────────────────────

const SYMBOLS = {
  // A股指数
  'sh000001': { label: '上证指数',    category: 'index' },
  'sz399001': { label: '深证成指',    category: 'index' },
  'sz399006': { label: '创业板指',    category: 'index' },
  'sh000688': { label: '科创50',      category: 'index' },
  'sh000300': { label: '沪深300',     category: 'index' },
  'sh000016': { label: '上证50',      category: 'index' },
  'sh000905': { label: '中证500',    category: 'index' },
  'sh000852': { label: '中证1000',   category: 'index' },
  // 港股指数
  'hkHSI':    { label: '恒生指数',    category: 'hk' },
  'hkHSTECH': { label: '恒生科技',    category: 'hk' },
  'hkHSCEI':  { label: '恒生国企',   category: 'hk' },
  // 商品期货（COMEX）
  'hf_GC':    { label: 'COMEX黄金',  category: 'commodity' },
  'hf_SI':    { label: 'COMEX白银',  category: 'commodity' },
};

// ─── Tencent K-line parser ────────────────────────────────────────────────

function parseTencentLine(line) {
  const parts = line.split('~');
  if (parts.length < 15) return null;
  const price     = parseFloat(parts[3]);
  const yest      = parseFloat(parts[4]);
  const open      = parseFloat(parts[5]);
  const vol       = parseFloat(parts[6]);
  const change    = parseFloat(parts[31]) || (price - yest);
  const changePct = parseFloat(parts[32]) || (yest ? ((price - yest) / yest * 100) : 0);
  const dateTime  = parts[30] || parts[33] || '';
  const name      = parts[1];
  const code      = parts[2];

  return {
    name,
    code,
    price: isNaN(price) ? null : Math.round(price * 100) / 100,
    open:  isNaN(open)  ? null : Math.round(open  * 100) / 100,
    yestClose: isNaN(yest) ? null : Math.round(yest * 100) / 100,
    change: isNaN(change) ? null : Math.round(change * 100) / 100,
    changePct: isNaN(changePct) ? null : Math.round(changePct * 100) / 100,
    volume: isNaN(vol) ? null : vol,
    datetime: dateTime,
  };
}

function parseFuturesLine(line) {
  const parts = line.split(',');
  if (parts.length < 6) return null;
  const price     = parseFloat(parts[0]);
  const changePct = parseFloat(parts[1]);
  const high      = parseFloat(parts[2]);
  const low       = parseFloat(parts[3]);
  const open      = parseFloat(parts[4]);
  const prevSett  = parseFloat(parts[5]);
  const time      = parts[7] || '';
  const settle    = parseFloat(parts[9]);
  const change    = prevSett ? price - prevSett : null;

  return {
    price: isNaN(price) ? null : Math.round(price * 100) / 100,
    changePct: isNaN(changePct) ? null : Math.round(changePct * 100) / 100,
    change: isNaN(change) ? null : Math.round(change * 100) / 100,
    open:  isNaN(open) ? null : Math.round(open  * 100) / 100,
    high:  isNaN(high) ? null : Math.round(high  * 100) / 100,
    low:   isNaN(low)  ? null : Math.round(low   * 100) / 100,
    settle: isNaN(settle) ? null : Math.round(settle * 100) / 100,
    datetime: time,
  };
}

// ─── Stock list (dynamically loaded from stock_map.json) ────────────────

let _stockSymbols = null;
function getStockSymbols() {
  if (_stockSymbols) return _stockSymbols;
  try {
    const mapPath = resolve('C:/Users/admin/.openclaw/workspace/scripts/stock/stock_map.json');
    const j = JSON.parse(readFileSync(mapPath, 'utf8'));
    const entries = Object.entries(j).sort((a, b) => a[1].localeCompare(b[1]));
    // Sample ~100 stocks across the full alphabet (every 50th)
    const selected = entries.filter((_, i) => i % 50 === 0);
    _stockSymbols = {};
    for (const [name, code] of selected) {
      const prefix = code.startsWith('SH') ? 'sh' : code.startsWith('SZ') ? 'sz' : code.startsWith('BJ') ? 'bj' : null;
      if (!prefix) continue;
      const num = code.slice(2);
      const key = prefix + num;
      _stockSymbols[key] = { label: name.replace(/'/g, ''), category: 'stock' };
    }
  } catch (e) {
    console.error('[EastMoney] Failed to load stock_map.json:', e.message);
    _stockSymbols = {};
  }
  return _stockSymbols;
}

// ─── Fetch Tencent quotes ────────────────────────────────────────────────

async function fetchTencent(symbols) {
  const result = {};
  const BATCH = 100;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    // Batch request: join with + separator
    const url = 'https://qt.gtimg.cn/q=' + batch.join(',');
    const text = await tencentFetch(url, 10000);
    if (!text) continue;

    // Parse each line (each line is v_CODE="...")
    for (const sym of batch) {
      const match = text.match(new RegExp("v_" + sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '="([^"]+)"'));
      if (!match) continue;
      const val = match[1];
      const data = val.includes(',') ? parseFuturesLine(val) : parseTencentLine(val);
      if (data) result[sym] = data;
    }

    if (i + BATCH < symbols.length) await delay(200);
  }
  return result;
}

// ─── Signals ─────────────────────────────────────────────────────────────

function computeSignals(data) {
  const signals = [];

  const indexes = [
    data['sh000001'], data['sz399001'], data['sz399006'], data['sh000688'],
    data['sh000300'], data['sh000016'], data['sh000905'], data['sh000852'],
  ].filter(Boolean);

  if (indexes.length > 0) {
    const upCount   = indexes.filter(i => i.changePct > 0).length;
    const downCount = indexes.length - upCount;
    const avgChange = indexes.reduce((s, i) => s + (i.changePct || 0), 0) / indexes.length;
    const market = avgChange > 0.5 ? '大涨' : avgChange > 0.1 ? '小幅上涨' :
                   avgChange < -0.5 ? '大跌' : avgChange < -0.1 ? '小幅下跌' : '震荡';

    signals.push('A股' + market + ' (' + upCount + '涨/' + downCount + '跌, 均幅' + (avgChange > 0 ? '+' : '') + avgChange.toFixed(2) + '%)');

    const worst = [...indexes].sort((a, b) => (a.changePct || 0) - (b.changePct || 0))[0];
    const best  = [...indexes].sort((a, b) => (b.changePct || 0) - (a.changePct || 0))[0];
    if (worst?.changePct < -1) signals.push('拖累: ' + worst.name + ' ' + worst.changePct + '%');
    if (best?.changePct > 1.5) signals.push('领涨: ' + best.name + ' +' + best.changePct + '%');
  }

  const gold = data['hf_GC'];
  if (gold && gold.changePct) {
    if (gold.changePct > 1) signals.push('黄金大涨 +' + gold.changePct + '%（避险情绪升温）');
    if (gold.changePct < -1) signals.push('黄金下跌 ' + gold.changePct + '%（避险情绪降温）');
  }

  const hk = data['hkHSI'];
  if (hk) {
    if (hk.changePct > 1.5) signals.push('恒生指数大涨 +' + hk.changePct + '%');
    if (hk.changePct < -1.5) signals.push('恒生指数大跌 ' + hk.changePct + '%');
  }

  return signals;
}

// ─── Briefing ─────────────────────────────────────────────────────────────

export async function briefing() {
  // Get index/hk/commodity symbols from SYMBOLS
  const fixedSymbols = Object.keys(SYMBOLS);
  // Get stock symbols from stock_map.json
  const stockSymbols = getStockSymbols();
  const allSymbols = [...fixedSymbols, ...Object.keys(stockSymbols)];

  const data = await fetchTencent(allSymbols);

  // Build result categories
  const categories = { index: [], hk: [], commodity: [], stock: [] };
  for (const [sym, meta] of Object.entries(SYMBOLS)) {
    categories[meta.category].push({ symbol: sym, ...meta, ...(data[sym] || {}) });
  }
  for (const [sym, meta] of Object.entries(stockSymbols)) {
    categories.stock.push({ symbol: sym, ...meta, ...(data[sym] || {}) });
  }

  const signals = computeSignals(data);

  return {
    source: 'EastMoney/Tencent',
    timestamp: new Date().toISOString(),
    signals,
    data: {
      indexes:     categories.index,
      hk:          categories.hk,
      commodities: categories.commodity,
      stocks:      categories.stock,
    },
  };
}

if (process.argv[1]?.endsWith('eastmoney.mjs')) {
  console.log('中国市场行情 — fetching...\n');
  const data = await briefing();
  console.log('Stocks with price:', data.data.stocks.filter(s => s.price).length, '/', data.data.stocks.length);
  console.log('Indexes:', data.data.indexes.length);
  console.log('Signals:', data.signals);
}
