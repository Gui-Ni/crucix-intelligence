#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec, execSync } from 'child_process';
import { createHash } from 'crypto';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { generateLLMIdeas } from './lib/llm/ideas.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RUNS_DIR = join(ROOT, 'runs');
const MEMORY_DIR = join(RUNS_DIR, 'memory');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === State ===
let currentData = null;    // Current synthesized dashboard data
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
const startTime = Date.now();
const sseClients = new Set();

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);

// === LLM + Telegram + Discord ===
const llmProvider = createLLMProvider(config.llm);
const telegramAlerter = new TelegramAlerter(config.telegram);
const discordAlerter = new DiscordAlerter(config.discord || {});

// === Vercel Relay ===
const VERCEL_RELAY_URL = process.env.VERCEL_RELAY_URL || null;

async function pushToVercel(data) {
  if (!VERCEL_RELAY_URL) return;
  try {
    const url = VERCEL_RELAY_URL.replace(/\/$/, '') + '/api/data';
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    console.log(`[Crucix] Pushed to Vercel: ${VERCEL_RELAY_URL}`);
  } catch (e) {
    console.warn('[Crucix] Vercel push failed:', e.message);
  }
}

// === Auto-deploy: update jarvis.html inline data + push to GitHub ===
const AUTO_DEPLOY = process.env.AUTO_DEPLOY === 'true';

function getDataHash(html) {
  const m = html.match(/let D = (\{[\s\S]*?\});/);
  if (!m) return null;
  return createHash('sha256').update(m[1]).digest('hex').slice(0, 12);
}

