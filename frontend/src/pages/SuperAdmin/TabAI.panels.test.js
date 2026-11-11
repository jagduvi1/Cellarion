import { render, screen } from '@testing-library/react';

// SuperAdmin → AI is one long page of panels. This is the roll call: every
// panel the tab draws, in order, and the controls the configuration panels
// carry. A panel that goes missing, or a model picker or prompt box that no
// longer renders, fails here, whichever file the panel lives in.

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch }),
}));

const { default: TabAI } = await import('./TabAI');

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

const PAYLOAD = {
  configured: { voyageAI: true, anthropic: true },
  providers: { llm: 'anthropic', embedding: 'voyage' },
  config: {
    chatModel: 'claude-haiku-4-5-20251001',
    chatSystemPrompt: 'chat prompt',
    labelScanPrompt: 'label prompt',
    enrichmentPrompt: 'enrichment prompt',
  },
  job: { status: 'idle' },
  enrichmentJob: { status: 'idle' },
  enrichment: { totalWines: 0, enrichedWines: 0 },
  vectors: null,
  embeddings: { total: 0, byStatus: {}, byModel: [] },
  chatEventLog: [],
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => (path === '/api/superadmin/ai'
    ? okJson(PAYLOAD)
    : { ok: false, status: 404, json: async () => ({ error: 'not in this test' }) }));
});

test('every panel of the tab, in order', async () => {
  const { container } = render(<TabAI />);
  await screen.findByText('AI Config');

  const titles = [...container.querySelectorAll('.sa-panel-title')].map((el) => el.textContent);
  expect(titles).toMatchInlineSnapshot(`
    [
      "AI Cost — Estimated",
      "Prompt Caching — Label Scan & Import",
      "AI Config",
      "Vector Search",
      "Embedding Job",
      "WineEmbeddings (MongoDB)",
      "Wine Enrichment Job",
      "Profile Coverage",
      "Cellar Chat — AI Model",
      "Cellar Chat — System Prompt",
      "Label Scan — AI Model",
      "Label Scan — AI Prompt",
      "Receipt Scan — AI Prompt",
      "Import Lookup — AI Model",
      "Import Lookup — AI Prompt",
      "Maturity Suggest — AI Model",
      "Maturity Suggest — AI Prompt",
      "Maturity Suggest (Non-Vintage) — AI Prompt",
      "Price Suggest — AI Model",
      "Price Suggest — AI Prompt",
      "Wine Enrichment — AI Model",
      "Wine Enrichment — AI Prompt",
      "Cellar Chat — Daily Limit",
      "Enrichment — Publication Gate",
      "Enrichment — Web-Search Rescue (pilot)",
      "AI Spend Controls",
      "Cellar Chat Usage — Per User",
    ]
  `);
});

test('the configuration panels carry their controls', async () => {
  const { container } = render(<TabAI />);
  await screen.findByText('AI Config');

  // One radio per model in every model picker, one of them chosen in each.
  const pickers = [...new Set([...container.querySelectorAll('input[type="radio"]')].map((r) => r.name))];
  expect(pickers).toMatchInlineSnapshot(`
    [
      "chatModel",
      "chatFallback",
      "labelScanModel",
      "importLookupModel",
      "maturitySuggestModel",
      "priceSuggestModel",
      "enrichmentModel",
    ]
  `);
  for (const name of pickers) {
    expect(container.querySelectorAll(`input[type="radio"][name="${name}"]:checked`)).toHaveLength(1);
  }
  // One prompt box per prompt panel; the three prompts sent are in theirs.
  const prompts = [...container.querySelectorAll('textarea')].map((el) => el.value);
  expect(prompts).toHaveLength(8);
  expect(prompts).toEqual(expect.arrayContaining(['chat prompt', 'label prompt', 'enrichment prompt']));
});
