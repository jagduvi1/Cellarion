import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Per-vintage overrides on public values (2026-09-04). On a bottle page the
// section knows the vintage: values show which layer answered (this year's
// override vs the wine-wide default), a wine-wide value invites the
// year-specific figure, and the suggestion form asks ONE question — where the
// figure comes from — that decides the slot. Same mock rig as
// WineRecordSection.test.js.

vi.mock('../../api/wineProposals', () => ({
  createWineProposal: vi.fn(),
  getMyWineProposals: vi.fn(),
}));

vi.mock('../../api/registryData', () => ({
  getWinePublicData: vi.fn(),
  suggestWineValue: vi.fn(),
  proposeRegistryKey: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const { getMyWineProposals } = await import('../../api/wineProposals');
const { getWinePublicData, suggestWineValue } = await import('../../api/registryData');
const WineRecordSection = (await import('./WineRecordSection')).default;

const WINE = {
  _id: 'w1', producer: 'Cloudy Bay', name: 'Sauvignon Blanc',
  appellation: null, classification: null,
  country: { name: 'New Zealand' }, region: { name: 'Marlborough' },
};
const ABV = { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null };
const field = (extra) => ({
  key: ABV, value: null, resolvedFrom: null, resolvedVintage: null, wineValue: null, overrides: [],
  contributedBy: null, mySuggestion: null, hasPendingSuggestion: false, ...extra,
});

const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  getMyWineProposals.mockResolvedValue(ok({ proposals: [] }));
  suggestWineValue.mockResolvedValue(ok({ value: { _id: 'v1', status: 'suggested' } }));
});

const renderSection = (props = {}) =>
  render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} {...props} />);
const enterSuggestMode = () => fireEvent.click(screen.getByText('Suggest a fix'));

test('a wine-wide value on a vintage bottle is tagged and invites the year-specific figure', async () => {
  getWinePublicData.mockResolvedValue(ok({
    fields: [field({ value: 13.5, resolvedFrom: 'wine', wineValue: 13.5, contributedBy: 'Kurt' })],
  }));
  renderSection({ vintage: '2023' });
  expect(await screen.findByText('13.5 %')).toBeInTheDocument();
  expect(getWinePublicData).toHaveBeenCalledWith(expect.any(Function), 'w1', '2023');
  expect(screen.getByText('all vintages')).toBeInTheDocument();
  enterSuggestMode();
  expect(screen.getByLabelText('Suggest a value for ABV')).toHaveTextContent('Add 2023 value');
});

test('a vintage override is tagged with its year, not "all vintages"', async () => {
  getWinePublicData.mockResolvedValue(ok({
    fields: [field({ value: 14, resolvedFrom: 'vintage', resolvedVintage: '2023', wineValue: 13.5, overrides: [{ vintage: '2023', value: 14 }], contributedBy: 'Akki' })],
  }));
  renderSection({ vintage: '2023' });
  expect(await screen.findByText('14 %')).toBeInTheDocument();
  expect(screen.getByText('2023')).toBeInTheDocument();
  expect(screen.queryByText('all vintages')).not.toBeInTheDocument();
});

test('the form defaults to THIS vintage and sends it; widening to every vintage drops it', async () => {
  getWinePublicData.mockResolvedValue(ok({
    fields: [field({ value: 13.5, resolvedFrom: 'wine', wineValue: 13.5 })],
  }));
  renderSection({ vintage: '2023' });
  await screen.findByText('13.5 %');
  enterSuggestMode();
  fireEvent.click(screen.getByLabelText('Suggest a value for ABV'));
  await screen.findByText('Suggest a value: ABV');

  // The question, in the user's terms, with the vintage option pre-selected
  expect(screen.getByText('Where does this figure come from?')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /applies to 2023 only/ })).toBeChecked();
  expect(screen.getByText('Wine-wide value today: 13.5 %')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Value'), { target: { value: '14' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(expect.any(Function), 'w1', {
    keyId: 'k1', value: '14', vintage: '2023',
  }));

  // Widen: same form, the general-spec option, no vintage in the payload
  suggestWineValue.mockClear();
  fireEvent.click(screen.getByLabelText('Suggest a value for ABV'));
  await screen.findByText('Suggest a value: ABV');
  fireEvent.click(screen.getByRole('radio', { name: /applies to all vintages/ }));
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: '13' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(expect.any(Function), 'w1', {
    keyId: 'k1', value: '13',
  }));
});

test('off a bottle page there is no radio — a typed year scopes the suggestion, blank means every vintage', async () => {
  getWinePublicData.mockResolvedValue(ok({ fields: [field({})] }));
  renderSection();
  await screen.findByText('More data');
  expect(getWinePublicData).toHaveBeenCalledWith(expect.any(Function), 'w1', null);
  enterSuggestMode();
  fireEvent.click(screen.getByLabelText('Suggest a value for ABV'));
  await screen.findByText('Suggest a value: ABV');
  expect(screen.queryByText('Where does this figure come from?')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('For one vintage only? (optional)'), { target: { value: '2021' } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: '12.5' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(expect.any(Function), 'w1', {
    keyId: 'k1', value: '12.5', vintage: '2021',
  }));
});

test('NV and Unknown bottles read as no vintage: no tag, no radio', async () => {
  getWinePublicData.mockResolvedValue(ok({
    fields: [field({ value: 13.5, resolvedFrom: 'wine', wineValue: 13.5 })],
  }));
  renderSection({ vintage: 'NV' });
  await screen.findByText('13.5 %');
  expect(getWinePublicData).toHaveBeenCalledWith(expect.any(Function), 'w1', null);
  expect(screen.queryByText('all vintages')).not.toBeInTheDocument();
});
