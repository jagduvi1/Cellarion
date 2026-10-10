import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../api/personalData', () => ({
  getPersonalData: vi.fn(),
  addPersonalData: vi.fn(),
  updatePersonalDataEntry: vi.fn(),
  deletePersonalDataEntry: vi.fn(),
  getPersonalDataKeys: vi.fn(),
}));

// The card passes English fallbacks inline — return those so assertions read
// like the real UI (the ConnectAi test convention). i18next interpolation is
// mimicked for the one {{name}} string.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const {
  getPersonalData, addPersonalData, deletePersonalDataEntry, getPersonalDataKeys,
} = await import('../../api/personalData');
const PersonalDataCard = (await import('./PersonalDataCard')).default;

const ME = 'user-me';
const BOTTLE_ID = 'b1';

const entry = (over = {}) => ({
  _id: 'e1',
  level: 'bottle',
  key: { _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null },
  value: 13.5,
  author: { _id: ME, username: 'johan', displayName: 'Johan' },
  updatedAt: '2026-08-17T00:00:00.000Z',
  ...over,
});

const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  getPersonalData.mockResolvedValue(ok({ bottleEntries: [], wineEntries: [] }));
  getPersonalDataKeys.mockResolvedValue(ok({ keys: [] }));
});

const renderCard = () =>
  render(<PersonalDataCard apiFetch={vi.fn()} bottleId={BOTTLE_ID} currentUserId={ME} />);

test('renders the empty state and fetches this bottle’s data', async () => {
  renderCard();
  expect(await screen.findByText('Nothing recorded yet.')).toBeInTheDocument();
  expect(getPersonalData).toHaveBeenCalledWith(expect.any(Function), BOTTLE_ID);
});

test('shows entries with unit, and attribution ONLY for other people’s entries', async () => {
  getPersonalData.mockResolvedValue(ok({
    bottleEntries: [entry()],
    wineEntries: [entry({
      _id: 'e2',
      level: 'wine',
      key: { _id: 'k2', name: 'Serve at', type: 'integer', unit: '°C', enumOptions: null },
      value: 16,
      author: { _id: 'user-other', username: 'kurt', displayName: 'Kurt' },
    })],
  }));
  renderCard();

  expect(await screen.findByText('13.5 %')).toBeInTheDocument();
  expect(screen.getByText('This bottle')).toBeInTheDocument();
  expect(screen.getByText('This wine (all bottles of it)')).toBeInTheDocument();
  // The co-member's entry is attributed; my own is not.
  expect(screen.getByText('by Kurt')).toBeInTheDocument();
  expect(screen.queryByText('by Johan')).not.toBeInTheDocument();
  // Edit/Delete only on my own entry.
  expect(screen.getAllByText('Edit')).toHaveLength(1);
});

test('boolean values render as Yes/No, not raw true/false', async () => {
  getPersonalData.mockResolvedValue(ok({
    bottleEntries: [entry({ key: { _id: 'k3', name: 'Organic', type: 'boolean', unit: null, enumOptions: null }, value: true })],
    wineEntries: [],
  }));
  renderCard();
  expect(await screen.findByText('Yes')).toBeInTheDocument();
  expect(screen.queryByText('true')).not.toBeInTheDocument();
});

test('add flow: new decimal key with unit posts and reloads', async () => {
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  renderCard();
  await screen.findByText('Nothing recorded yet.');

  fireEvent.click(screen.getByText('+ Add'));
  expect(await screen.findByText('Add wine data')).toBeInTheDocument();
  expect(getPersonalDataKeys).toHaveBeenCalled();

  fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), {
    target: { value: 'ABV' },
  });
  // A new key shows the type picker; choose decimal, set unit and value.
  fireEvent.change(screen.getByLabelText(/Value type/), { target: { value: 'decimal' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. %, °C, kr'), { target: { value: '%' } });
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '13.5' } });
  fireEvent.click(screen.getByText('Save'));

  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function),
    BOTTLE_ID,
    {
      level: 'bottle',
      value: '13.5',
      newKey: { name: 'ABV', type: 'decimal', unit: '%' },
    }
  ));
  // Reload after a successful save (initial load + reload).
  await waitFor(() => expect(getPersonalData).toHaveBeenCalledTimes(2));
});

test('typing a key that matches an existing one locks its stored type', async () => {
  getPersonalDataKeys.mockResolvedValue(ok({
    keys: [{ _id: 'k1', name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }],
  }));
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  renderCard();
  await screen.findByText('Nothing recorded yet.');

  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), {
    target: { value: 'abv' },
  });

  // Existing-key notice replaces the new-key fields; submit sends keyId.
  expect(await screen.findByText(/Existing key — type: decimal/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Value type/)).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '14' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function), BOTTLE_ID, { level: 'bottle', value: '14', keyId: 'k1' }
  ));
});

