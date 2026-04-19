// LLM-Powered Trade Ideas — generates actionable ideas from sweep data + delta context

import { getLocale } from '../i18n.mjs';

/**
 * Generate LLM-enhanced trade ideas from sweep data.
 * @param {LLMProvider} provider - configured LLM provider
 * @param {object} sweepData - synthesized dashboard data
 * @param {object|null} delta - delta from last sweep
 * @param {Array} previousIdeas - ideas from previous runs (for dedup)
 * @returns {Promise<Array>} - array of idea objects
 */
export async function generateLLMIdeas(provider, sweepData, delta, previousIdeas = []) {
  if (!provider?.isConfigured) return null;

  let context;
  try {
    context = compactSweepForLLM(sweepData, delta, previousIdeas);
  } catch (err) {
    console.error('[LLM Ideas] Failed to compact sweep data:', err.message);
    return null;
  }

  const locale = getLocale();

  // Use locale-specific prompt (zh.json llm.systemPrompt), fallback to embedded English
  const defaultPrompt = `You are a quantitative analyst at a macro intelligence firm. You receive structured OSINT + economic data from 25 sources and produce 7-12 actionable trade ideas.

Rules:
- Each idea must cite specific data points from the input
- Include entry rationale, risk factors, and time horizon
- Blend geopolitical, economic, and market signals — cross-correlate across domains
- Be specific: name instruments (tickers, futures, ETFs), not vague sectors
- DIVERSITY REQUIRED: spread ideas across at least 4 of these categories: (1) US megacap stocks (NVDA/AAPL/MSFT/GOOGL/AMZN/META/TSLA/AVGO/JPM/GS/V/WMT/PG/KO/PEP/XOM/CVX/UNH/JNJ/CAT/NFLX), (2) commodities/gold/oil, (3) crypto (BTC/ETH), (4) China markets (A-share/HK), (5) macro/rates/FED policy. Each included category must have at least 2 ideas. Do not cluster more than 3 ideas in the same category.
- If delta shows significant changes, lead with those
- Do NOT repeat ideas from the "previous ideas" list unless conditions have materially changed
- Rate confidence: HIGH (multiple confirming signals), MEDIUM (thesis supported), LOW (speculative)

Output ONLY valid JSON array. Each object:
{
  "title": "Short title (max 10 words)",
  "type": "LONG|SHORT|HEDGE|WATCH|AVOID",
  "ticker": "Primary instrument",
  "confidence": "HIGH|MEDIUM|LOW",
  "rationale": "2-3 sentence explanation citing specific data",
  "risk": "Key risk factor",
  "horizon": "Intraday|Days|Weeks|Months",
  "signals": ["signal1", "signal2"]
}`;

  const systemPrompt = locale?.llm?.systemPrompt || defaultPrompt;

  try {
    const result = await provider.complete(systemPrompt, context, { maxTokens: 4096, timeout: 120000 });
    const ideas = parseIdeasResponse(result.text);
    if (ideas && ideas.length > 0) {
      return ideas;
    }
    console.warn('[LLM Ideas] No valid ideas parsed from response');
    return null;
  } catch (err) {
    console.error('[LLM Ideas] Generation failed:', err.message);
    return null;
  }
}

/**
 * Compact sweep data to ~8KB for token efficiency.
 */
