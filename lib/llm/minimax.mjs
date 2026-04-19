// MiniMax Provider — raw fetch, no SDK
// Supports both OpenAI-compatible (/v1/chat/completions) and
// Anthropic-compatible (/v1/messages) endpoints via baseUrl.

import { LLMProvider } from './provider.mjs';

export class MiniMaxProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name = 'minimax';
    this.apiKey = config.apiKey;
    this.model = config.model || 'MiniMax-M2.5';
    this.baseUrl = (config.baseUrl || 'https://api.minimax.io/v1').replace(/\/+$/, '');
    // Detect Anthropic vs OpenAI endpoint from path
    this.isAnthropicFormat = this.baseUrl.includes('/anthropic');
  }

  get isConfigured() { return !!this.apiKey; }

  async complete(systemPrompt, userMessage, opts = {}) {
    if (this.isAnthropicFormat) {
      return this._completeAnthropic(systemPrompt, userMessage, opts);
    }
    return this._completeOpenAI(systemPrompt, userMessage, opts);
  }

  async _completeOpenAI(systemPrompt, userMessage, opts = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens || 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeout || 120000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`MiniMax API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model || this.model,
    };
  }

  async _completeAnthropic(systemPrompt, userMessage, opts = {}) {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens || 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: AbortSignal.timeout(opts.timeout || 120000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`MiniMax API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    // content can contain {type:"text", text:"..."} or {type:"thinking", thinking:"..."}
    const textBlock = (data.content || []).find(c => c.type === 'text');
    const text = textBlock?.text || '';

    return {
      text,
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
      model: data.model || this.model,
    };
  }
}