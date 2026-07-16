/**
 * AI provider layer — chat/LLM calls (issue #698).
 *
 * Cellarion's AI features all call an LLM through the small client surface
 * used by aiChat.js and labelScan.js: `client.messages.create(params)` and
 * `client.messages.stream(params)` (Anthropic Messages API shapes). This
 * module owns which backend actually serves those calls:
 *
 *   AI_PROVIDER=anthropic (default) — the Anthropic SDK, exactly as before.
 *   AI_PROVIDER=openai              — any OpenAI-compatible /v1/chat/completions
 *                                     endpoint (Ollama, LM Studio, vLLM,
 *                                     LiteLLM, OpenAI itself). Opt-in for
 *                                     self-hosters; cellarion.app stays on
 *                                     Anthropic.
 *
 * The OpenAI adapter accepts Anthropic-shaped params and returns
 * Anthropic-shaped responses ({ content: [{type:'text',text}], usage:
 * {input_tokens, output_tokens} }), so the services don't care which provider
 * is active. Anthropic-only params (`thinking`) are dropped. Claude model
 * names from aiConfig are ignored in openai mode — the model comes from the
 * AI_MODEL env var (AI_VISION_MODEL for requests that carry an image), since
 * self-hosted model names are free-form and per-install.
 *
 * Env (openai mode)
 * -----------------
 *   OPENAI_BASE_URL   – required, e.g. http://ollama:11434/v1 (the /v1 root)
 *   OPENAI_API_KEY    – optional (Ollama/LM Studio ignore it; vLLM may require)
 *   AI_MODEL          – required, e.g. llama3.1:70b / qwen2.5:32b
 *   AI_VISION_MODEL   – optional, used when the request contains an image
 *                       (label scan); defaults to AI_MODEL
 *   OPENAI_TIMEOUT_MS – optional per-request timeout, default 120000 (local
 *                       models can be slow)
 */

const { EventEmitter } = require('events');
const { fetchWithRetry } = require('../utils/fetchRetry');

const DEFAULT_TIMEOUT_MS = 120000;
// Chat/scan calls retry 429 and transient 5xx (matching the Anthropic SDK),
// with waits capped well below the request timeout so a hostile Retry-After
// can't park an import chunk.
const RETRYABLE = (status) => status === 429 || status >= 500;
const MAX_RETRY_WAIT_MS = 32000;

let _warnedUnknownProvider = false;
function providerName() {
  const name = (process.env.AI_PROVIDER || 'anthropic').trim().toLowerCase();
  // A typo here silently reports "not configured" everywhere — warn once so
  // the operator sees why AI features went dark despite valid keys.
  if (name !== 'anthropic' && name !== 'openai' && !_warnedUnknownProvider) {
    _warnedUnknownProvider = true;
    console.warn(`[aiProvider] Unknown AI_PROVIDER "${name}" (expected "anthropic" or "openai") — all AI features are disabled until it is fixed`);
  }
  return name;
}

/**
 * Throw a 503 if the active provider is missing required configuration.
 * Message is generic on purpose — it can surface in API error responses.
 */
function assertConfigured() {
  const name = providerName();
  if (name === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw Object.assign(new Error('AI is not configured on this server (ANTHROPIC_API_KEY missing)'), { status: 503 });
    }
    return;
  }
  if (name === 'openai') {
    if (!process.env.OPENAI_BASE_URL) {
      throw Object.assign(new Error('AI is not configured on this server (OPENAI_BASE_URL missing)'), { status: 503 });
    }
    if (!process.env.AI_MODEL) {
      throw Object.assign(new Error('AI is not configured on this server (AI_MODEL missing)'), { status: 503 });
    }
    return;
  }
  throw Object.assign(new Error(`Unknown AI_PROVIDER "${name}" (expected "anthropic" or "openai")`), { status: 503 });
}

/** Non-throwing variant for feature gates ("is AI available at all?"). */
function isConfigured() {
  try {
    assertConfigured();
    return true;
  } catch {
    return false;
  }
}

/**
 * The models that actually serve requests in openai mode, or null when the
 * provider is Anthropic (aiConfig's stored Claude names then apply as-is).
 * aiConfig.get() uses this to return provider-resolved model fields, so every
 * consumer — logs, WineEmbedding bookkeeping, fallback comparison — sees the
 * real model without having to remember a per-callsite translation.
 */
function effectiveModels() {
  if (providerName() !== 'openai') return null;
  const text = process.env.AI_MODEL || '';
  return { text, vision: process.env.AI_VISION_MODEL || text };
}

// ── OpenAI-compatible adapter ───────────────────────────────────────────────

function openAiEnv() {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    visionModel: process.env.AI_VISION_MODEL || process.env.AI_MODEL || '',
    timeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Translate Anthropic-shaped { system, messages } into OpenAI chat messages.
 * Returns { messages, hasImage }.
 */
function toOpenAiMessages(params) {
  const out = [];
  let hasImage = false;
  if (params.system) out.push({ role: 'system', content: params.system });

  for (const m of params.messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = [];
    for (const block of m.content || []) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        hasImage = true;
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
      }
    }
    out.push({ role: m.role, content: parts });
  }
  return { messages: out, hasImage };
}

function buildRequestBody(params, env, stream) {
  const { messages, hasImage } = toOpenAiMessages(params);
  const body = {
    model: hasImage ? env.visionModel : env.model,
    messages,
    max_tokens: params.max_tokens,
  };
  if (stream) {
    body.stream = true;
    // Ask for a final usage chunk (supported by OpenAI, vLLM, Ollama, LM
    // Studio; servers that ignore it just report zero usage).
    body.stream_options = { include_usage: true };
  }
  return body;
}