function compactSweepForLLM(data, delta, previousIdeas) {
  const sections = [];

  // Economic indicators
  if (data.fred?.length) {
    const key = data.fred.filter(f => ['VIXCLS', 'DFF', 'DGS10', 'DGS2', 'T10Y2Y', 'BAMLH0A0HYM2', 'DTWEXBGS', 'MORTGAGE30US'].includes(f.id));
    sections.push(`ECONOMIC: ${key.map(f => `${f.id}=${f.value}${f.momChange ? ` (${f.momChange > 0 ? '+' : ''}${f.momChange})` : ''}`).join(', ')}`);
  }

  // Energy
  if (data.energy) {
    sections.push(`ENERGY: WTI=$${data.energy.wti}, Brent=$${data.energy.brent}, NatGas=$${data.energy.natgas}, CrudeStocks=${data.energy.crudeStocks}bbl`);
  }

  // Metals
  if (data.metals?.gold != null || data.metals?.silver != null) {
    const gold = data.metals?.gold != null ? `$${data.metals.gold}` : 'n/a';
    const silver = data.metals?.silver != null ? `$${data.metals.silver}` : 'n/a';
    const goldChg = data.metals?.goldChangePct != null ? ` (${data.metals.goldChangePct >= 0 ? '+' : ''}${data.metals.goldChangePct}%)` : '';
    const silverChg = data.metals?.silverChangePct != null ? ` (${data.metals.silverChangePct >= 0 ? '+' : ''}${data.metals.silverChangePct}%)` : '';
    sections.push(`METALS: Gold=${gold}${goldChg}, Silver=${silver}${silverChg}`);
  }

  // BLS
  if (data.bls?.length) {
    sections.push(`LABOR: ${data.bls.map(b => `${b.id}=${b.value}`).join(', ')}`);
  }

  // Treasury
  if (data.treasury) {
    sections.push(`TREASURY: totalDebt=$${data.treasury}T`);
  }

  // Supply chain
  if (data.gscpi) {
    sections.push(`SUPPLY_CHAIN: GSCPI=${data.gscpi.value} (${data.gscpi.interpretation})`);
  }

  // Geopolitical signals (cap total OSINT text to ~1500 chars to keep prompt compact)
  const urgentPosts = (data.tg?.urgent || []).slice(0, 5);
  if (urgentPosts.length) {
    const MAX_OSINT_CHARS = 1500;
    let remaining = MAX_OSINT_CHARS;
    const lines = [];
    for (const p of urgentPosts) {
      const text = p.text || '';
      if (remaining <= 0) break;
      const trimmed = text.length > remaining ? text.substring(0, remaining) + '…' : text;
      lines.push(`- ${trimmed}`);
      remaining -= trimmed.length;
    }
    sections.push(`URGENT_OSINT:\n${lines.join('\n')}`);
  }

  // Thermal / fire detections
  if (data.thermal?.length) {
    const hotRegions = data.thermal.filter(t => t.det > 10).map(t => `${t.region}: ${t.det} detections (${t.hc} high-conf)`);
    if (hotRegions.length) sections.push(`THERMAL: ${hotRegions.join(', ')}`);
  }

  // Air activity
  if (data.air?.length) {
    const airSum = data.air.map(a => `${a.region}: ${a.total} aircraft`);
    sections.push(`AIR_ACTIVITY: ${airSum.join(', ')}`);
  }

  // Nuclear
  if (data.nuke?.length) {
    const anomalies = data.nuke.filter(n => n.anom);
    if (anomalies.length) sections.push(`NUCLEAR_ANOMALY: ${anomalies.map(n => `${n.site}: ${n.cpm}cpm`).join(', ')}`);
  }

  // WHO alerts
  if (data.who?.length) {
    sections.push(`WHO_ALERTS: ${data.who.slice(0, 3).map(w => w.title).join('; ')}`);
  }

  // Defense spending
  if (data.defense?.length) {
    const topContracts = data.defense.slice(0, 3).map(d => `$${((d.amount || 0) / 1e6).toFixed(0)}M to ${d.recipient}`);
    sections.push(`DEFENSE_CONTRACTS: ${topContracts.join(', ')}`);
  }

  // RSS news headlines (Chinese sources prioritized, max 8 items)
  if (data.news?.length) {
    const cnSources = ['金十数据', '第一财经', '华尔街见闻', '36氪', '同花顺', 'iThome'];
    const sorted = [...data.news].sort((a, b) => {
      const aIsCn = cnSources.some(s => (a.source || '').includes(s));
      const bIsCn = cnSources.some(s => (b.source || '').includes(s));
      if (aIsCn && !bIsCn) return -1;
      if (!aIsCn && bIsCn) return 1;
      return 0;
    });
    const topNews = sorted.slice(0, 8).map(n => `[${n.source || 'NEWS'}] ${(n.headline || n.title || '').substring(0, 80)}`);
    if (topNews.length) sections.push(`LATEST_HEADLINES:\n${topNews.join('\n')}`);
  }

  // Delta context
  if (delta?.summary) {
    sections.push(`\nDELTA_SINCE_LAST_SWEEP: direction=${delta.summary.direction}, changes=${delta.summary.totalChanges}, critical=${delta.summary.criticalChanges}`);
    if (delta.signals?.escalated?.length) {
      sections.push(`ESCALATED: ${delta.signals.escalated.map(s => `${s.label}: ${s.previous}→${s.current} (${(s.changePct||0) > 0 ? '+' : ''}${(s.changePct||0).toFixed(1)}%)`).join(', ')}`);
    }
    if (delta.signals?.new?.length) {
      sections.push(`NEW_SIGNALS: ${delta.signals.new.map(s => s.label || s.text?.substring(0, 60)).join('; ')}`);
    }
  }

  // China Markets (EastMoney A-share indexes + HK + COMEX)
  if (data.cnmarkets) {
    const idx = (data.cnmarkets.indexes || []).map(q => `${q.name}=${q.price} (${q.changePct >= 0 ? '+' : ''}${q.changePct}%)`).join(', ');
    const hk = (data.cnmarkets.hk || []).map(q => `${q.name}=${q.price} (${q.changePct >= 0 ? '+' : ''}${q.changePct}%)`).join(', ');
    const metals = (data.cnmarkets.commodities || []).map(q => `${q.name}=${q.price} (${q.changePct >= 0 ? '+' : ''}${q.changePct}%)`).join(', ');
    if (idx) sections.push(`CHINA_A_SHARE_INDEXES: ${idx}`);
    if (hk) sections.push(`CHINA_HK: ${hk}`);
    if (metals) sections.push(`CHINA_COMEX_METALS: ${metals}`);
    // A股个股 — 按涨跌幅排序，涨跌幅大的优先（前8只）
    const stocks = (data.cnmarkets.stocks || []).slice().sort((a, b) => (b.changePct || 0) - (a.changePct || 0)).slice(0, 8);
    if (stocks.length) {
      const top = stocks.map(q => `${q.name}(${q.symbol})=${q.price} (${q.changePct >= 0 ? '+' : ''}${q.changePct}%)`).join(', ');
      sections.push(`CHINA_A_STOCKS: ${top}`);
    }
  }

  // China Macro (GDP, CPI, PMI)
  if (data.cnmacro?.data) {
    const d = data.cnmacro.data;
    const parts = [];
    if (d.gdp) parts.push(`GDP=${d.gdp.yoy}% (${d.gdp.period})`);
    if (d.cpi) parts.push(`CPI=${d.cpi.yoy}% YoY, ${d.cpi.mom}% MoM (${d.cpi.period})`);
    if (d.pmi) parts.push(`PMI=${d.pmi.mfg} (${d.pmi.period})`);
    if (parts.length) sections.push(`CHINA_MACRO: ${parts.join(', ')}`);
  }

  // US Indexes (from Yahoo Finance)
  if (data.markets?.indexes) {
    const usIdx = data.markets.indexes.map(q => `${q.symbol}=${q.price} (${q.changePct >= 0 ? '+' : ''}${q.changePct}%)\n`).join('');
    if (usIdx) sections.push(`US_INDEXES:\n${usIdx}`);
  }

  // Crypto (BTC, ETH)
  if (data.markets?.crypto) {
    const crypto = data.markets.crypto.map(q => `${q.symbol}=${q.price} (${q.changePct >= 0 ? '+' : ''}${q.changePct}%)`).join(', ');
    if (crypto) sections.push(`CRYPTO: ${crypto}`);
  }

  // US Megacap Stocks
  if (data.markets?.stocks) {
    const usStocks = data.markets.stocks.map(q => `${q.symbol}=${q.price} (${q.changePct >= 0 ? '+' : ''}${q.changePct}%)`).join(', ');
    if (usStocks) sections.push(`US_STOCKS: ${usStocks}`);
  }

  // Previous ideas (for dedup)
  if (previousIdeas.length) {
    sections.push(`\nPREVIOUS_IDEAS (avoid repeating):\n${previousIdeas.map(i => `- ${i.title} [${i.type}]`).join('\n')}`);
  }

  return sections.join('\n');
}

/**
 * Parse LLM response into ideas array. Handles markdown code blocks.
 */
function parseIdeasResponse(text) {
  if (!text) return null;

  // Strip markdown code block wrappers
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;

    // Validate each idea has required fields
    return parsed.filter(idea =>
      idea.title && idea.type && idea.confidence
    ).map(idea => ({
      title: idea.title,
      type: idea.type,
      ticker: idea.ticker || '',
      confidence: idea.confidence,
      rationale: idea.rationale || '',
      risk: idea.risk || '',
      horizon: idea.horizon || '',
      signals: idea.signals || [],
      source: 'llm',
    }));
  } catch {
    // Try to extract JSON array from mixed text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        return arr.filter(i => i.title && i.type).map(idea => ({
          ...idea,
          source: 'llm',
        }));
      } catch { /* give up */ }
    }
    return null;
  }
}