test('saved keys render as chips; clicking one selects it and offers its enum values', async () => {
  getPersonalDataKeys.mockResolvedValue(ok({
    keys: [{ _id: 'k9', name: 'Betyg', type: 'enum', unit: null, enumOptions: ['god', 'godare', 'godast'] }],
  }));
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  renderCard();
  await screen.findByText('Nothing recorded yet.');

  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');

  // The saved key is visible up front, not hidden behind type-ahead.
  expect(await screen.findByText('Your saved keys:')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Betyg' }));

  // Chip click selects the key: stored type locks, its value list appears.
  expect(await screen.findByText(/Existing key — type: enum/)).toBeInTheDocument();
  const valueSelect = screen.getByLabelText(/^Value$/);
  fireEvent.change(valueSelect, { target: { value: 'godast' } });
  fireEvent.click(screen.getByText('Save'));

  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function), BOTTLE_ID, { level: 'bottle', value: 'godast', keyId: 'k9' }
  ));
});

test('a rejected value surfaces the backend message and keeps the modal open', async () => {
  addPersonalData.mockResolvedValue({ ok: false, json: async () => ({ error: 'Expected a whole number' }) });
  renderCard();
  await screen.findByText('Nothing recorded yet.');

  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), {
    target: { value: 'Shelf' },
  });
  fireEvent.change(screen.getByLabelText(/Value type/), { target: { value: 'integer' } });
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '3' } });
  fireEvent.click(screen.getByText('Save'));

  expect(await screen.findByText('Expected a whole number')).toBeInTheDocument();
  expect(screen.getByText('Add wine data')).toBeInTheDocument();
});

// The vintage page (beta feedback 2026-10-10): the card reaches the data
// through one bottle of the vintage, so "This bottle only" means nothing
// there. Add offers this vintage (preselected) or every vintage; one bottle's
// own entries stay on that bottle's page.
test('on the vintage page: add on this vintage or all vintages, never "this bottle"; one bottle\'s entries are not shown', async () => {
  getPersonalData.mockResolvedValue(ok({
    bottleEntries: [entry()],
    wineEntries: [entry({ _id: 'e2', level: 'wine', vintage: '2015', key: { _id: 'k2', name: 'Lot', type: 'text', unit: null, enumOptions: null }, value: 'L123' })],
  }));
  addPersonalData.mockResolvedValue(ok({ entry: entry() }));
  render(<PersonalDataCard apiFetch={vi.fn()} bottleId={BOTTLE_ID} currentUserId={ME} wineId="w1" vintage="2015" scope="vintage" />);

  expect(await screen.findByText('L123')).toBeInTheDocument();
  expect(screen.queryByText('This bottle')).toBeNull();
  expect(screen.queryByText('13.5 %')).toBeNull();

  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  const options = [...screen.getByLabelText('Applies to').querySelectorAll('option')].map((o) => o.value);
  expect(options).toEqual(['wine-vintage', 'wine']);
  expect(screen.getByLabelText('Applies to')).toHaveValue('wine-vintage');

  fireEvent.change(screen.getByPlaceholderText('e.g. ABV, Provenance, Cork condition'), { target: { value: 'Critic score' } });
  fireEvent.change(screen.getByLabelText(/^Value$/), { target: { value: '96' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(addPersonalData).toHaveBeenCalledWith(
    expect.any(Function), BOTTLE_ID, expect.objectContaining({ level: 'wine', vintageScoped: true, value: '96' }),
  ));
});

test('on the bottle page "This bottle only" stays the default', async () => {
  render(<PersonalDataCard apiFetch={vi.fn()} bottleId={BOTTLE_ID} currentUserId={ME} vintage="2015" />);
  await screen.findByText('Nothing recorded yet.');
  fireEvent.click(screen.getByText('+ Add'));
  await screen.findByText('Add wine data');
  const options = [...screen.getByLabelText('Applies to').querySelectorAll('option')].map((o) => o.value);
  expect(options).toEqual(['bottle', 'wine-vintage', 'wine']);
  expect(screen.getByLabelText('Applies to')).toHaveValue('bottle');
});

test('delete removes own entry and reloads', async () => {
  getPersonalData.mockResolvedValue(ok({ bottleEntries: [entry()], wineEntries: [] }));
  deletePersonalDataEntry.mockResolvedValue(ok({ deleted: true }));
  renderCard();
  await screen.findByText('13.5 %');

  fireEvent.click(screen.getByText('Delete'));
  await waitFor(() => expect(deletePersonalDataEntry).toHaveBeenCalledWith(expect.any(Function), 'e1'));
  await waitFor(() => expect(getPersonalData).toHaveBeenCalledTimes(2));
});
