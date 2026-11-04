import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// On a server whose admin turned review of contributions off (discussion
// #1778), a fix goes live as it is sent: the record must say so instead of
// promising a curator, show no "pending" marker for a change that is already
// applied, and re-read the wine so the corrected value appears.

vi.mock('../../api/wineProposals', () => ({ createWineProposal: vi.fn(), getMyWineProposals: vi.fn() }));
vi.mock('../../api/taxonomy', () => ({ getGrapeNames: vi.fn() }));
vi.mock('../../api/registryData', () => ({ getWinePublicData: vi.fn(), suggestWineValue: vi.fn(), proposeRegistryKey: vi.fn() }));
vi.mock('../../utils/contributionReview', () => ({ useContributionReviewed: () => false }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const { createWineProposal, getMyWineProposals } = await import('../../api/wineProposals');
const { getWinePublicData, proposeRegistryKey } = await import('../../api/registryData');
const { getGrapeNames } = await import('../../api/taxonomy');
const WineRecordSection = (await import('./WineRecordSection')).default;

const ok = (body) => ({ ok: true, json: async () => body });
const WINE = {
  _id: 'w1', producer: 'Cloudy Bay', name: 'Te Koko', appellation: null, classification: null, type: 'white',
  grapes: [{ _id: 'g1', name: 'Sauvignon Blanc' }], country: { name: 'New Zealand' }, region: { name: 'Marlborough' },
};

beforeEach(() => {
  vi.clearAllMocks();
  getMyWineProposals.mockResolvedValue(ok({ proposals: [] }));
  getWinePublicData.mockResolvedValue(ok({ fields: [] }));
  getGrapeNames.mockResolvedValue(ok({ grapes: [] }));
});

test('the record says a change goes live at once, not that a curator reviews it', async () => {
  render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} />);
  expect(await screen.findByText('The shared registry’s record of this wine.')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Suggest a fix'));
  expect(screen.getByText(/your change goes live at once/)).toBeInTheDocument();
  expect(screen.queryByText(/a curator reviews/)).not.toBeInTheDocument();
});

test('an applied fix: no pending marker, "your change is live", and the wine is read again', async () => {
  createWineProposal.mockResolvedValue(ok({ applied: true, proposal: { _id: 'p1', status: 'approved' } }));
  const onWineChanged = vi.fn();
  render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} onWineChanged={onWineChanged} />);
  await screen.findAllByText('not recorded');
  fireEvent.click(screen.getByText('Suggest a fix'));
  fireEvent.click(screen.getByLabelText('Suggest a fix for Appellation'));
  await screen.findByText('Suggest a fix: Appellation');
  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'Marlborough' } });
  fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Printed on the back label.' } });
  fireEvent.click(screen.getByText('Send suggestion'));

  expect(await screen.findByText('Thank you — your change is live.')).toBeInTheDocument();
  expect(onWineChanged).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('suggestion pending')).not.toBeInTheDocument();
  expect(screen.queryByText(/review queue/)).not.toBeInTheDocument();
});

test('a new field accepted at once reloads the record so it shows', async () => {
  proposeRegistryKey.mockResolvedValue(ok({ applied: true, key: { _id: 'k1', name: 'Vineyard area', status: 'accepted' } }));
  render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} />);
  await screen.findAllByText('not recorded');
  fireEvent.click(screen.getByText('Suggest a fix'));
  fireEvent.click(screen.getByText('+ Propose a new data field'));
  const loadsBefore = getWinePublicData.mock.calls.length;
  fireEvent.change(await screen.findByLabelText('Field name'), { target: { value: 'Vineyard area' } });
  fireEvent.change(screen.getByLabelText('Why should every wine have this field?'), { target: { value: 'Hectares under vine, from the producer.' } });
  fireEvent.click(screen.getByText('Propose field'));

  expect(await screen.findByText('Thank you — your change is live.')).toBeInTheDocument();
  await waitFor(() => expect(getWinePublicData.mock.calls.length).toBeGreaterThan(loadsBefore));
});
