/**
 * AI provider layer — provider selection, config assertions, and the
 * OpenAI-compatible adapter (message translation, retries, streaming).
 *
 * The adapter must accept Anthropic-shaped params and return Anthropic-shaped
 * responses, because aiChat.js / labelScan.js are written against that shape.
 */

const aiProvider = require('./aiProvider');

const ENV_KEYS = [
  'AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY',
  'AI_MODEL', 'AI_VISION_MODEL', 'OPENAI_TIMEOUT_MS',
];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  aiProvider._resetForTests();
  global.fetch = jest.fn();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

function okJson(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  };
}

function errorRes(status, headers = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    text: async () => 'boom',
  };
}

/** Build a mock streaming response whose body async-iterates SSE chunks. */
function streamRes(sseLines) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: (async function* () {
      for (const line of sseLines) {
        yield Buffer.from(line);
      }
    })(),
  };
}

// ── Provider selection & configuration ──────────────────────────────────────

describe('provider selection', () => {
  test('defaults to anthropic', () => {
    expect(aiProvider.providerName()).toBe('anthropic');
  });

  test('assertConfigured throws 503 when ANTHROPIC_API_KEY is missing (anthropic mode)', () => {
    expect(() => aiProvider.assertConfigured()).toThrow(expect.objectContaining({ status: 503 }));
  });

  test('assertConfigured passes in anthropic mode with a key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(() => aiProvider.assertConfigured()).not.toThrow();
  });

  test('openai mode requires OPENAI_BASE_URL and AI_MODEL', () => {
    process.env.AI_PROVIDER = 'openai';
    expect(() => aiProvider.assertConfigured()).toThrow(/OPENAI_BASE_URL/);

    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    expect(() => aiProvider.assertConfigured()).toThrow(/AI_MODEL/);

    process.env.AI_MODEL = 'llama3.1';
    expect(() => aiProvider.assertConfigured()).not.toThrow();
  });

  test('unknown provider throws 503', () => {
    process.env.AI_PROVIDER = 'bedrock';
    expect(() => aiProvider.assertConfigured()).toThrow(/Unknown AI_PROVIDER/);
  });

  test('isConfigured never throws', () => {
    expect(aiProvider.isConfigured()).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(aiProvider.isConfigured()).toBe(true);
  });

  test('displayModel substitutes AI_MODEL only in openai mode', () => {
    expect(aiProvider.displayModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_MODEL = 'llama3.1';
    expect(aiProvider.displayModel('claude-sonnet-5')).toBe('llama3.1');
  });

  test('getChatClient returns an Anthropic SDK client in anthropic mode', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const client = aiProvider.getChatClient();
    // Real SDK instance — has the messages surface and is cached
    expect(typeof client.messages.create).toBe('function');
    expect(aiProvider.getChatClient()).toBe(client);
    // Distinct retry budgets get distinct clients
    expect(aiProvider.getChatClient({ maxRetries: 4 })).not.toBe(client);
  });
});

// ── Message translation ─────────────────────────────────────────────────────

describe('toOpenAiMessages', () => {
  test('maps system param and string content', () => {
    const { messages, hasImage } = aiProvider.toOpenAiMessages({
      system: 'be brief',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ]);
    expect(hasImage).toBe(false);
  });

  test('maps base64 image blocks to data-URL image_url parts', () => {
    const { messages, hasImage } = aiProvider.toOpenAiMessages({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
          { type: 'text', text: 'read this label' },
        ],
      }],
    });
    expect(hasImage).toBe(true);
    expect(messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      { type: 'text', text: 'read this label' },
    ]);
  });
});

// ── Non-streaming create ────────────────────────────────────────────────────

