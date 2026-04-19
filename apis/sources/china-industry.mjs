// china-industry.mjs — Gray 信息站：行业动态 + 竞品监控模块
// 监控：AI/机器人/半导体行业新闻 + 品牌关键词新闻
// 数据来源：新浪财经 + 东方财富快讯 + 财联社
// 无需 API key，国内直连

const KEYWORDS = [
  'AI', '人工智能', '机器人', '人形机器人', '半导体', '芯片', '大模型',
  '智能驾驶', '自动驾驶', '算力', 'GPU', 'AI芯片',
  '英伟达', 'AMD', '英特尔', '华为', '昇腾',
  '台积电', 'DeepSeek', 'OpenAI', 'ChatGPT',
  '机器学习', '神经网络', '处理器', '晶圆',
  '宁德时代', '比亚迪', '新能源', '智能汽车',
  '算力', 'AI应用', '大模型', '通用人工智能', 'AIGC'
];

const BRAND_KEYWORDS = [
  // 科技/消费电子
  '苹果', 'Apple', 'iPhone', 'MacBook', 'iPad', 'AirPods',
  '华为', 'Huawei', 'Mate', 'P系列',
  '小米', 'Xiaomi', 'SU7', 'Redmi',
  'OPPO', 'vivo', '一加',
  '三星', 'Samsung', 'Galaxy',
  '索尼', 'Sony', 'PlayStation',
  '大疆', 'DJI', '无人机',
  // 家电/高端消费品
  '戴森', 'Dyson', '吹风机', '吸尘器',
  'BangOlufsen', 'B&O', '音响',
  'Sonos',
  // 汽车
  '保时捷', 'Porsche', 'Taycan',
  '奔驰', 'Mercedes-Benz', 'EQ',
  '宝马', 'BMW', 'i系列',
  '特斯拉', 'Tesla', 'Model',
  '比亚迪', '仰望',
  // 投资/金融相关品牌
  'LV', 'Louis Vuitton', 'Gucci', 'Nike', 'Adidas'
];

function matches(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

async function fetchSina(count = 30) {
  try {
    const url = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2517&num=' + count + '&page=1&r=0.5';
    const res = await fetch(url, {
      headers: { Referer: 'https://finance.sina.com.cn' }
    });
    const data = await res.json();
    const items = data?.result?.data || [];
    return items.map(it => ({
      title: it.title || '',
      url: it.url || '',
      time: it.ctime || '',
      source: '新浪财经',
      domain: 'sina.com.cn',
      intro: it.intro || ''
    }));
  } catch (e) { return []; }
}

async function fetchEastmoney(count = 20) {
  try {
    const params = new URLSearchParams({
      client: 'web', biz: 'web_fast',
      page: 1, pageSize: count, order: 1,
      fastColumn: 152
    });
    const res = await fetch(
      'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?' + params,
      { headers: { Referer: 'https://www.eastmoney.com' } }
    );
    const data = await res.json();
    const items = data?.data?.list || [];
    return items.map(it => ({
      title: (it.title || it.content || '').slice(0, 120),
      url: it.url || '',
      time: it.showTime || '',
      source: '东方财富',
      domain: 'eastmoney.com',
      intro: it.content || ''
    }));
  } catch (e) { return []; }
}

async function fetchCls(count = 15) {
  try {
    const params = new URLSearchParams({
      app: 'CLS', os: 'web', sv: '7.6.0',
      page: 1, rn: count, level: '1,2,3', tsType: '2,1'
    });
    const res = await fetch(
      'https://www.cls.cn/nodeapi/updateTelegraph?' + params
    );
    const data = await res.json();
    const items = data?.data?.roll_data || [];
    return items.map(it => ({
      title: ((it.content || '') + (it.title || '')).slice(0, 120),
      url: it.url || '',
      time: it.ctime || '',
      source: '财联社',
      domain: 'cls.cn',
      intro: it.content || ''
    }));
  } catch (e) { return []; }
}

function filterAndTag(items) {
  const industry = [], brand = [];
  const seen = new Set();

  for (const it of items) {
    const text = it.title + ' ' + it.intro;
    const key = it.title.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);

    const tagged = { ...it, category: null };

    if (matches(text, KEYWORDS)) {
      tagged.category = 'industry';
      industry.push(tagged);
    } else if (matches(text, BRAND_KEYWORDS)) {
      tagged.category = 'brand';
      brand.push(tagged);
    }
  }

  return { industry, brand };
}

export async function fetchIndustryNews() {
  const [em, sina, cls] = await Promise.all([
    fetchEastmoney(30),
    fetchSina(30),
    fetchCls(15)
  ]);

  const all = [...em, ...sina, ...cls];
  const { industry, brand } = filterAndTag(all);

  // Sort by time desc
  const sortByTime = (arr) => arr.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

  return {
    source: 'ChinaIndustry',
    timestamp: new Date().toISOString(),
    industry: sortByTime(industry).slice(0, 15),
    brand: sortByTime(brand).slice(0, 10),
    stats: {
      total: em.length + sina.length + cls.length,
      industry: industry.length,
      brand: brand.length,
      sources: { eastmoney: em.length, sina: sina.length, cls: cls.length }
    }
  };
}

if (process.argv[1]?.includes('china-industry')) {
  const data = await fetchIndustryNews();
  console.log(JSON.stringify(data, null, 2));
}
