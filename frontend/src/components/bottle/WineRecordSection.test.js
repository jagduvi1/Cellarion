import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

const { createWineProposal, getMyWineProposals } = await import('../../api/wineProposals');
const { getWinePublicData, suggestWineValue } = await import('../../api/registryData');
const WineRecordSection = (await import('./WineRecordSection')).default;

const WINE = {
  _id: 'w1',
  producer: 'Cloudy Bay',
  name: 'Sauvignon Blanc',
  appellation: null,
  classification: null,
  country: { name: 'New Zealand' },
  region: { name: 'Marlborough' },
};

const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  getMyWineProposals.mockResolvedValue(ok({ proposals: [] }));
  getWinePublicData.mockResolvedValue(ok({ fields: [] }));
});

const renderSection = (props = {}) =>
  render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} {...props} />);

// Per-row actions live behind ONE section-level toggle (Johan, 2026-08-17):
// most users never file a fix, so the default record must read clean.
const enterSuggestMode = () => fireEvent.click(screen.getByText('Suggest a fix'));

test('shows the full record with blanks rendered as "not recorded", never hidden', async () => {
  renderSection();
  expect(screen.getByText('Cloudy Bay')).toBeInTheDocument();
  expect(screen.getByText('Marlborough')).toBeInTheDocument();
  // appellation + classification are blank → two visible gaps
  expect(await screen.findAllByText('not recorded')).toHaveLength(2);
  expect(screen.getByText('Appellation')).toBeInTheDocument();
  expect(screen.getByText('Classification')).toBeInTheDocument();
});

test('per-row actions hide until the single section toggle is pressed, and hide again on Done', async () => {
  renderSection();
  await screen.findAllByText('not recorded');
  // Default: exactly ONE "Suggest a fix" (the toggle), no per-row buttons.
  expect(screen.getAllByText('Suggest a fix')).toHaveLength(1);
  expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();

  enterSuggestMode();
  expect(screen.getByLabelText('Suggest a fix for Producer')).toBeInTheDocument();
  expect(screen.getByText('+ Propose a new data field')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Done'));
  expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();
});

test('suggest flow posts one changed field with reason and marks it pending', async () => {
  createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p1', status: 'pending' } }));
  renderSection();
  await screen.findAllByText('not recorded');
  enterSuggestMode();

  fireEvent.click(screen.getByLabelText('Suggest a fix for Appellation'));
  expect(await screen.findByText('Suggest a fix: Appellation')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'Marlborough GI' } });
  fireEvent.change(screen.getByLabelText('How do you know?'), {
    target: { value: 'Printed on the back label.' },
  });
  fireEvent.click(screen.getByText('Send suggestion'));

  await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
    wineId: 'w1',
    fields: { appellation: 'Marlborough GI' },
    reason: 'Printed on the back label.',
  }));
  expect(await screen.findByText(/your suggestion is in the review queue/)).toBeInTheDocument();
  expect(screen.getByText('suggestion pending')).toBeInTheDocument();
});

test('a field with my pending proposal shows the pending marker instead of the button', async () => {
  getMyWineProposals.mockResolvedValue(ok({
    proposals: [{ status: 'pending', proposedFields: { producer: 'Cloudy Bay Vineyards' } }],
  }));
  renderSection();
  // Pending markers are STATUS, not affordance — visible without suggest mode.
  expect(await screen.findByText('suggestion pending')).toBeInTheDocument();
  enterSuggestMode();
  expect(screen.queryByLabelText('Suggest a fix for Producer')).not.toBeInTheDocument();
  // Other fields still suggestable
  expect(screen.getByLabelText('Suggest a fix for Country')).toBeInTheDocument();
});

test('demo/read-only mode renders the record without suggest actions', async () => {
  renderSection({ canSuggest: false });
  expect(screen.getByText('Cloudy Bay')).toBeInTheDocument();
  expect(screen.queryByText('Suggest a fix')).not.toBeInTheDocument();
  expect(getMyWineProposals).not.toHaveBeenCalled();
});

test('public data fields render with values, attribution and blanks; a blank invites Add value', async () => {
  getWinePublicData.mockResolvedValue(ok({
    fields: [
      { key: { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }, value: 13.5, contributedBy: 'Kurt', mySuggestion: null },
      { key: { _id: 'k2', name: 'Organic', type: 'boolean', unit: null, enumOptions: null }, value: null, contributedBy: null, mySuggestion: null },
    ],
  }));
  suggestWineValue.mockResolvedValue(ok({ value: { _id: 'v1', status: 'suggested' } }));
  renderSection();

  expect(await screen.findByText('More data')).toBeInTheDocument();
  expect(screen.getByText('13.5 %')).toBeInTheDocument();
  expect(screen.getByText('by Kurt')).toBeInTheDocument();

  enterSuggestMode();
  // Blank field offers "Add value" with the type-driven input (boolean → select)
  fireEvent.click(screen.getByLabelText('Suggest a value for Organic'));
  expect(await screen.findByText('Suggest a value: Organic')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'true' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  await waitFor(() => expect(suggestWineValue).toHaveBeenCalledWith(expect.any(Function), 'w1', {
    keyId: 'k2', value: true,
  }));
});

test('my pending public suggestion shows the pending marker', async () => {
  getWinePublicData.mockResolvedValue(ok({
    fields: [
      { key: { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }, value: null, contributedBy: null, mySuggestion: { value: 13.5, status: 'suggested' } },
    ],
  }));
  renderSection();
  expect(await screen.findByText('More data')).toBeInTheDocument();
  // one pending marker for the public field, none for identity fields
  expect(screen.getByText('suggestion pending')).toBeInTheDocument();
  expect(screen.queryByLabelText('Suggest a value for ABV')).not.toBeInTheDocument();
});

test('server rejection (e.g. daily limit) surfaces in the modal', async () => {
  createWineProposal.mockResolvedValue({ ok: false, json: async () => ({ error: "You have reached today's suggestion limit (3)." }) });
  renderSection();
  await screen.findAllByText('not recorded');
  enterSuggestMode();
  fireEvent.click(screen.getByLabelText('Suggest a fix for Country'));
  await screen.findByText('Suggest a fix: Country');
  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'France' } });
  fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Long enough reason here.' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  expect(await screen.findByText(/suggestion limit/)).toBeInTheDocument();
});
