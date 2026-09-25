import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// SuperAdmin → AI "AI Cost — Estimated" card (2026-09-25): renders the spend
// ledger summary (GET /api/superadmin/ai/costs) as a per-feature table.

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch }),
}));

const { AiCostPanel } = await import('./TabAI');

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

const SUMMARY = {
  days: 30,
  since: '2026-08-27',
  features: [
    {
      feature: 'label_scan', models: ['claude-sonnet-5'], calls: 50, reused: 0,
      inputTokens: 105000, cacheReadTokens: 15000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 1500,
      outputTokens: 10000, webSearches: 0, usd: 0.319, usdPerCall: 0.00638, cachedInputShare: 0.123,
    },
    {
      feature: 'import_identify', models: ['claude-sonnet-5'], calls: 2, reused: 7,
      inputTokens: 600, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
      outputTokens: 300, webSearches: 0, usd: 0.0042, usdPerCall: 0.0021, cachedInputShare: 0,
    },
  ],
  daily: [],
  total: { calls: 52, reused: 7, usd: 0.3232 },
  recordingSince: '2026-09-24',
  projectedUsdPer30Days: 4.85,
  unpricedModels: [],
  pricesCheckedAt: '2026-09-25',
};

beforeEach(() => {
  apiFetch.mockReset();
});

test('shows the period total, the 30-day projection and one row per feature', async () => {
  apiFetch.mockResolvedValue(okJson(SUMMARY));
  render(<AiCostPanel />);

  expect(await screen.findByText('Label scan')).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledWith('/api/superadmin/ai/costs?days=30');
  expect(screen.getByText('Import identification')).toBeInTheDocument();
  expect(screen.getAllByText('$0.32')).toHaveLength(2);        // period total and the scan row
  expect(screen.getByText('$4.85')).toBeInTheDocument();       // per 30 days at this rate
  expect(screen.getByText('12%')).toBeInTheDocument();         // scan input read from the cache
  expect(screen.getByText('$0.0064')).toBeInTheDocument();     // scan cost per call
  expect(screen.getByText('answers reused')).toBeInTheDocument();
  expect(screen.getByText(/checked 2026-09-25/)).toBeInTheDocument();
});

test('changing the window reloads for that many days', async () => {
  apiFetch.mockResolvedValue(okJson(SUMMARY));
  render(<AiCostPanel />);
  await screen.findByText('Label scan');

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } });
  await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith('/api/superadmin/ai/costs?days=7'));
});

test('an empty ledger says recording has not started, not that AI is free', async () => {
  apiFetch.mockResolvedValue(okJson({ ...SUMMARY, features: [], total: { calls: 0, reused: 0, usd: 0 }, projectedUsdPer30Days: null }));
  render(<AiCostPanel />);
  expect(await screen.findByText(/recording starts with the release/)).toBeInTheDocument();
});

test('a failed load shows the error', async () => {
  apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Failed to load AI costs' }) });
  render(<AiCostPanel />);
  expect(await screen.findByText('Failed to load AI costs')).toBeInTheDocument();
});
