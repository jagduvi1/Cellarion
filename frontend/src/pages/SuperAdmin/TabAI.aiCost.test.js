import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// SuperAdmin → AI (2026-09-25): the "AI Cost — Estimated" card, which renders
// the spend ledger summary (GET /api/superadmin/ai/costs), and the prompt-caching
// switch (PATCH /api/superadmin/ai/prompt-caching).

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch }),
}));

const { AiCostPanel, PromptCachingPanel } = await import('./TabAI');

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

const feature = (overrides) => ({
  models: ['claude-sonnet-5'], calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0, inputTokensTotal: 0, outputTokens: 0, webSearches: 0, usd: 0, usdPerCall: null,
  cachedInputShare: null, ...overrides,
});

const SUMMARY = {
  days: 30,
  since: '2026-08-27',
  features: [
    feature({ feature: 'label_scan', calls: 50, inputTokens: 105000, cacheReadTokens: 15000, cacheWrite1hTokens: 1500,
      inputTokensTotal: 121500, outputTokens: 10000, usd: 0.319, usdPerCall: 0.00638, cachedInputShare: 0.123 }),
    feature({ feature: 'import_identify', calls: 2, inputTokens: 600, inputTokensTotal: 600, outputTokens: 300,
      usd: 0.0042, usdPerCall: 0.0021, cachedInputShare: 0 }),
  ],
  total: { calls: 52, usd: 0.3232 },
  recordingSince: '2026-09-10',
  projectedUsdPer30Days: 4.85,
  unpricedModels: [],
  pricesCheckedAt: '2026-09-25',
};

beforeEach(() => {
  apiFetch.mockReset();
});

describe('AiCostPanel', () => {
  test('shows the period total, the full-day projection and one row per feature', async () => {
    apiFetch.mockResolvedValue(okJson(SUMMARY));
    render(<AiCostPanel />);

    expect(await screen.findByText('Label scan')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/api/superadmin/ai/costs?days=30');
    expect(screen.getByText('Import identification')).toBeInTheDocument();
    expect(screen.getAllByText('$0.32')).toHaveLength(2);        // period total and the scan row
    expect(screen.getByText('$4.85')).toBeInTheDocument();       // per 30 days at the rate of the last full days
    // The input total the server computed, in the machine's locale. Testing
    // Library normalises whitespace in the page text but not in the expected
    // string, so a locale's no-break group separator is normalised here too.
    expect(screen.getByText((121500).toLocaleString().replace(/\s/g, ' '))).toBeInTheDocument();
    expect(screen.getByText('12%')).toBeInTheDocument();         // scan input read from the cache
    expect(screen.getByText('$0.0064')).toBeInTheDocument();     // scan cost per call
    expect(screen.getByText(/recording since 2026-09-10/)).toBeInTheDocument();
    expect(screen.getByText(/checked 2026-09-25/)).toBeInTheDocument();
  });

  test('with no full day yet it says so instead of projecting', async () => {
    apiFetch.mockResolvedValue(okJson({ ...SUMMARY, projectedUsdPer30Days: null }));
    render(<AiCostPanel />);
    expect(await screen.findByText(/no full day in this period to project from yet/)).toBeInTheDocument();
  });

  test('changing the period reloads for that many days', async () => {
    apiFetch.mockResolvedValue(okJson(SUMMARY));
    render(<AiCostPanel />);
    await screen.findByText('Label scan');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } });
    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith('/api/superadmin/ai/costs?days=7'));
  });

  test('a slower answer for the previous period never lands on top of the current one', async () => {
    let resolveSlow30;
    apiFetch.mockImplementation((path) => (path.endsWith('days=30')
      ? new Promise((resolve) => { resolveSlow30 = resolve; })
      : Promise.resolve(okJson({ ...SUMMARY, days: 7, total: { calls: 7, usd: 7.77 } }))));
    render(<AiCostPanel />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } });
    expect(await screen.findByText('$7.77')).toBeInTheDocument();

    await act(async () => { resolveSlow30(okJson({ ...SUMMARY, total: { calls: 30, usd: 30.3 } })); });
    expect(screen.getByText('$7.77')).toBeInTheDocument();
    expect(screen.queryByText('$30.30')).not.toBeInTheDocument();
  });

  test('an empty ledger says recording has not started, not that AI is free', async () => {
    apiFetch.mockResolvedValue(okJson({ ...SUMMARY, features: [], total: { calls: 0, usd: 0 }, projectedUsdPer30Days: null }));
    render(<AiCostPanel />);
    expect(await screen.findByText(/recording starts with the release/)).toBeInTheDocument();
  });

  test('a failed load shows the error — and never claims that nothing was recorded', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Failed to load AI costs' }) });
    render(<AiCostPanel />);
    expect(await screen.findByText('Failed to load AI costs')).toBeInTheDocument();
    expect(screen.queryByText(/recording starts with the release/)).not.toBeInTheDocument();
  });
});

describe('PromptCachingPanel', () => {
  test('saving sends the switch through the typed call, as a strict boolean', async () => {
    apiFetch.mockResolvedValue(okJson({ promptCaching: false }));
    render(<PromptCachingPanel enabled apiFetch={apiFetch} />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Saved — applies to the next scan and import/)).toBeInTheDocument();
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe('/api/superadmin/ai/prompt-caching');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });

  test('a refused save shows why', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'enabled must be a boolean' }) });
    render(<PromptCachingPanel enabled apiFetch={apiFetch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('enabled must be a boolean')).toBeInTheDocument();
  });
});
