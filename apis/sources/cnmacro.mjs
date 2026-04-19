// 中国宏观数据 — AkShare 实时接口
// GDP / CPI / PMI / M2 / 社融 等核心宏观指标
// Python 环境: D:\Anaconda\python.exe

import { spawn } from 'child_process';
import { safeFetch } from '../utils/fetch.mjs';

const PYTHON = 'D:\\Anaconda\\python.exe';

function runPy(script) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, ['-X', 'utf8', '-c', script], {
      timeout: 20000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', () => {
      try { resolve(JSON.parse(out)); }
      catch { resolve({ raw: out.slice(0, 500), error: err.slice(0, 200) }); }
    });
    proc.on('error', e => resolve({ error: e.message }));
  });
}

export async function briefing() {
  const script = `
import akshare as ak, json, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

out = {}

# GDP — 最新季度
try:
    g = ak.macro_china_gdp()
    r = g.head(1).to_dict('records')[0]
    out['gdp'] = {'period': g.iloc[0,0], 'value': r.get(list(g.columns)[1]), 'yoy': r.get(list(g.columns)[2])}
    out['gdp_history'] = [g.iloc[i,0] + ': ' + str(g.iloc[i,2]) + '%' for i in range(min(5, len(g)))]
except Exception as e:
    out['gdp_error'] = str(e)[:80]

# CPI — 最新月份
try:
    c = ak.macro_china_cpi()
    r = c.head(1).to_dict('records')[0]
    cols = list(c.columns)
    out['cpi'] = {'period': c.iloc[0,0], 'yoy': r.get(cols[2]), 'mom': r.get(cols[3]) if len(cols) > 3 else None}
except Exception as e:
    out['cpi_error'] = str(e)[:80]

# PMI — 最新月份 (cols: 月份, 制造业-指数, 制造业-同比增长, 非制造业-指数, 非制造业-同比增长)
try:
    p = ak.macro_china_pmi()
    r = p.head(1).to_dict('records')[0]
    cols = list(p.columns)
    out['pmi'] = {
        'period': r.get(cols[0]),
        'mfg': r.get(cols[1]),
        'mfg_yoy': r.get(cols[2]),
        'non_mfg': r.get(cols[3]) if len(cols) > 3 else None,
        'non_mfg_yoy': r.get(cols[4]) if len(cols) > 4 else None,
    }
except Exception as e:
    out['pmi_error'] = str(e)[:80]

# M2 货币供应 (akshare 正确接口)
try:
    m = ak.macro_china_supply_of_money()
    r = m.head(1).to_dict('records')[0]
    cols = list(m.columns)
    out['m2'] = {'period': r.get(cols[0]), 'm2_yoy': r.get(cols[1])}
except Exception as e:
    try:
        m = ak.macro_china_shibor()
        r = m.head(1).to_dict('records')[0]
        cols = list(m.columns)
        out['m2'] = {'period': r.get(cols[0]), 'shibor_1y': r.get(cols[1])}
    except Exception as e2:
        out['m2_error'] = str(e)[:80]

print(json.dumps(out, ensure_ascii=False))
`;

  const data = await runPy(script);
  const gdp = data?.gdp;
  const cpi = data?.cpi;
  const pmi = data?.pmi;
  const m2  = data?.m2;

  // Signals
  const signals = [];
  if (gdp) {
    const yoy = parseFloat(gdp.yoy);
    if (yoy >= 5) signals.push(`GDP ${gdp.period} ${yoy}% ✅ 符合目标（5%左右）`);
    else signals.push(`GDP ${gdp.period} ${yoy}% ⚠️ 低于目标`);
  }
  if (cpi) {
    const yoy = parseFloat(cpi.yoy);
    if (yoy < 1) signals.push(`CPI ${cpi.period} 同比${yoy}% ⚠️ 通缩压力`);
    else if (yoy > 3) signals.push(`CPI ${cpi.period} 同比${yoy}% 🔴 通胀上行`);
    else signals.push(`CPI ${cpi.period} 同比${yoy}% ✅ 温和可控`);
  }
  if (pmi?.mfg) {
    const m = parseFloat(pmi.mfg);
    const label = typeof m === 'number' && !isNaN(m) ? m : pmi.mfg;
    if (typeof m === 'number' && !isNaN(m)) {
      if (m >= 50) signals.push(`制造业PMI ${pmi.period} ${m} ✅ 扩张区间`);
      else signals.push(`制造业PMI ${pmi.period} ${m} ⚠️ 收缩区间`);
    } else {
      signals.push(`PMI数据: ${JSON.stringify(pmi)}`);
    }
  }

  return {
    source: 'AkShare/CN-Macro',
    timestamp: new Date().toISOString(),
    data: {
      gdp:    gdp    || { error: data?.gdp_error || 'failed' },
      cpi:    cpi    || { error: data?.cpi_error || 'failed' },
      pmi:    pmi    || { error: data?.pmi_error || 'failed' },
      m2:     m2     || { error: data?.m2_error  || 'failed' },
    },
    signals,
    note: '使用 AkShare 获取国家统计局权威宏观数据，Python: D:\\Anaconda\\python.exe',
  };
}

if (process.argv[1]?.endsWith('cnmacro.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
