// UN Comtrade — 贸易数据轻量版
// 使用 UN Comtrade 公开预览 API，数据量小，无需注册
// https://comtradeapi.un.org/public/v1/preview

import { safeFetch, daysAgo } from '../utils/fetch.mjs';

const BASE = 'https://comtradeapi.un.org/public/v1/preview';

// 高影响力贸易数据：原油、天然气、半导体、黄金、武器
async function getTradeFlow(partnerCode, commodityCode, reporterCode = '156') {
  try {
    const url = `${BASE}?reporterCode=${reporterCode}&partnerCode=${partnerCode}&period=202512&cmdCode=${commodityCode}&type=C&freq=M`;
    const data = await safeFetch(url, { timeout: 12000 });
    if (data?.error) return { commodityCode, error: data.error };
    const records = data?.data || [];
    const latest = records[0] || {};
    return {
      commodityCode,
      period: latest.period || null,
      primaryValue: latest.primaryValue || 0,
      netWeight: latest.netWeightKg || 0,
      quantity: latest.quantity || 0,
      classification: latest.classification || latest.cmdCode,
    };
  } catch (e) {
    return { commodityCode, error: e.message };
  }
}

export async function briefing() {
  // 查询中国与主要伙伴的战略性商品贸易
  // 合作伙伴：俄罗斯(643)、美国(842)、沙特(682)、欧盟总和(all)
  // 商品：原油(2709)、天然气(2711)、黄金(7108)、半导体(8542)

  const [crude, gas, gold, chips] = await Promise.allSettled([
    getTradeFlow('all', '2709'),  // 全球原油
    getTradeFlow('all', '2711'),  // 全球天然气
    getTradeFlow('all', '7108'),  // 全球黄金
    getTradeFlow('all', '8542'),  // 全球半导体
  ]);

  const results = {
    crudeOil: crude.status === 'fulfilled' ? crude.value : { error: 'timeout' },
    naturalGas: gas.status === 'fulfilled' ? gas.value : { error: 'timeout' },
    gold: gold.status === 'fulfilled' ? gold.value : { error: 'timeout' },
    semiconductors: chips.status === 'fulfilled' ? chips.value : { error: 'timeout' },
  };

  // 生成信号
  const signals = [];
  const add = (label, val) => {
    if (val && !val.error) {
      const v = val.primaryValue;
      if (v > 0) signals.push(`${label} 最新贸易额 $${(v / 1e6).toFixed(1)}M`);
    }
  };

  add('全球原油进口', results.crudeOil);
  add('全球天然气进口', results.naturalGas);
  add('全球黄金', results.gold);
  add('全球半导体进口', results.semiconductors);

  return {
    source: 'UN Comtrade',
    timestamp: new Date().toISOString(),
    status: 'lightweight_preview_api',
    signals,
    data: results,
    note: '使用UN Comtrade公开预览API，数据延迟约2个月，但覆盖主要商品贸易流',
  };
}

if (process.argv[1]?.endsWith('comtrade.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
