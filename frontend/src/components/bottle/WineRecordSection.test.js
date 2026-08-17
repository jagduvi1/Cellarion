import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../api/wineProposals', () => ({
  createWineProposal: vi.fn(),
  getMyWineProposals: vi.fn(),
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
});

const renderSection = (props = {}) =>
  render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} {...props} />);

test('shows the full record with blanks rendered as "not recorded", never hidden', async () => {
  renderSection();
  expect(screen.getByText('Cloudy Bay')).toBeInTheDocument();
  expect(screen.getByText('Marlborough')).toBeInTheDocument();
  // appellation + classification are blank → two visible gaps
  expect(await screen.findAllByText('not recorded')).toHaveLength(2);
  expect(screen.getByText('Appellation')).toBeInTheDocument();
  expect(screen.getByText('Classification')).toBeInTheDocument();
});

test('suggest flow posts one changed field with reason and marks it pending', async () => {
  createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p1', status: 'pending' } }));
  renderSection();

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
  expect(await screen.findByText('suggestion pending')).toBeInTheDocument();
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

test('server rejection (e.g. daily limit) surfaces in the modal', async () => {
  createWineProposal.mockResolvedValue({ ok: false, json: async () => ({ error: "You have reached today's suggestion limit (3)." }) });
  renderSection();
  fireEvent.click(screen.getByLabelText('Suggest a fix for Country'));
  await screen.findByText('Suggest a fix: Country');
  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'France' } });
  fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'Long enough reason here.' } });
  fireEvent.click(screen.getByText('Send suggestion'));
  expect(await screen.findByText(/suggestion limit/)).toBeInTheDocument();
});