function buildHeaders(env) {
  const h = { 'Content-Type': 'application/json' };
  if (env.apiKey) h.Authorization = `Bearer ${env.apiKey}`;
  return h;
}

/**
 * Non-streaming completion. Retries 429/5xx with capped backoff (honouring
 * Retry-After) up to `maxRetries` via the shared fetchWithRetry helper,
 * mirroring the Anthropic SDK's transparent retry behaviour that labelScan
 * relies on to keep large imports going through brief rate-limit windows.
 */
async function openAiCreate(params, { maxRetries = 2 } = {}) {
  const env = openAiEnv();
  // Serialize once — label-scan bodies carry multi-MB base64 images, so
  // rebuilding the JSON per retry attempt would be pure allocation waste.
  const body = JSON.stringify(buildRequestBody(params, env, false));

  const res = await fetchWithRetry(
    () => fetch(`${env.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(env),
      body,
      signal: AbortSignal.timeout(env.timeoutMs),
    }),
    { maxRetries, timeoutMs: env.timeoutMs, label: 'AI provider', retryable: RETRYABLE, maxWaitMs: MAX_RETRY_WAIT_MS }
  );

  const json = await res.json();
  return {
    model: json.model,
    content: [{ type: 'text', text: json.choices?.[0]?.message?.content ?? '' }],
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Streaming completion with the event surface aiChat.chatStream expects from
 * the Anthropic SDK: 'text' (delta), 'finalMessage' ({content, usage}),
 * 'error', 'abort', plus an .abort() method. The request only starts on a
 * later tick, so callers can attach listeners synchronously after the call.
 */
class OpenAiCompatStream extends EventEmitter {
  constructor(params) {
    super();
    this._controller = new AbortController();
    this._aborted = false;
    this._run(params).catch((err) => {
      if (this._aborted) return; // abort already signalled via 'abort'
      this.emit('error', err);
    });
  }

  abort() {
    if (this._aborted) return;
    this._aborted = true;
    this._controller.abort();
    this.emit('abort');
  }

  async _run(params) {
    const env = openAiEnv();
    const body = JSON.stringify(buildRequestBody(params, env, true));

    // The timeout only covers the header phase (incl. transparent retries) —
    // an open, flowing stream must not be killed mid-answer by a fixed timer.
    const headerTimer = setTimeout(() => {
      if (!this._aborted) {
        this._aborted = true;
        this._controller.abort();
        this.emit('error', Object.assign(
          new Error(`AI provider stream timed out after ${env.timeoutMs}ms`), { status: 504 }));
      }
    }, env.timeoutMs);

    let res;
    try {
      // Transparent pre-first-token retry on 429/transient 5xx — parity with
      // the Anthropic SDK stream client, which retries connection-phase
      // failures before any tokens are emitted. Terminal errors throw and are
      // emitted as 'error' by the constructor's catch.
      res = await fetchWithRetry(
        () => fetch(`${env.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: buildHeaders(env),
          body,
          signal: this._controller.signal,
        }),
        { maxRetries: 2, timeoutMs: env.timeoutMs, label: 'AI provider', retryable: RETRYABLE, maxWaitMs: MAX_RETRY_WAIT_MS }
      );
    } finally {
      clearTimeout(headerTimer);
    }
    if (this._aborted) return;

    let fullText = '';
    let usage = null;
    let buffer = '';
    const decoder = new TextDecoder();

    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { return; }
      if (json.usage) usage = json.usage;
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        this.emit('text', delta);
      }
    };

    try {
      for await (const chunk of res.body) {
        if (this._aborted) return;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep the trailing partial line for next chunk
        for (const line of lines) handleLine(line);
      }
    } catch (err) {
      if (this._aborted) return; // reader torn down by abort()
      throw err;
    }
    if (this._aborted) return;

    // Flush: a final SSE line without a trailing newline (and any multi-byte
    // character the streaming decoder is still holding) would otherwise be
    // silently dropped — losing the last text delta or the usage frame.
    buffer += decoder.decode();
    for (const line of buffer.split('\n')) handleLine(line);

    this.emit('finalMessage', {
      content: [{ type: 'text', text: fullText }],
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    });
  }
}

function makeOpenAiClient({ maxRetries = 2 } = {}) {
  return {
    messages: {
      create: (params) => openAiCreate(params, { maxRetries }),
      stream: (params) => new OpenAiCompatStream(params),
    },
  };
}

// ── Client factory ──────────────────────────────────────────────────────────

// Anthropic clients cached per retry budget (aiChat uses the SDK default,
// labelScan asks for 4 to survive rate-limited bulk imports).
const _anthropicClients = new Map();

/**
 * Return a chat client for the active provider. Throws a 503-shaped error
 * when the provider is not configured (same contract callers had for a
 * missing ANTHROPIC_API_KEY).
 *
 * @param {object} [opts]
 * @param {number} [opts.maxRetries] – transparent retry budget for 429/5xx
 */
function getChatClient(opts = {}) {
  assertConfigured();
  if (providerName() === 'openai') {
    return makeOpenAiClient(opts);
  }
  const key = opts.maxRetries ?? 'default';
  if (!_anthropicClients.has(key)) {
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.default ?? sdk;
    const clientOpts = { apiKey: process.env.ANTHROPIC_API_KEY };
    if (opts.maxRetries !== undefined) clientOpts.maxRetries = opts.maxRetries;
    _anthropicClients.set(key, new Anthropic(clientOpts));
  }
  return _anthropicClients.get(key);
}

/** Test hook — drop cached Anthropic clients (e.g. after changing env keys). */
function _resetForTests() {
  _anthropicClients.clear();
}

module.exports = { providerName, assertConfigured, isConfigured, effectiveModels, getChatClient, toOpenAiMessages, _resetForTests };