describe('openai create', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_BASE_URL = 'http://llm.local/v1/'; // trailing slash on purpose
    process.env.AI_MODEL = 'llama3.1';
  });

  test('returns an Anthropic-shaped response and posts the right body', async () => {
    global.fetch.mockResolvedValueOnce(okJson({
      model: 'llama3.1',
      choices: [{ message: { content: '{"answer":42}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));

    const client = aiProvider.getChatClient();
    const res = await client.messages.create({
      model: 'claude-sonnet-5', // Claude name from aiConfig — must be ignored
      max_tokens: 600,
      thinking: { type: 'disabled' }, // Anthropic-only — must be dropped
      system: 'sys',
      messages: [{ role: 'user', content: 'q' }],
    });

    expect(res.content).toEqual([{ type: 'text', text: '{"answer":42}' }]);
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('http://llm.local/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama3.1');
    expect(body.max_tokens).toBe(600);
    expect(body.thinking).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(init.headers.Authorization).toBeUndefined(); // no key set
  });

  test('sends Authorization header when OPENAI_API_KEY is set and picks the vision model for images', async () => {
    process.env.OPENAI_API_KEY = 'secret';
    process.env.AI_VISION_MODEL = 'qwen2.5-vl';
    global.fetch.mockResolvedValueOnce(okJson({ choices: [{ message: { content: 'ok' } }] }));

    await aiProvider.getChatClient().messages.create({
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BB' } }],
      }],
    });

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body).model).toBe('qwen2.5-vl');
  });

  test('missing usage in the response degrades to zero tokens', async () => {
    global.fetch.mockResolvedValueOnce(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const res = await aiProvider.getChatClient().messages.create({
      max_tokens: 10, messages: [{ role: 'user', content: 'q' }],
    });
    expect(res.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test('retries 429 honouring retry-after, then succeeds', async () => {
    global.fetch
      .mockResolvedValueOnce(errorRes(429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(okJson({ choices: [{ message: { content: 'after retry' } }] }));

    const res = await aiProvider.getChatClient().messages.create({
      max_tokens: 10, messages: [{ role: 'user', content: 'q' }],
    });
    expect(res.content[0].text).toBe('after retry');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  test('non-retryable 400 throws with status and no retry', async () => {
    global.fetch.mockResolvedValueOnce(errorRes(400));
    await expect(aiProvider.getChatClient().messages.create({
      max_tokens: 10, messages: [{ role: 'user', content: 'q' }],
    })).rejects.toMatchObject({ status: 400 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('429 with retries exhausted throws the provider error (labelScan maps it to rate_limit)', async () => {
    global.fetch.mockResolvedValue(errorRes(429, { 'retry-after': '1' }));
    await expect(aiProvider.getChatClient({ maxRetries: 1 }).messages.create({
      max_tokens: 10, messages: [{ role: 'user', content: 'q' }],
    })).rejects.toMatchObject({ status: 429 });
    expect(global.fetch).toHaveBeenCalledTimes(2); // initial + 1 retry
  }, 10000);

  test('timeout abort surfaces as a 504-shaped error', async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    global.fetch.mockRejectedValueOnce(err);
    await expect(aiProvider.getChatClient().messages.create({
      max_tokens: 10, messages: [{ role: 'user', content: 'q' }],
    })).rejects.toMatchObject({ status: 504 });
  });
});

// ── Streaming ───────────────────────────────────────────────────────────────

describe('openai stream', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_BASE_URL = 'http://llm.local/v1';
    process.env.AI_MODEL = 'llama3.1';
  });

  function collect(stream) {
    return new Promise((resolve, reject) => {
      const deltas = [];
      stream.on('text', (t) => deltas.push(t));
      stream.on('finalMessage', (msg) => resolve({ deltas, msg }));
      stream.on('error', reject);
    });
  }

  test('emits text deltas and a finalMessage with usage', async () => {
    global.fetch.mockResolvedValueOnce(streamRes([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      // split across chunks mid-line to exercise buffering
      'data: {"choices":[{"delta":{"con',
      'tent":"lo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const stream = aiProvider.getChatClient().messages.stream({
      max_tokens: 10, messages: [{ role: 'user', content: 'q' }],
    });
    const { deltas, msg } = await collect(stream);

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(msg.content[0].text).toBe('Hello');
    expect(msg.usage).toEqual({ input_tokens: 7, output_tokens: 3 });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test('non-ok response emits an error with status', async () => {
    global.fetch.mockResolvedValueOnce(errorRes(500));
    const stream = aiProvider.getChatClient().messages.stream({
      max_tokens: 10, messages: [{ role: 'user', content: 'q' }],
    });
    await expect(collect(stream)).rejects.toMatchObject({ status: 500 });
  });

  test('abort() emits abort and suppresses finalMessage/error', async () => {
    let releaseBody;
    const gate = new Promise((r) => { releaseBody = r; });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: (async function* () {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        await gate; // hold the stream open until the test aborts
        yield Buffer.from('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
      })(),
    });

    const stream = aiProvider.getChatClient().messages.stream({
      max_tokens: 10, messages: [{ role: 'user', content: 'q' }],
    });

    const events = [];
    stream.on('text', (t) => events.push(['text', t]));
    stream.on('finalMessage', () => events.push(['finalMessage']));
    stream.on('error', () => events.push(['error']));
    const aborted = new Promise((r) => stream.on('abort', () => { events.push(['abort']); r(); }));

    // Wait for the first delta, then abort mid-stream
    await new Promise((r) => stream.once('text', r));
    stream.abort();
    releaseBody();
    await aborted;
    // Give the loop a tick to (not) emit anything further
    await new Promise((r) => setImmediate(r));

    expect(events).toContainEqual(['abort']);
    expect(events).not.toContainEqual(['finalMessage']);
    expect(events).not.toContainEqual(['error']);
  });
});
