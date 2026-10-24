import { render, screen } from '@testing-library/react';

// SuperAdmin → AI: each prompt panel's character counter shows the cap the
// server applies to that prompt, read from GET /api/superadmin/ai (promptLimits).

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch }),
}));

const { default: TabAI } = await import('./TabAI');

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

const LIMITS = {
  chatSystemPrompt: 4000,
  labelScanPrompt: 8000,
  labelScanBackPrompt: 8000,
  receiptScanPrompt: 8000,
  importLookupPrompt: 8000,
  maturitySuggestPrompt: 8000,
  maturitySuggestPromptNv: 8000,
  priceSuggestPrompt: 8000,
  enrichmentPrompt: 12000,
};

const aiPayload = (extra = {}) => ({
  configured: { voyageAI: true, anthropic: true },
  providers: { llm: 'anthropic', embedding: 'voyage' },
  config: {
    chatModel: 'claude-haiku-4-5-20251001',
    chatSystemPrompt: 's'.repeat(1445),
    labelScanPrompt: 'l'.repeat(5667),
    enrichmentPrompt: 'e'.repeat(8306),
  },
  job: { status: 'idle' },
  enrichmentJob: { status: 'idle' },
  enrichment: { totalWines: 0, enrichedWines: 0 },
  vectors: null,
  embeddings: { total: 0, byStatus: {}, byModel: [] },
  chatEventLog: [],
  ...extra,
});

function serve(payload) {
  apiFetch.mockImplementation(async (path) => (path === '/api/superadmin/ai'
    ? okJson(payload)
    : { ok: false, status: 404, json: async () => ({ error: 'not in this test' }) }));
}

beforeEach(() => {
  apiFetch.mockReset();
});

test('each prompt counter shows the cap the server sends for it', async () => {
  serve(aiPayload({ promptLimits: LIMITS }));
  render(<TabAI />);

  expect(await screen.findByText('8306 / 12000 chars')).toBeInTheDocument();
  expect(screen.getByText('5667 / 8000 chars')).toBeInTheDocument();
  expect(screen.getByText('1445 / 4000 chars')).toBeInTheDocument();
});

test('without caps in the answer the counters keep their built-in limits', async () => {
  serve(aiPayload());
  render(<TabAI />);

  expect(await screen.findByText('8306 / 6000 chars')).toBeInTheDocument();
  expect(screen.getByText('1445 / 4000 chars')).toBeInTheDocument();
});
