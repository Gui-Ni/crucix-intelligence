// Telegram Alerter v2 — Multi-tier alerts, semantic dedup, two-way bot commands
// USP feature: Crucix becomes a conversational intelligence agent via Telegram

import { createHash } from 'crypto';

const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram Bot API limit for sendMessage text (bytes/characters). */
const TELEGRAM_MAX_TEXT = 4096;

// ─── Alert Tiers ────────────────────────────────────────────────────────────
// FLASH:    立即行动 — 市场重大变化、时效性强（如战争升级、闪崩）
// PRIORITY: 重要信号聚合 — 数小时内处理（如利率意外、重大OSINT转变）
// ROUTINE:  值得关注的变化 — 参考，无紧迫性（如趋势延续、适度Delta）

const TIER_CONFIG = {
  FLASH:    { emoji: '🔴', label: '闪报',    cooldownMs: 5 * 60 * 1000,  maxPerHour: 6 },
  PRIORITY: { emoji: '🟡', label: '优先',    cooldownMs: 30 * 60 * 1000, maxPerHour: 4 },
  ROUTINE:  { emoji: '🔵', label: '常规',    cooldownMs: 60 * 60 * 1000, maxPerHour: 2 },
};

// ─── Bot Commands ───────────────────────────────────────────────────────────
const COMMANDS = {
  '/status':    '获取系统状态、上次扫描时间、数据源状态',
  '/sweep':     '触发手动扫描周期',
  '/brief':     '获取最新情报的紧凑文本摘要',
  '/portfolio': '显示当前持仓和盈亏（需Alpaca连接）',
  '/alerts':    '显示最近警报历史',
  '/mute':      '静音警报1小时（或 /mute 2h, /mute 4h）',
  '/unmute':    '恢复警报',
  '/help':      '显示可用命令',
};

export class TelegramAlerter {
  constructor({ botToken, chatId }) {
    this.botToken = botToken;
    this.chatId = chatId;
    this._alertHistory = [];     // Recent alerts for rate limiting
    this._contentHashes = {};    // Semantic dedup: hash → timestamp
    this._muteUntil = null;      // Mute timestamp
    this._lastUpdateId = 0;      // For polling bot commands
    this._commandHandlers = {};  // Registered command callbacks
    this._pollingInterval = null;
    this._botUsername = null;
  }

  get isConfigured() {
    return !!(this.botToken && this.chatId);
  }

  // ─── Core Messaging ─────────────────────────────────────────────────────

