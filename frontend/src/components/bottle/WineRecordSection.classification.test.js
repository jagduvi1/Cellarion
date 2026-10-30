import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The classification fix is chosen from the classification taxonomy, as in the
// admin wine form: the wine's country's own tiers plus the country-less ones,
// labelled by kind, the wine's current tiers chosen to begin with. The
// proposal route takes tier NAMES in one comma-separated string.

vi.mock('../../api/wineProposals', () => ({ createWineProposal: vi.fn(), getMyWineProposals: vi.fn() }));
vi.mock('../../api/taxonomy', () => ({ getGrapeNames: vi.fn(), getClassifications: vi.fn() }));
vi.mock('../../api/registryData', () => ({ getWinePublicData: vi.fn(), suggestWineValue: vi.fn(), proposeRegistryKey: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const { createWineProposal, getMyWineProposals } = await import('../../api/wineProposals');
const { getWinePublicData } = await import('../../api/registryData');
const { getGrapeNames, getClassifications } = await import('../../api/taxonomy');
const { __resetClassificationsCache } = await import('../../hooks/useClassifications');
const WineRecordSection = (await import('./WineRecordSection')).default;

const ok = (body) => ({ ok: true, json: async () => body });

const GERMANY = { _id: 'cDE', name: 'Germany' };
// What GET /api/taxonomy/classifications answers with (sorted by name).
const TIERS = [
  { _id: 'kGCC', name: 'Grand Cru Classé', kind: 'vineyard_rank', country: { _id: 'cFR', name: 'France' }, synonyms: [] },
  { _id: 'kRis', name: 'Riserva', kind: 'ageing', country: { _id: 'cIT', name: 'Italy' }, synonyms: [] },
  { _id: 'kSpa', name: 'Spätlese', kind: 'ripeness', country: null, synonyms: ['Spatlese'] },
  { _id: 'kVGL', name: 'VDP Grosse Lage', kind: 'vineyard_rank', country: GERMANY, synonyms: ['Grosse Lage'] },
];

const WINE = {
  _id: 'w1',
  producer: 'Dönnhoff',
  name: 'Hermannshöhle Riesling',
  appellation: 'Nahe',
  classification: 'Spätlese',
  // The bottle page populates the rows; the vintage page sends bare ids.
  classifications: [{ _id: 'kSpa', name: 'Spätlese', kind: 'ripeness' }],
  type: 'white',
  grapes: [{ _id: 'g1', name: 'Riesling' }],
  country: GERMANY,
  region: { name: 'Nahe' },
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetClassificationsCache();
  getMyWineProposals.mockResolvedValue(ok({ proposals: [] }));
  getWinePublicData.mockResolvedValue(ok({ fields: [] }));
  getGrapeNames.mockResolvedValue(ok({ grapes: [] }));
  getClassifications.mockResolvedValue(ok({ classifications: TIERS }));
});

const renderSection = (wine = WINE) =>
  render(<WineRecordSection wine={wine} canSuggest apiFetch={vi.fn()} />);

const openForm = async (field) => {
  fireEvent.click(screen.getByText('Suggest a fix'));
  fireEvent.click(screen.getByLabelText(`Suggest a fix for ${field}`));
  await screen.findByText(`Suggest a fix: ${field}`);
};
const openPicker = async () => {
  await openForm('Classification');
  await screen.findByPlaceholderText('Search the classification tiers…');
};
// A chip or an option reads "name" then its kind label in an <em>.
const chosen = () => [...document.querySelectorAll('.gpw-chip')].map((el) => el.firstChild.textContent);
const offered = () => [...document.querySelectorAll('.gpw-option')].map((el) => el.firstChild.textContent);
const giveReason = () =>
  fireEvent.change(screen.getByLabelText('How do you know?'), { target: { value: 'The capsule and the label both say so.' } });

test('only the classification form is a tier picker, and its list is fetched when it opens', async () => {
  renderSection();
  await screen.findByText('Dönnhoff');
  expect(getClassifications).not.toHaveBeenCalled();

  await openForm('Producer');
  expect(screen.getByLabelText('Should be')).toHaveValue('Dönnhoff');
  expect(screen.queryByPlaceholderText('Search the classification tiers…')).toBeNull();
  fireEvent.click(screen.getByText('Cancel'));
  expect(getClassifications).not.toHaveBeenCalled();

  fireEvent.click(screen.getByLabelText('Suggest a fix for Classification'));
  await screen.findByPlaceholderText('Search the classification tiers…');
  expect(getClassifications).toHaveBeenCalledTimes(1);
  // No free-text field beside the picker.
  expect(document.getElementById('wr-proposed')).toBeNull();
  expect(screen.getByRole('group', { name: 'Should be' })).toBeInTheDocument();
});

test('the tiers on offer are the wine\'s country\'s own and the country-less ones, labelled by kind', async () => {
  renderSection();
  await screen.findByText('Dönnhoff');
  await openPicker();

  expect(chosen()).toEqual(['Spätlese']);
  expect(offered()).toEqual(['VDP Grosse Lage']);
  const option = screen.getByRole('button', { name: /VDP Grosse Lage/ });
  expect(within(option).getByText('Vineyard rank')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Grand Cru Classé/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Riserva/ })).toBeNull();
});

