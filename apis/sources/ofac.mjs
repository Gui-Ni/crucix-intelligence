// OFAC — US Treasury Sanctions List (SDN) 轻量版
// 官方公开制裁搜索 API，无需下载数百MB的XML
// https://ofac.treas.gov/api

import { safeFetch } from '../utils/fetch.mjs';

// 制裁搜索 API — 查询关键词
async function searchOFAC(query) {
  try {
    const url = `https://api.ofac.treas.gov/api/v1/sdn?q=${encodeURIComponent(query)}&rows=5`;
    const data = await safeFetch(url, { timeout: 12000 });
    if (data?.error) return { error: data.error };
    const entries = data?.results || [];
    return {
      results: entries.slice(0, 5).map(e => ({
        uid: e.uid,
        name: e.name,
        type: e.sdnType || e.type,
        programs: e.program || [],
        id: e.id,
      })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

export async function briefing() {
  // 轻量查询：搜几个高相关关键词
  const [iran, russia, northKorea, sanctionedBanks] = await Promise.allSettled([
    searchOFAC('Iran'),
    searchOFAC('Russia'),
    searchOFAC('North Korea'),
    searchOFAC('bank'),
  ]);

  const results = {
    Iran:     iran.status    === 'fulfilled' ? iran.value    : { error: 'timeout' },
    Russia:   russia.status  === 'fulfilled' ? russia.value  : { error: 'timeout' },
    NorthKorea: northKorea.status === 'fulfilled' ? northKorea.value : { error: 'timeout' },
    Banks:    sanctionedBanks.status === 'fulfilled' ? sanctionedBanks.value : { error: 'timeout' },
  };

  const signals = [];
  const totalResults = Object.values(results)
    .filter(r => !r.error && r.results)
    .reduce((s, r) => s + (r.results?.length || 0), 0);

  if (totalResults > 0) {
    signals.push(`OFAC 制裁名单共查到 ${totalResults} 条相关记录`);
  }

  return {
    source: 'OFAC Sanctions',
    timestamp: new Date().toISOString(),
    status: 'lightweight_api',
    signals,
    searchResults: results,
    note: '使用OFAC公开搜索API，轻量查询，无需下载数百MB XML',
  };
}

if (process.argv[1]?.endsWith('ofac.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