  /**
   * Send a message via Telegram Bot API. Splits at TELEGRAM_MAX_TEXT so long messages
   * (e.g. /brief) are sent in multiple messages instead of being truncated or failing.
   * @param {string} message - markdown-formatted message
   * @param {object} opts - optional: { parseMode, disablePreview, replyToMessageId, chatId }
   * @returns {Promise<{ok: boolean, messageId?: number}>}
   */
  async sendMessage(message, opts = {}) {
    if (!this.isConfigured) return { ok: false };
    const chatId = opts.chatId ?? this.chatId;
    const parseMode = opts.parseMode || 'Markdown';
    const chunks = this._chunkText(message, TELEGRAM_MAX_TEXT);

    try {
      let lastResult = { ok: false, messageId: undefined };
      for (let i = 0; i < chunks.length; i++) {
        const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunks[i],
            parse_mode: parseMode,
            disable_web_page_preview: opts.disablePreview !== false,
            ...(opts.replyToMessageId && i === 0 ? { reply_to_message_id: opts.replyToMessageId } : {}),
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
          const err = await res.text().catch(() => '');
          console.error(`[Telegram] Send failed (${res.status}): ${err.substring(0, 200)}`);
          return lastResult;
        }

        const data = await res.json();
        lastResult = { ok: true, messageId: data.result?.message_id };
      }
      return lastResult;
    } catch (err) {
      console.error('[Telegram] Send error:', err.message);
      return { ok: false };
    }
  }

  /**
   * Split text into chunks of at most maxLen. Prefer breaking at newlines to avoid
   * splitting mid-Markdown.
   */
  _chunkText(text, maxLen = TELEGRAM_MAX_TEXT) {
    if (!text || text.length <= maxLen) return text ? [text] : [];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxLen, text.length);
      if (end < text.length) {
        const lastNewline = text.lastIndexOf('\n', end - 1);
        if (lastNewline > start) end = lastNewline + 1;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  // Backward-compatible alias
  async sendAlert(message) {
    const result = await this.sendMessage(message);
    return result.ok;
  }

  // ─── Multi-Tier Alert Evaluation ────────────────────────────────────────

  /**
   * Evaluate delta signals with LLM and send tiered alert if warranted.
   * Uses semantic dedup, rate limiting, and a much richer evaluation prompt.
   */
  async evaluateAndAlert(llmProvider, delta, memory) {
    if (!this.isConfigured) return false;
    if (!delta?.summary?.totalChanges) return false;
    if (this._isMuted()) {
      console.log('[Telegram] 警报已静音至', new Date(this._muteUntil).toLocaleTimeString());
      return false;
    }

    // 1. Gather new signals — filter already-alerted AND semantically duplicate
    const allSignals = [
      ...(delta.signals?.new || []),
      ...(delta.signals?.escalated || []),
    ];

    const newSignals = allSignals.filter(s => {
      const key = this._signalKey(s);
      // Check decay-based suppression (if memory supports it)
      if (typeof memory.isSignalSuppressed === 'function') {
        if (memory.isSignalSuppressed(key)) return false;
      } else {
        // Legacy: check flat alerted map
        const alerted = memory.getAlertedSignals();
        if (alerted[key]) return false;
      }
      // Check semantic/content hash dedup
      if (this._isSemanticDuplicate(s)) return false;
      return true;
    });

    if (newSignals.length === 0) return false;

    // 2. Try LLM evaluation first, fall back to rule-based if unavailable
    let evaluation = null;

    if (llmProvider?.isConfigured) {
      try {
        const systemPrompt = this._buildEvaluationPrompt();
        const userMessage = this._buildSignalContext(newSignals, delta);
        const result = await llmProvider.complete(systemPrompt, userMessage, {
          maxTokens: 800,
          timeout: 30000,
        });
        evaluation = parseJSON(result.text);
      } catch (err) {
        console.warn('[Telegram] LLM评估失败，回退到规则引擎:', err.message);
        // Fall through to rule-based evaluation
      }
    }

    // Rule-based fallback: fires when LLM is unavailable or returns garbage
    if (!evaluation || typeof evaluation.shouldAlert !== 'boolean') {
      evaluation = this._ruleBasedEvaluation(newSignals, delta);
      if (evaluation) evaluation._source = 'rules';
    }

    if (!evaluation?.shouldAlert) {
      console.log('[Telegram] 不触发警报 —', evaluation?.reason || '无符合条件信号');
      return false;
    }

    // 3. Validate tier and check rate limits
    const tier = TIER_CONFIG[evaluation.tier] ? evaluation.tier : 'ROUTINE';
    if (!this._checkRateLimit(tier)) {
      console.log(`[Telegram] 等级${tier}触发频繁，已限制`);
      return false;
    }

    // 4. Format and send tiered alert
    const message = this._formatTieredAlert(evaluation, delta, tier);
    const sent = await this.sendAlert(message);

    if (sent) {
      // Mark signals as alerted with content hashing
      for (const s of newSignals) {
        const key = this._signalKey(s);
        memory.markAsAlerted(key, new Date().toISOString());
        this._recordContentHash(s);
      }
      this._recordAlert(tier);
      console.log(`[Telegram] ${tier}警报已发送(${evaluation._source || 'llm'}): ${evaluation.headline}`);
    }

    return sent;
  }

  // ─── Rule-Based Alert Fallback ────────────────────────────────────────

  /**
   * Deterministic alert evaluation when LLM is unavailable.
   * Uses signal counts, severity, and cross-domain correlation.
   */
  _ruleBasedEvaluation(signals, delta) {
    const criticals = signals.filter(s => s.severity === 'critical');
    const highs = signals.filter(s => s.severity === 'high');
    const nukeSignal = signals.find(s => s.key === 'nuke_anomaly');
    const osintNew = signals.filter(s => s.key?.startsWith('tg_urgent'));
    const marketSignals = signals.filter(s => ['vix', 'hy_spread', 'wti', 'brent', 'natgas', 'gold', 'silver', '10y2y'].includes(s.key));
    const conflictSignals = signals.filter(s => ['conflict_events', 'conflict_fatalities', 'thermal_total'].includes(s.key));

    // FLASH: nuclear anomaly, or ≥3 critical signals across domains
    if (nukeSignal) {
      return {
        shouldAlert: true, tier: 'FLASH', confidence: 'HIGH',
        headline: '检测到核异常',
        reason: 'Safecast辐射监测器已标记异常，需要立即关注。',
        actionable: '检查仪表盘上受影响站点，监控二次确认。',
        signals: ['nuke_anomaly'],
        crossCorrelation: '辐射监测器',
      };
    }

    // FLASH: ≥2 critical signals AND they span multiple domains
    const hasCriticalMarket = criticals.some(s => marketSignals.includes(s));
    const hasCriticalConflict = criticals.some(s => conflictSignals.includes(s) || osintNew.includes(s));
    if (criticals.length >= 2 && hasCriticalMarket && hasCriticalConflict) {
      return {
        shouldAlert: true, tier: 'FLASH', confidence: 'HIGH',
        headline: `${criticals.length}个跨域严重信号`,
        reason: `在市场和冲突领域检测到${criticals.length}个严重信号。多域关联表明系统性事件。`,
        actionable: '立即查看仪表盘，评估组合敞口。',
        signals: criticals.map(s => s.label || s.key).slice(0, 5),
        crossCorrelation: '市场+冲突',
      };
    }

    // PRIORITY: ≥2 high/critical signals in same direction
    const escalatedHighs = [...criticals, ...highs].filter(s => s.direction === 'up');
    if (escalatedHighs.length >= 2) {
      return {
        shouldAlert: true, tier: 'PRIORITY', confidence: 'MEDIUM',
        headline: `${escalatedHighs.length}个升级信号`,
        reason: `多个指标同时升级：${escalatedHighs.map(s => s.label || s.key).slice(0, 3).join('、')}。`,
        actionable: '监控趋势是否持续，关注下次扫描。',
        signals: escalatedHighs.map(s => s.label || s.key).slice(0, 5),
        crossCorrelation: '多指标联动',
      };
    }

    // PRIORITY: ≥5 new OSINT posts (surge in conflict reporting)
    if (osintNew.length >= 5) {
      return {
        shouldAlert: true, tier: 'PRIORITY', confidence: 'MEDIUM',
        headline: `OSINT激增：${osintNew.length}条新紧急帖子`,
        reason: `检测到${osintNew.length}条新紧急OSINT信号，冲突报告频率升高。`,
        actionable: '查看OSINT流中的模式，与卫星和ACLED数据交叉验证。',
        signals: osintNew.map(s => s.text || s.label || s.key).slice(0, 5),
        crossCorrelation: 'Telegram OSINT',
      };
    }

    // ROUTINE: any critical signal OR ≥3 high signals
    if (criticals.length >= 1 || highs.length >= 3) {
      const topSignal = criticals[0] || highs[0];
      return {
        shouldAlert: true, tier: 'ROUTINE', confidence: 'LOW',
        headline: topSignal.label || topSignal.reason || '检测到信号变化',
        reason: `${criticals.length}个严重，${highs.length}个高强度信号。${delta.summary.direction}偏向。`,
        actionable: '监控',
        signals: [...criticals, ...highs].map(s => s.label || s.key).slice(0, 4),
        crossCorrelation: '单一领域',
      };
    }

    // No alert
    return {
      shouldAlert: false,
      reason: `${signals.length}个信号，但无达到警报阈值（${criticals.length}个严重，${highs.length}个高）。`,
    };
  }

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  /**
   * Register command handlers that the bot can respond to.
   * @param {string} command - e.g. '/status'
   * @param {Function} handler - async (args, messageId) => responseText
   */
  onCommand(command, handler) {
    this._commandHandlers[command.toLowerCase()] = handler;
  }

  /**
   * Start polling for incoming messages/commands.
   * Call this once during server startup.
   * @param {number} intervalMs - polling interval (default 5000ms)
   */
  startPolling(intervalMs = 5000) {
    if (!this.isConfigured) return;
    if (this._pollingInterval) return; // Already polling

    console.log('[Telegram] Bot command polling started');
    this._initializeBotCommands().catch((err) => {
      console.error('[Telegram] Command initialization failed:', err.message);
    });
    this._pollingInterval = setInterval(() => this._pollUpdates(), intervalMs);
    // Initial poll
    this._pollUpdates();
  }

  /**
   * Stop polling for incoming messages.
   */
  stopPolling() {
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = null;
      console.log('[Telegram] Bot command polling stopped');
    }
  }

  async _pollUpdates() {
    try {
      const params = new URLSearchParams({
        offset: String(this._lastUpdateId + 1),
        timeout: '0',
        limit: '10',
        allowed_updates: JSON.stringify(['message']),
      });

      const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getUpdates?${params}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return;

      const data = await res.json();
      if (!data.ok || !Array.isArray(data.result)) return;

      for (const update of data.result) {
        this._lastUpdateId = Math.max(this._lastUpdateId, update.update_id);
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat?.id);
        // Restrict command execution to the configured chat/group only.
        if (chatId !== String(this.chatId)) continue;

        await this._handleMessage(msg);
      }
    } catch (err) {
      // Silent — polling failures are non-fatal
      if (!err.message?.includes('aborted')) {
        console.error('[Telegram] 轮询错误:', err.message);
      }
    }
  }

  async _handleMessage(msg) {
    const text = msg.text.trim();
    const parts = text.split(/\s+/);
    const rawCommand = parts[0].toLowerCase();
    const command = this._normalizeCommand(rawCommand);
    if (!command) return;
    const args = parts.slice(1).join(' ');
    const replyChatId = msg.chat?.id;

    // Built-in commands
    if (command === '/help') {
      const helpText = Object.entries(COMMANDS)
        .map(([cmd, desc]) => `${cmd} — ${desc}`)
        .join('\n');
      await this.sendMessage(
        `🤖 *CRUCIX 机器人命令*\n\n${helpText}\n\n_提示：命令不区分大小写_`,
        { chatId: replyChatId, replyToMessageId: msg.message_id }
      );
      return;
    }

    if (command === '/mute') {
      const hours = parseFloat(args) || 1;
      this._muteUntil = Date.now() + hours * 60 * 60 * 1000;
      await this.sendMessage(
        `🔇 警报已静音 ${hours}小时 — 至 ${new Date(this._muteUntil).toLocaleTimeString()} UTC\n使用 /unmute 恢复。`,
        { chatId: replyChatId, replyToMessageId: msg.message_id }
      );
      return;
    }

    if (command === '/unmute') {
      this._muteUntil = null;
      await this.sendMessage(
        `🔔 警报已恢复。您将收到下一次信号评估。`,
        { chatId: replyChatId, replyToMessageId: msg.message_id }
      );
      return;
    }

    if (command === '/alerts') {
      const recent = this._alertHistory.slice(-10);
      if (recent.length === 0) {
        await this.sendMessage('无最近警报。', { chatId: replyChatId, replyToMessageId: msg.message_id });
        return;
      }
      const lines = recent.map(a =>
        `${TIER_CONFIG[a.tier]?.emoji || '⚪'} ${TIER_CONFIG[a.tier]?.label || a.tier} — ${new Date(a.timestamp).toLocaleTimeString()}`
      );
      await this.sendMessage(
        `📋 *最近警报（最近${recent.length}条）*\n\n${lines.join('\n')}`,
        { chatId: replyChatId, replyToMessageId: msg.message_id }
      );
      return;
    }

    // Delegate to registered handlers
    const handler = this._commandHandlers[command];
    if (handler) {
      try {
        const response = await handler(args, msg.message_id);
        if (response) {
          await this.sendMessage(response, { chatId: replyChatId, replyToMessageId: msg.message_id });
        }
      } catch (err) {
        console.error(`[Telegram] Command ${command} error:`, err.message);
        await this.sendMessage(
          `❌ Command failed: ${err.message}`,
          { chatId: replyChatId, replyToMessageId: msg.message_id }
        );
      }
    }
    // Unknown commands are silently ignored to avoid spamming
  }

  async _initializeBotCommands() {
    await this._loadBotIdentity();

    const botCommands = Object.entries(COMMANDS).map(([command, description]) => ({
      command: command.replace('/', ''),
      description: description.substring(0, 256),
    }));

    // Register commands only for the configured chat to avoid global discovery.
    await this._setMyCommands(botCommands, this._buildConfiguredChatScope());
  }

  async _loadBotIdentity() {
    const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getMe`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`getMe failed (${res.status}): ${err.substring(0, 200)}`);
    }
    const data = await res.json();
    if (!data.ok || !data.result?.username) {
      throw new Error('getMe returned invalid bot profile');
    }
    this._botUsername = String(data.result.username).toLowerCase();
  }

  async _setMyCommands(commands, scope = null) {
    const body = { commands };
    if (scope) body.scope = scope;

    const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`setMyCommands failed (${res.status}): ${err.substring(0, 200)}`);
    }
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`setMyCommands rejected: ${JSON.stringify(data).substring(0, 200)}`);
    }
  }

  _buildConfiguredChatScope() {
    const chatId = Number(this.chatId);
    if (!Number.isSafeInteger(chatId)) {
      throw new Error(`TELEGRAM_CHAT_ID must be a numeric chat id, got: ${this.chatId}`);
    }
    return { type: 'chat', chat_id: chatId };
  }

  _normalizeCommand(rawCommand) {
    if (!rawCommand.startsWith('/')) return null;

    const atIdx = rawCommand.indexOf('@');
    if (atIdx === -1) return rawCommand;

    const command = rawCommand.substring(0, atIdx);
    const mentionedBot = rawCommand.substring(atIdx + 1).toLowerCase();
    if (!this._botUsername || mentionedBot === this._botUsername) return command;
    return null;
  }

  // ─── Semantic Dedup ─────────────────────────────────────────────────────

  /**
   * Generate a content-based hash for a signal to detect near-duplicates.
   * Uses normalized text + key metrics rather than raw text prefix matching.
   */
  _contentHash(signal) {
    // Normalize: lowercase, strip numbers that change frequently (timestamps, exact values)
    let content = '';
    if (signal.text) {
      content = signal.text.toLowerCase()
        .replace(/\d{1,2}:\d{2}/g, '')       // strip times
        .replace(/\d+\.\d+%?/g, 'NUM')       // normalize numbers
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 120);
    } else if (signal.label) {
      // For metric signals, hash the label + direction (not exact values)
      content = `${signal.label}:${signal.direction || 'none'}`;
    } else {
      content = signal.key || JSON.stringify(signal).substring(0, 80);
    }

    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  _isSemanticDuplicate(signal) {
    const hash = this._contentHash(signal);
    const lastSeen = this._contentHashes[hash];
    if (!lastSeen) return false;

    // Consider duplicate if seen within last 4 hours
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    return new Date(lastSeen).getTime() > fourHoursAgo;
  }

  _recordContentHash(signal) {
    const hash = this._contentHash(signal);
    this._contentHashes[hash] = new Date().toISOString();

    // Prune hashes older than 24h
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [h, ts] of Object.entries(this._contentHashes)) {
      if (new Date(ts).getTime() < cutoff) delete this._contentHashes[h];
    }
  }

  _signalKey(signal) {
    // Improved key generation — use content hash for text signals, structured key for metrics
    if (signal.text) return `tg:${this._contentHash(signal)}`;
    return signal.key || signal.label || JSON.stringify(signal).substring(0, 60);
  }

  // ─── Rate Limiting ──────────────────────────────────────────────────────

  _checkRateLimit(tier) {
    const config = TIER_CONFIG[tier];
    if (!config) return true;

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    // Check cooldown since last alert of same or lower tier
    const lastSameTier = this._alertHistory
      .filter(a => a.tier === tier)
      .pop();
    if (lastSameTier && (now - lastSameTier.timestamp) < config.cooldownMs) {
      return false;
    }

    // Check hourly cap
    const recentCount = this._alertHistory
      .filter(a => a.tier === tier && a.timestamp > oneHourAgo)
      .length;
    if (recentCount >= config.maxPerHour) {
      return false;
    }

    return true;
  }

  _recordAlert(tier) {
    this._alertHistory.push({ tier, timestamp: Date.now() });
    // Keep only last 50 alerts
    if (this._alertHistory.length > 50) {
      this._alertHistory = this._alertHistory.slice(-50);
    }
  }

  _isMuted() {
    if (!this._muteUntil) return false;
    if (Date.now() > this._muteUntil) {
      this._muteUntil = null;
      return false;
    }
    return true;
  }

  // ─── Prompt Engineering ─────────────────────────────────────────────────

  _buildEvaluationPrompt() {
    return `你是 Crucix，一个精英级情报警报评估器。你分析来自25个数据源的信号变化，决定是否需要通过 Telegram 提醒用户。

## 决策框架

每个评估必须归入以下四类之一：

### 不警报 — 以下情况抑制：
- 常规计划数据（NFP、CPI、FOMC纪要等预期日期发布）除非偏离共识极大（>2σ）
- 与之前扫描已标记趋势的延续
- 无印证的单一来源低置信度信号
- 无硬数据确认的社交媒体噪音（仅Telegram聊天不足以触发警报）

### 🔴 闪报 — 立即行动，组合生命级风险：
- 核大国或北约成员国之间的军事升级
- 闪崩指标（VIX飙升>40%，主要指数日内下跌>3%）
- 央行紧急行动（临时利率决策、紧急借贷便利）
- 多个监测器确认的核/辐射异常
- 意外宣布的对主要经济体制裁
闪报要求：≥2个不同领域的印证来源（如OSINT+市场数据+卫星）

### 🟡 优先 — 数小时内行动：
- 重大市场动荡（VIX>25 且信用利差扩大）
- 地缘政治升级伴随明确能源/商品传导（冲突+油价变动>3%）
- 意外经济数据（主要指标偏离>1.5σ）
- ACLED+Telegram确认的新冲突前线或停火破裂
优先要求：≥2个同向信号，至少1个来自硬数据

### 🔵 常规 — 参考信息，无紧迫性：
- 值得关注的显著趋势转变或反转
- 中等重要性的单一来源信号
- 累积漂移（多次扫描同向小幅移动）

## 输出格式

仅返回有效JSON：
{
  "shouldAlert": true/false,
  "tier": "FLASH" | "PRIORITY" | "ROUTINE",
  "headline": "10词以内标题（中文）",
  "reason": "2-3句中文。发生了什么，为什么重要，接下来关注什么。",
  "actionable": "用户可采取的具体行动（如果只是参考信息则写'Monitor'或'监控'）",
  "signals": ["信号1（中文）", "信号2（中文）"],
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "crossCorrelation": "哪些领域在相互印证（如'冲突+能源+卫星'）"
}`;
  }

  _buildSignalContext(signals, delta) {
    const sections = [];

    // Categorize signals
    const marketSignals = signals.filter(s => ['vix', 'hy_spread', 'wti', 'brent', 'natgas', 'gold', 'silver', '10y2y', 'fed_funds', '10y_yield', 'usd_index'].includes(s.key));
    const osintSignals = signals.filter(s => s.key === 'tg_urgent' || s.item?.channel);
    const conflictSignals = signals.filter(s => ['conflict_events', 'conflict_fatalities', 'thermal_total'].includes(s.key));
    const otherSignals = signals.filter(s => !marketSignals.includes(s) && !osintSignals.includes(s) && !conflictSignals.includes(s));

    if (marketSignals.length > 0) {
      sections.push('📊 市场信号:\n' + marketSignals.map(s =>
        `  ${s.label}: ${s.from} → ${s.to} (${s.pctChange > 0 ? '+' : ''}${s.pctChange?.toFixed(1) || s.change}${s.pctChange !== undefined ? '%' : ''})`
      ).join('\n'));
    }

    if (osintSignals.length > 0) {
      sections.push('📡 OSINT信号:\n' + osintSignals.map(s => {
        const post = s.item || s;
        return `  [${post.channel || '未知'}] ${post.text || s.reason || ''}`;
      }).join('\n'));
    }

    if (conflictSignals.length > 0) {
      sections.push('⚔️ 冲突指标:\n' + conflictSignals.map(s =>
        `  ${s.label}: ${s.from} → ${s.to} (${s.direction})`
      ).join('\n'));
    }

    if (otherSignals.length > 0) {
      sections.push('📌 其他:\n' + otherSignals.map(s =>
        `  ${s.label || s.key || s.reason}: ${s.from !== undefined ? `${s.from} → ${s.to}` : '新信号'}`
      ).join('\n'));
    }

    sections.push(`\n📈 扫描Delta: 方向=${delta.summary.direction}, 总变化=${delta.summary.totalChanges}, 严重=${delta.summary.criticalChanges}`);

    return sections.join('\n\n');
  }

  // ─── Message Formatting ─────────────────────────────────────────────────

  _formatTieredAlert(evaluation, delta, tier) {
    const tc = TIER_CONFIG[tier];
    const confidenceEmoji = { HIGH: '🟢', MEDIUM: '🟡', LOW: '⚪' }[evaluation.confidence] || '⚪';
    const confidenceLabel = { HIGH: '高', MEDIUM: '中', LOW: '低' }[evaluation.confidence] || '中';
    const directionLabel = { 'risk-off': '风险规避', 'risk-on': '风险偏好', 'mixed': '中性' }[delta.summary.direction] || delta.summary.direction.toUpperCase();

    const lines = [
      `${tc.emoji} *CRUCIX ${tc.label}*`,
      ``,
      `*${escapeMdFull(evaluation.headline)}*`,
      ``,
      escapeMdFull(evaluation.reason),
      ``,
      `置信度: ${confidenceEmoji} ${confidenceLabel}`,
      `方向: ${directionLabel}`,
    ];

    if (evaluation.crossCorrelation) {
      lines.push(`交叉关联: ${escapeMdFull(evaluation.crossCorrelation)}`);
    }

    if (evaluation.actionable && evaluation.actionable !== 'Monitor') {
      lines.push(``, `💡 *行动:* ${escapeMdFull(evaluation.actionable)}`);
    }

    if (evaluation.signals?.length) {
      lines.push('', `*信号:*`);
      for (const sig of evaluation.signals) {
        lines.push(`• ${escapeMdFull(String(sig))}`);
      }
    }

    lines.push('', `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`);

    return lines.join('\n');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function escapeMd(text) {
  if (!text) return '';
  // The bot sends alerts with legacy Markdown parse mode, not MarkdownV2.
  // Escape characters that Telegram treats as Markdown formatting.
  // Also escape () to prevent entity issues with nested parens.
  return text.replace(/([_*`\[])/g, '\\$1');
}

function escapeMdFull(text) {
  if (!text) return '';
  // More aggressive escaping for untrusted content (e.g., news headlines from LLM)
  return text.replace(/([_*`\[（）()！!？?])/g, '\\$1');
}

function parseJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* give up */ }
    }
    return null;
  }
}