async function updateAndPushHtml(data) {
  if (!AUTO_DEPLOY) return;
  try {
    const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
    const html = readFileSync(htmlPath, 'utf8');
    const json = JSON.stringify(data);
    const updated = html.replace(/let D = \{[\s\S]*?\};/m, 'let D = ' + json + ';');

    const oldHash = getDataHash(html);
    const newHash = getDataHash(updated);
    console.log(`[Crucix] updateAndPushHtml: oldHash=${oldHash} newHash=${newHash} same=${oldHash===newHash}`);
    if (oldHash === newHash) return;

    writeFileSync(htmlPath, updated);

    // Git commit — use --allow-empty to force commit even if git thinks nothing changed
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    execSync(`git add dashboard/public/jarvis.html`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    const diff = execSync(`git diff --cached --stat`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    console.log(`[Crucix] git diff: ${diff.toString().trim()}`);

    // If git diff is empty but hashes differ, force commit with --allow-empty
    const diffStr = diff.toString().trim();
    if (!diffStr) {
      console.log('[Crucix] Forcing commit despite empty diff (hash changed)');
    }
    execSync(`git commit -m "chore: auto-update dashboard data ${timestamp}" --allow-empty`, { cwd: ROOT, stdio: 'ignore' });
    execSync('git push origin master', { cwd: ROOT, stdio: 'ignore' });
    console.log('[Crucix] jarvis.html pushed to GitHub — Vercel will auto-deploy');
  } catch (e) {
    console.warn('[Crucix] GitHub push failed:', e.message, e.stack?.split('\n')[1] || '');
  }
}

if (llmProvider) console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
if (telegramAlerter.isConfigured) {
  console.log('[Crucix] Telegram alerts enabled');

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  telegramAlerter.onCommand('/status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ 已关闭';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : '待定';

    return [
      `🖥️ *CRUCIX 状态*`,
      ``,
      `运行时间: ${h}小时${m}分钟`,
      `上次扫描: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : '从未'}`,
      `下次扫描: ${nextSweep} UTC`,
      `扫描进行中: ${sweepInProgress ? '🔄 是' : '⏸️ 否'}`,
      `数据源: ${sourcesOk}/${sourcesTotal} 正常${sourcesFailed > 0 ? `（${sourcesFailed}个失败）` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE客户端: ${sseClients.size}`,
      `仪表盘: http://localhost:${config.port}`,
    ].join('\n');
  });

  telegramAlerter.onCommand('/sweep', async () => {
    if (sweepInProgress) return '🔄 扫描正在进行中，请稍候。';
    // Fire and forget — don't block the bot response
    runSweepCycle().catch(err => console.error('[Crucix] 手动扫描失败:', err.message));
    return '🚀 手动扫描已触发。如果检测到重要信号，您将收到警报。';
  });

  telegramAlerter.onCommand('/brief', async () => {
    if (!currentData) return '⏳ 暂无数据 — 等待首次扫描完成。';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const metals = currentData.metals || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [
      `📋 *CRUCIX 简报*`,
      `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`,
      ``,
    ];

    // Delta direction
    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      const dirLabel = { 'risk-off': '风险规避', 'risk-on': '风险偏好', 'mixed': '中性' }[delta.summary.direction] || delta.summary.direction.toUpperCase();
      sections.push(`${dirEmoji} 方向: *${dirLabel}* | ${delta.summary.totalChanges}个变化，${delta.summary.criticalChanges}个严重`);
      sections.push('');
    }

    // Key metrics
    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti || metals.gold || metals.silver) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | 布伦特: $${energy.brent || '--'}`);
      sections.push(`   黄金: $${metals.gold || '--'} | 白银: $${metals.silver || '--'}${hy ? ` | HY利差: ${hy.value}` : ''}`);
      sections.push(`   天然气: $${energy.natgas || '--'}`);
      sections.push('');
    }

    // OSINT
    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length}条紧急信号，${tg.posts || 0}条总帖子`);
      // Top 2 urgent
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    // Top ideas
    if (ideas.length > 0) {
      sections.push(`💡 *重点思路:*`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  telegramAlerter.onCommand('/portfolio', async () => {
    return '📊 投资组合需要 Alpaca MCP 连接。\n使用 Crucix 仪表盘或 Claude agent 查询投资组合。';
  });

  // Start polling for bot commands
  telegramAlerter.startPolling(config.telegram.botPollingInterval);
}

// === Discord Bot ===
if (discordAlerter.isConfigured) {
  console.log('[Crucix] Discord bot enabled');

  // Reuse the same command handlers as Telegram (DRY)
  discordAlerter.onCommand('status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ 已关闭';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : '待定';

    return [
      `**🖥️ CRUCIX 状态**\n`,
      `运行时间: ${h}小时${m}分钟`,
      `上次扫描: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : '从未'}`,
      `下次扫描: ${nextSweep} UTC`,
      `扫描进行中: ${sweepInProgress ? '🔄 是' : '⏸️ 否'}`,
      `数据源: ${sourcesOk}/${sourcesTotal} 正常${sourcesFailed > 0 ? `（${sourcesFailed}个失败）` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE客户端: ${sseClients.size}`,
      `仪表盘: http://localhost:${config.port}`,
    ].join('\n');
  });

  discordAlerter.onCommand('sweep', async () => {
    if (sweepInProgress) return '🔄 扫描正在进行中，请稍候。';
    runSweepCycle().catch(err => console.error('[Crucix] 手动扫描失败:', err.message));
    return '🚀 手动扫描已触发。如果检测到重要信号，您将收到警报。';
  });

  discordAlerter.onCommand('brief', async () => {
    if (!currentData) return '⏳ 暂无数据 — 等待首次扫描完成。';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const metals = currentData.metals || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [`**📋 CRUCIX 简报**\n_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_\n`];

    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      const dirLabel = { 'risk-off': '风险规避', 'risk-on': '风险偏好', 'mixed': '中性' }[delta.summary.direction] || delta.summary.direction.toUpperCase();
      sections.push(`${dirEmoji} 方向: **${dirLabel}** | ${delta.summary.totalChanges}个变化，${delta.summary.criticalChanges}个严重\n`);
    }

    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti || metals.gold || metals.silver) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | 布伦特: $${energy.brent || '--'}`);
      sections.push(`   黄金: $${metals.gold || '--'} | 白银: $${metals.silver || '--'}${hy ? ` | HY利差: ${hy.value}` : ''}`);
      sections.push(`   天然气: $${energy.natgas || '--'}`);
      sections.push('');
    }

    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length}条紧急信号，${tg.posts || 0}条总帖子`);
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    if (ideas.length > 0) {
      sections.push(`**💡 重点思路:**`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  discordAlerter.onCommand('portfolio', async () => {
    return '📊 投资组合需要 Alpaca MCP 连接。\n使用 Crucix 仪表盘或 Claude agent 查询投资组合。';
  });

  // Start the Discord bot (non-blocking — connection happens async)
  discordAlerter.start().catch(err => {
    console.error('[Crucix] Discord bot startup failed (non-fatal):', err.message);
  });
}

// === Express Server ===
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.static(join(ROOT, 'dashboard/public')));

// Serve loading page until first sweep completes, then the dashboard with injected locale
app.get('/', (req, res) => {
  if (!currentData) {
    const loadingPath = join(ROOT, 'dashboard/public/loading.html');
    if (existsSync(loadingPath)) {
      res.sendFile(loadingPath);
    } else {
      res.status(503).type('html').send('<html><body><h1>CRUCIX is starting up...</h1><p>Refresh in a few seconds.</p></body></html>');
    }
  } else {
    const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
    let html = readFileSync(htmlPath, 'utf-8');
    
    // Inject locale data into the HTML
    const locale = getLocale();
    const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${JSON.stringify(locale).replace(/<\/script>/gi, '<\\/script>')};</script>`;
    html = html.replace('</head>', `${localeScript}\n</head>`);
    
    res.type('html').send(html);
  }
});

// Global error handler — prevents unhandled errors from showing OS popups
app.use((err, req, res, next) => {
  console.error('[Crucix] Request error:', err.message);
  if (!res.headersSent) {
    res.status(err.status || 500).type('txt').send(err.message || 'Internal error');
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  // Prefer in-memory currentData (local server), fall back to /tmp/latest.json (Vercel serverless)
  if (currentData) return res.json(currentData);
  try {
    if (existsSync('/tmp/latest.json')) {
      const data = JSON.parse(readFileSync('/tmp/latest.json', 'utf8'));
      return res.json(data);
    }
  } catch (_) {}
  res.status(503).json({ error: 'Data not ready yet — local server is still warming up' });
});

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmEnabled: !!config.llm.provider,
    llmProvider: config.llm.provider,
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    language: currentLanguage,
  });
});

// API: trigger sweep (used by Vercel Cron)
app.post('/api/sweep', (req, res) => {
  if (sweepInProgress) {
    return res.status(409).json({ error: 'Sweep already in progress' });
  }
  runSweepCycle().catch(err => console.error('[Cron] Sweep failed:', err.message));
  res.json({ status: 'triggered', time: new Date().toISOString() });
});

// API: receive sweep data from local server (local PM2 -> Vercel relay)
app.post('/api/push-data', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid data' });
    }
    // Persist to Vercel's tmp directory (survives across invocations within a warm instance)
    const tmpPath = '/tmp/latest.json';
    writeFileSync(tmpPath, JSON.stringify(data));
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: available locales
app.get('/api/locales', (req, res) => {
  res.json({
    current: currentLanguage,
    supported: getSupportedLocales(),
  });
});

// API: full locale data (for static file serving on Vercel)
app.get('/api/locale', (req, res) => {
  const locale = getLocale();
  res.json(locale);
});

// SSE: live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Crucix] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing();

    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;

    // 5. LLM-powered trade ideas (LLM-only feature) — isolated so failures don't kill sweep
    if (llmProvider?.isConfigured) {
      try {
        console.log('[Crucix] Generating LLM trade ideas...');
        const previousIdeas = memory.getLastRun()?.ideas || [];
        const llmIdeas = await generateLLMIdeas(llmProvider, synthesized, delta, previousIdeas);
        if (llmIdeas) {
          synthesized.ideas = llmIdeas;
          synthesized.ideasSource = 'llm';
          console.log(`[Crucix] LLM generated ${llmIdeas.length} ideas`);
        } else {
          synthesized.ideas = [];
          synthesized.ideasSource = 'llm-failed';
        }
      } catch (llmErr) {
        console.error('[Crucix] LLM ideas failed (non-fatal):', llmErr.message);
        synthesized.ideas = [];
        synthesized.ideasSource = 'llm-failed';
      }
    } else {
      synthesized.ideas = [];
      synthesized.ideasSource = 'disabled';
    }

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Telegram alert error:', err.message);
        });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    currentData = synthesized;

    // Write to /tmp/latest.json so Tailscale-served API can read it
    try {
      writeFileSync('/tmp/latest.json', JSON.stringify(synthesized));
    } catch (_) {}

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    // 7. Push to Vercel relay (if configured)
    pushToVercel(synthesized).catch(err => console.warn('[Crucix] Vercel push failed:', err.message));

    // 8. Update jarvis.html and push to GitHub (triggers Vercel redeploy)
    updateAndPushHtml(synthesized).catch(err => console.warn('[Crucix] GitHub push failed:', err.message));

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

// === Startup ===
async function start() {
  const port = config.port;

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║           CRUCIX INTELLIGENCE ENGINE         ║
  ║          Local Palantir · 26 Sources         ║
  ╠══════════════════════════════════════════════╣
  ║  Dashboard:  http://localhost:${port}${' '.repeat(14 - String(port).length)}║
  ║  Health:     http://localhost:${port}/api/health${' '.repeat(4 - String(port).length)}║
  ║  Refresh:    Every ${config.refreshIntervalMinutes} min${' '.repeat(20 - String(config.refreshIntervalMinutes).length)}║
  ║  LLM:        ${(config.llm.provider || 'disabled').padEnd(31)}║
  ║  Telegram:   ${config.telegram.botToken ? 'enabled' : 'disabled'}${' '.repeat(config.telegram.botToken ? 24 : 23)}║
  ║  Discord:    ${config.discord?.botToken ? 'enabled' : config.discord?.webhookUrl ? 'webhook only' : 'disabled'}${' '.repeat(config.discord?.botToken ? 24 : config.discord?.webhookUrl ? 20 : 23)}║
  ╚══════════════════════════════════════════════╝
  `);

  const server = app.listen(port);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Crucix] FATAL: Port ${port} is already in use!`);
      console.error(`[Crucix] A previous Crucix instance may still be running.`);
      console.error(`[Crucix] Fix:  taskkill /F /IM node.exe   (Windows)`);
      console.error(`[Crucix]       kill $(lsof -ti:${port})   (macOS/Linux)`);
      console.error(`[Crucix] Or change PORT in .env\n`);
    } else {
      console.error(`[Crucix] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  server.on('listening', async () => {
    console.log(`[Crucix] Server running on http://localhost:${port}`);

    // Auto-open browser
    // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
    // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
    const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} "http://localhost:${port}"`, (err) => {
      if (err) console.log('[Crucix] Could not auto-open browser:', err.message);
    });

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      const data = await synthesize(existing);
      currentData = data;
      // Also write to /tmp/latest.json so Tailscale-served API can read it
      try { writeFileSync('/tmp/latest.json', JSON.stringify(data)); } catch (_) {}
      console.log('[Crucix] Loaded existing data from runs/latest.json — dashboard ready instantly');
      broadcast({ type: 'update', data: currentData });
    } catch {
      console.log('[Crucix] No existing data found — first sweep required');
    }

    // Run first sweep (refreshes data in background)
    console.log('[Crucix] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Crucix] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);
  });
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
});

// Only start the local server when NOT running on Vercel serverless
if (process.env.VERCEL !== '1') {
  start().catch(err => {
    console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
    process.exit(1);
  });
}
