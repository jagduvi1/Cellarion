import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// An NV (relative) drink window stores years after purchase, so 0 — "drink
// from purchase" — is a real value. Re-saving a reviewed window from this page
// must keep it, not send the field back as null.

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));
vi.mock('../components/SommWineProfilePanel', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));

const SommMaturity = (await import('./SommMaturity')).default;

const ok = (body) => ({ ok: true, json: async () => body });
const WINE = { _id: 'w1', name: 'Brut Réserve', producer: 'Example House', type: 'sparkling' };
const nvProfile = (window) => ({
  _id: 'p1', wineDefinition: WINE, vintage: 'NV', relative: true, status: 'reviewed', sommNotes: '', ...window,
});

const serve = (profile) => {
  apiFetch.mockImplementation(async (url, opts) => {
    if (opts?.method === 'PUT') return ok({ profile: { ...profile, ...JSON.parse(opts.body) } });
    return ok(url.includes('status=reviewed') ? { profiles: [profile], total: 1 } : { profiles: [], total: 0 });
  });
};

// The six window inputs, in page order: early from/until, peak, late.
const openReviewedCard = async () => {
  render(<SommMaturity />);
  fireEvent.click(screen.getByRole('button', { name: 'somm.maturity.reviewedTab' }));
  fireEvent.click(await screen.findByText('Brut Réserve'));
  return screen.getAllByRole('spinbutton');
};

const sentBody = () => {
  const put = apiFetch.mock.calls.find(([, opts]) => opts?.method === 'PUT');
  return JSON.parse(put[1].body);
};

beforeEach(() => vi.clearAllMocks());

test('a stored 0 offset is shown as 0', async () => {
  serve(nvProfile({ earlyFrom: 0, earlyUntil: 2, peakFrom: 3, peakUntil: 6, lateFrom: 7, lateUntil: 10 }));
  const inputs = await openReviewedCard();
  expect(inputs.map((i) => i.value)).toEqual(['0', '2', '3', '6', '7', '10']);
});

test('saving without touching the window sends the 0 back as 0', async () => {
  serve(nvProfile({ earlyFrom: 0, earlyUntil: 2, peakFrom: 3, peakUntil: 6, lateFrom: 7, lateUntil: 10 }));
  await openReviewedCard();
  fireEvent.click(screen.getByRole('button', { name: 'somm.maturity.markReviewed' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/somm/maturity/p1', expect.objectContaining({ method: 'PUT' })));
  expect(sentBody()).toMatchObject({ earlyFrom: 0, earlyUntil: 2, peakFrom: 3, peakUntil: 6, lateFrom: 7, lateUntil: 10 });
});

test('a field that was never set stays empty and is sent as null', async () => {
  serve(nvProfile({ earlyUntil: 2, peakFrom: 3, peakUntil: 6, lateFrom: 7, lateUntil: 10 }));
  const inputs = await openReviewedCard();
  expect(inputs[0].value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'somm.maturity.markReviewed' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/somm/maturity/p1', expect.objectContaining({ method: 'PUT' })));
  expect(sentBody().earlyFrom).toBeNull();
});

test('a window an install suggested sits beside an empty form, and fills it only when the curator asks', async () => {
  const profile = {
    _id: 'p2', wineDefinition: { ...WINE, type: 'red' }, vintage: '2019', relative: false, status: 'pending', sommNotes: '',
    suggestion: { source: 'bridge', earlyFrom: 2022, earlyUntil: 2025, peakFrom: 2026, peakUntil: 2034 },
  };
  apiFetch.mockImplementation(async (url, opts) => {
    if (opts?.method === 'PUT') return ok({ profile: { ...profile, ...JSON.parse(opts.body) } });
    return ok(url.includes('status=reviewed') ? { profiles: [], total: 0 } : { profiles: [profile], total: 1 });
  });
  render(<SommMaturity />);
  // A pending card opens expanded.
  await screen.findByText('Brut Réserve');

  // Never in the window itself, and never shown as anyone's review.
  expect(screen.getAllByRole('spinbutton').map((i) => i.value)).toEqual(['', '', '', '', '', '']);
  expect(screen.getByText(/Suggested by the self-hosted install/)).toHaveTextContent(/2022–2025.*2026–2034/);
  expect(screen.queryByText(/somm\.maturity\.lastReviewedBy/)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Use as a starting point' }));
  expect(screen.getAllByRole('spinbutton').map((i) => i.value)).toEqual(['2022', '2025', '2026', '2034', '', '']);
  expect(apiFetch.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
});
