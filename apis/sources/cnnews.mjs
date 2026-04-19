// 中国市场快讯 — 同花顺财经
// https://news.10jqka.com.cn/tapp/news/push/stock/
// 免费，无需 KEY，UTF-8 JSON，盘中实时更新

import { safeFetch } from '../utils/fetch.mjs';

const THS_URL = 'https://news.10jqka.com.cn/tapp/news/push/stock/';

// ─── Keywords for signal detection ────────────────────────────────────────────

const TOPIC_KEYWORDS = {
  geopolitical: ['伊朗', '以色列', '美国', '俄罗斯', '乌克兰', '中东', '制裁', '战争', '冲突', '美军', '北约', '胡塞', '霍尔木兹'],
  macro: ['央行', '降息', '加息', 'CPI', 'PPI', 'GDP', '非农', '人民币', '汇率', '外汇', '流动性', '宽松', '紧缩', '美联储', '财政部'],
  trade: ['关税', '出口', '进口', '贸易战', 'WTO', '谈判', '协议', '大豆', '玉米', '液化气', '原油', '天然气'],
  sector_tech: ['芯片', '半导体', 'AI', '人工智能', '算力', '光刻', '麒麟', '华为', '算力', '大模型'],
  sector_newenergy: ['锂', '储能', '光伏', '电动车', '新能源', '宁德', '比亚迪'],
  sector_medical: ['医保', '创新药', '疫苗', '中药', '器械', '医疗'],
  market: ['外资', '北向', '净买入', '净卖出', '主力', '涨停', '跌停', '龙虎榜', '杠杆', '爆雷', '违约'],
};

// ─── Parse ─────────────────────────────────────────────────────────────────

function extractTopics(item) {
  const text = `${item.title || ''} ${item.digest || ''} ${item.tag || ''}`;
  const matched = [];
  for (const [topic, kws] of Object.entries(TOPIC_KEYWORDS)) {
    if (kws.some(k => text.includes(k))) matched.push(topic);
  }
  return [...new Set(matched)];
}

// ─── Briefing ───────────────────────────────────────────────────────────────

export async function briefing() {
  const r = await safeFetch(THS_URL + '?page=1&tag=&track=website&pagesize=50', { timeout: 10000 });
  const list = r?.data?.list || [];

  // Parse timestamps
  const now = Date.now();
  const items = list.map(item => {
    const ts = parseInt(item.ctime) * 1000;
    const ageMin = ts ? Math.round((now - ts) / 60000) : null;
    return {
      id: item.id,
      title: item.title,
      digest: item.digest,
      source: item.source,
      tag: item.tag || '',
      url: item.url || item.shareUrl || '',
      timestamp: ts ? new Date(ts).toISOString() : null,
      ageMin,
      stocks: item.stock || [],
      topics: extractTopics(item),
    };
  });

  // Signal: detect breaking/urgent items
  const urgentKeywords = ['突发', '紧急', '刚刚', '快讯', '重磅', '深夜', '凌晨', '暴涨', '闪崩', '制裁', '战争'];
  const urgent = items.filter(i => urgentKeywords.some(k => i.title.includes(k)));
  const recent = items.filter(i => i.ageMin !== null && i.ageMin <= 30);
  const geopol = items.filter(i => i.topics.includes('geopolitical'));
  const macro = items.filter(i => i.topics.includes('macro'));
  const tech = items.filter(i => i.topics.includes('sector_tech'));
  const newenergy = items.filter(i => i.topics.includes('sector_newenergy'));

  // Build signals
  const signals = [];
  if (urgent.length > 0) signals.push(`⚡ ${urgent.length}条突发/重磅快讯`);
  if (recent.length > 0) signals.push(`📰 ${recent.length}条30分钟内最新`);
  if (geopol.length > 0) signals.push(`🌍 地缘政治相关 ${geopol.length}条`);
  if (macro.length > 0) signals.push(`📊 宏观经济相关 ${macro.length}条`);
  if (tech.length > 0) signals.push(`💻 科技/AI相关 ${tech.length}条`);
  if (newenergy.length > 0) signals.push(`⚡ 新能源相关 ${newenergy.length}条`);

  return {
    source: 'THS/10jqka',
    timestamp: new Date().toISOString(),
    signals,
    urgent: urgent.slice(0, 5),
    recent: recent.slice(0, 10),
    geopol: geopol.slice(0, 5),
    macro: macro.slice(0, 5),
    tech: tech.slice(0, 5),
    all: items.slice(0, 30),
    summary: {
      total: items.length,
      urgent: urgent.length,
      recent30m: recent.length,
      geopolCount: geopol.length,
      macroCount: macro.length,
      techCount: tech.length,
      newenergyCount: newenergy.length,
    },
  };
}

if (process.argv[1]?.endsWith('cnnews.mjs')) {
  console.log('中国快讯 — fetching from 同花顺...\n');
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