test('the wine\'s current tiers start chosen — bare ids too, and one of another country stays visible', async () => {
  renderSection({ ...WINE, classification: 'Spätlese, Riserva', classifications: ['kSpa', 'kRis'] });
  await screen.findByText('Dönnhoff');
  await openPicker();

  expect(chosen()).toEqual(['Riserva', 'Spätlese']);
  expect(offered()).toEqual(['VDP Grosse Lage']);
  // Unchanged is nothing to send, whatever the reason says.
  giveReason();
  expect(screen.getByText('Send suggestion')).toBeDisabled();
});

test('a payload without the rows still finds the current tier by its name', async () => {
  renderSection({ ...WINE, classifications: undefined });
  await screen.findByText('Dönnhoff');
  await openPicker();
  expect(chosen()).toEqual(['Spätlese']);
});

test('the suggestion is one comma-separated string of tier names, in the registry\'s order', async () => {
  createWineProposal.mockResolvedValue(ok({
    proposal: { _id: 'p1', status: 'pending', proposedFields: { classification: 'VDP Grosse Lage, Spätlese' } },
  }));
  renderSection();
  await screen.findByText('Dönnhoff');
  await openPicker();

  fireEvent.click(screen.getByRole('button', { name: /VDP Grosse Lage/ }));
  expect(chosen()).toEqual(['Spätlese', 'VDP Grosse Lage']);
  giveReason();
  fireEvent.click(screen.getByText('Send suggestion'));

  // A vineyard rank before a ripeness tier, as the registry writes them.
  await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
    wineId: 'w1',
    fields: { classification: 'VDP Grosse Lage, Spätlese' },
    reason: 'The capsule and the label both say so.',
  }));
  expect(await screen.findByText('VDP Grosse Lage, Spätlese')).toBeInTheDocument();
  expect(screen.getByText('suggestion pending')).toBeInTheDocument();
});

test('every tier taken away is nothing to send — a suggestion names the tiers the wine should carry', async () => {
  renderSection();
  await screen.findByText('Dönnhoff');
  await openPicker();
  fireEvent.click(within(document.querySelector('.gpw-selected')).getByRole('button'));
  expect(chosen()).toEqual([]);
  giveReason();
  expect(screen.getByText('Send suggestion')).toBeDisabled();
});

test('a list that fails to load leaves the typed field, which still sends', async () => {
  getClassifications.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
  createWineProposal.mockResolvedValue(ok({ proposal: { _id: 'p1', status: 'pending' } }));
  renderSection();
  await screen.findByText('Dönnhoff');
  await openForm('Classification');

  expect(await screen.findByText(/Couldn’t load the list of tiers/)).toBeInTheDocument();
  expect(screen.getByLabelText('Should be')).toHaveValue('Spätlese');
  fireEvent.change(screen.getByLabelText('Should be'), { target: { value: 'Auslese' } });
  giveReason();
  fireEvent.click(screen.getByText('Send suggestion'));
  await waitFor(() => expect(createWineProposal).toHaveBeenCalledWith(expect.any(Function), {
    wineId: 'w1',
    fields: { classification: 'Auslese' },
    reason: 'The capsule and the label both say so.',
  }));
});

test('a list that fails to load can be retried, and the picker takes over', async () => {
  getClassifications.mockRejectedValueOnce(new Error('offline'));
  renderSection();
  await screen.findByText('Dönnhoff');
  await openForm('Classification');

  fireEvent.click(await screen.findByText('Retry'));
  await screen.findByPlaceholderText('Search the classification tiers…');
  expect(document.getElementById('wr-proposed')).toBeNull();
  expect(chosen()).toEqual(['Spätlese']);
  expect(getClassifications).toHaveBeenCalledTimes(2);
});

test('no tiers for the wine\'s country says so and leaves the typed field', async () => {
  getClassifications.mockResolvedValue(ok({ classifications: [TIERS[0], TIERS[1]] }));
  renderSection();
  await screen.findByText('Dönnhoff');
  await openForm('Classification');

  expect(await screen.findByText(/lists no classification tiers for this wine’s country/)).toBeInTheDocument();
  expect(screen.getByLabelText('Should be')).toHaveValue('Spätlese');
  expect(screen.queryByPlaceholderText('Search the classification tiers…')).toBeNull();
});

test("tiers that would pass the route's 200-character limit are not sent, and the form says why", async () => {
  const long = Array.from({ length: 8 }, (_, i) => ({
    _id: `kLong${i}`, name: `Very Long Regional Vineyard Rank ${i}`, kind: 'vineyard_rank', country: GERMANY, synonyms: [],
  }));
  getClassifications.mockResolvedValue(ok({ classifications: [...TIERS, ...long] }));
  renderSection();
  await screen.findByText('Dönnhoff');
  await openPicker();
  giveReason();

  for (const tier of long) fireEvent.click(screen.getByRole('button', { name: new RegExp(tier.name) }));
  expect(await screen.findByText(/Too many tiers for one suggestion/)).toBeInTheDocument();
  expect(screen.getByText('Send suggestion').closest('button')).toBeDisabled();
  expect(createWineProposal).not.toHaveBeenCalled();
});
