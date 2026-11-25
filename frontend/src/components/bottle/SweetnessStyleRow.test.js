import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The "Sweetness" row of the wine record. Two facts can stand in it and must
// not look alike: the term the LABEL prints, and the term the wine is KNOWN
// by (the style), which always says who names it and links the page. Only the
// style is suggested here — as a term, a source and a link in one field — and
// on a wine that has none the server applies it at once.

vi.mock('../../api/wineProposals', () => ({ createWineProposal: vi.fn(), getMyWineProposals: vi.fn() }));
vi.mock('../../api/taxonomy', () => ({ getGrapeNames: vi.fn(), getSweetnessTerms: vi.fn() }));
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
const { getSweetnessTerms } = await import('../../api/taxonomy');
const WineRecordSection = (await import('./WineRecordSection')).default;

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const refused = (status, body) => ({ ok: false, status, headers: { get: () => null }, json: async () => body });
const WINE = {
  _id: 'w1', producer: 'Weingut Beispiel', name: 'Riesling Kabinett', appellation: 'Mosel', classification: 'Kabinett',
  type: 'white', grapes: [{ _id: 'g1', name: 'Riesling' }], country: { name: 'Germany' }, region: { name: 'Mosel' },
  labelSweetness: null, sweetnessStyle: null,
};
const TERMS = [
  { _id: 't1', name: 'trocken', scale: 'still', band: 'dry', regulated: true },
  { _id: 't2', name: 'halbtrocken', scale: 'still', band: 'off-dry', regulated: true },
  { _id: 't3', name: 'feinherb', scale: 'still', band: 'off-dry', regulated: false },
  { _id: 't4', name: 'fruchtsüß', scale: 'still', band: 'medium-sweet', regulated: false },
];
const URL = 'https://merchant.example/riesling-kabinett';

const sweetnessRow = () => screen.getByText('Sweetness').closest('.wr-row');
const openForm = async (wine = WINE, props = {}) => {
  render(<WineRecordSection wine={wine} canSuggest apiFetch={vi.fn()} {...props} />);
  await screen.findByText('Sweetness');
  fireEvent.click(screen.getByText('Suggest a fix'));
  fireEvent.click(screen.getByLabelText('Suggest a fix for Sweetness'));
  await screen.findByLabelText('The term');
};
const fill = ({ term, source, url = URL }) => {
  fireEvent.change(screen.getByLabelText('The term'), { target: { value: term } });
  if (source) fireEvent.click(screen.getByRole('radio', { name: source }));
  if (url) fireEvent.change(screen.getByLabelText('The page that names it'), { target: { value: url } });
};

beforeEach(() => {
  vi.clearAllMocks();
  getMyWineProposals.mockResolvedValue(ok({ proposals: [] }));
  getWinePublicData.mockResolvedValue(ok({ fields: [] }));
  getSweetnessTerms.mockResolvedValue(ok({ terms: TERMS }));
});

describe('what the row shows', () => {
  test('a style reads as the term, "known as", and who names it — linked to the page', async () => {
    const wine = { ...WINE, sweetnessStyle: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: URL } };
    render(<WineRecordSection wine={wine} canSuggest={false} apiFetch={vi.fn()} />);
    const row = (await screen.findByText('Sweetness')).closest('.wr-row');
    expect(within(row).getByText(/feinherb/)).toBeInTheDocument();
    expect(within(row).getByText(/known as/)).toBeInTheDocument();
    const link = within(row).getByRole('link', { name: 'named by the trade' });
    expect(link).toHaveAttribute('href', URL);
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  test('the label\'s own term is shown as it is, never as "known as", and takes no suggestion here', async () => {
    const wine = { ...WINE, labelSweetness: { name: 'trocken', band: 'dry', scale: 'still', regulated: true } };
    render(<WineRecordSection wine={wine} canSuggest apiFetch={vi.fn()} />);
    await screen.findByText('Sweetness');
    expect(within(sweetnessRow()).getByText('trocken')).toBeInTheDocument();
    expect(within(sweetnessRow()).queryByText(/known as/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Suggest a fix'));
    expect(screen.queryByLabelText('Suggest a fix for Sweetness')).not.toBeInTheDocument();
  });

  test('a wine with neither says "not recorded" and offers Add', async () => {
    render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} />);
    await screen.findByText('Sweetness');
    expect(within(sweetnessRow()).getByText('not recorded')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Suggest a fix'));
    expect(within(sweetnessRow()).getByRole('button', { name: 'Suggest a fix for Sweetness' })).toHaveTextContent('Add');
  });

  test('a fortified wine and a drink that is not wine have no sweetness row', async () => {
    const { unmount } = render(<WineRecordSection wine={{ ...WINE, type: 'fortified' }} canSuggest apiFetch={vi.fn()} />);
    await screen.findByText('Wine record');
    expect(screen.queryByText('Sweetness')).not.toBeInTheDocument();
    unmount();
    render(<WineRecordSection wine={{ ...WINE, nonWine: true }} canSuggest apiFetch={vi.fn()} />);
    await screen.findByText('Wine record');
    expect(screen.queryByText('Sweetness')).not.toBeInTheDocument();
  });
});

describe('suggesting a style', () => {
  test('the terms offered are the ones of the wine\'s scale, grouped by band', async () => {
    await openForm();
    expect(getSweetnessTerms).toHaveBeenCalledWith(expect.any(Function), 'still');
    const select = screen.getByLabelText('The term');
    // Dry first. (The band ids stand in here for the words the locale gives them.)
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['dry', 'off-dry', 'medium-sweet']);
    expect(within(select).getByRole('option', { name: 'feinherb' })).toBeInTheDocument();
  });

  test('a term, a source and a link are sent as one field, with the link as the evidence', async () => {
    createWineProposal.mockResolvedValue(ok({ applied: true, proposal: { _id: 'p1', status: 'approved' } }));
    const onWineChanged = vi.fn();
    await openForm(WINE, { onWineChanged });
    fill({ term: 'feinherb', source: 'A merchant, critic or wine database' });
    fireEvent.click(screen.getByText('Send suggestion'));

    await waitFor(() => expect(createWineProposal).toHaveBeenCalledTimes(1));
    expect(createWineProposal.mock.calls[0][1]).toEqual({
      wineId: 'w1',
      fields: { sweetnessStyle: { term: 'feinherb', source: 'trade', url: URL } },
      reason: 'feinherb: the term this wine is known by, named by the trade on the linked page.',
      evidenceUrl: URL,
    });
    // On a wine that had none the server applied it: live, and the wine is read again.
    expect(await screen.findByText('Thank you — your change is live.')).toBeInTheDocument();
    expect(onWineChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('suggestion pending')).not.toBeInTheDocument();
  });

  test('a note of the member\'s own replaces the composed reason', async () => {
    createWineProposal.mockResolvedValue(ok({ applied: true, proposal: { _id: 'p1' } }));
    await openForm();
    fill({ term: 'feinherb', source: 'The producer' });
    fireEvent.change(screen.getByLabelText('Anything a curator should know (optional)'), { target: { value: 'The estate’s own list calls the 2019 feinherb.' } });
    fireEvent.click(screen.getByText('Send suggestion'));
    await waitFor(() => expect(createWineProposal).toHaveBeenCalledTimes(1));
    expect(createWineProposal.mock.calls[0][1]).toMatchObject({
      fields: { sweetnessStyle: { term: 'feinherb', source: 'producer', url: URL } },
      reason: 'The estate’s own list calls the 2019 feinherb.',
    });
  });

  test('nothing can be sent without a term, a source and a link', async () => {
    await openForm();
    const send = screen.getByText('Send suggestion');
    expect(send).toBeDisabled();
    fill({ term: 'feinherb', source: null, url: null });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'The producer' }));
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('The page that names it'), { target: { value: 'not a link' } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('The page that names it'), { target: { value: URL } });
    expect(send).toBeEnabled();
  });

  test('a term with a legal definition can only be named by the producer', async () => {
    createWineProposal.mockResolvedValue(ok({ applied: true, proposal: { _id: 'p1' } }));
    await openForm();
    fill({ term: 'halbtrocken', source: null });
    expect(screen.getByRole('radio', { name: 'A merchant, critic or wine database' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'The producer' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/has a legal definition/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Send suggestion'));
    await waitFor(() => expect(createWineProposal).toHaveBeenCalledTimes(1));
    expect(createWineProposal.mock.calls[0][1].fields.sweetnessStyle.source).toBe('producer');
  });

  test('a second opinion on a recorded style waits: it shows as the member\'s own pending suggestion', async () => {
    const wine = { ...WINE, sweetnessStyle: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: URL } };
    createWineProposal.mockResolvedValue(ok({
      applied: false, amended: false,
      proposal: { _id: 'p1', status: 'pending', proposedFields: { sweetnessStyle: { term: 'fruchtsüß', source: 'trade', url: 'https://critic.example/note' } } },
    }));
    await openForm(wine);
    expect(screen.getByText('feinherb (named by the trade)')).toBeInTheDocument(); // currently recorded
    fill({ term: 'fruchtsüß', source: 'A merchant, critic or wine database', url: 'https://critic.example/note' });
    fireEvent.click(screen.getByText('Send suggestion'));

    expect(await screen.findByText(/your suggestion is in the review queue/)).toBeInTheDocument();
    const row = sweetnessRow();
    expect(within(row).getByText('fruchtsüß (named by the trade)')).toBeInTheDocument();
    expect(within(row).getByText('suggestion pending')).toBeInTheDocument();
    // One pending suggestion at a time: no second one from the same row.
    expect(screen.queryByLabelText('Suggest a fix for Sweetness')).not.toBeInTheDocument();
  });

  test('a refusal from the server is shown in the form, which stays open', async () => {
    createWineProposal.mockResolvedValue(refused(400, { error: 'The style was not written: the label states "trocken", the style named is "feinherb".' }));
    await openForm();
    fill({ term: 'feinherb', source: 'The producer' });
    fireEvent.click(screen.getByText('Send suggestion'));
    expect(await screen.findByText(/the label states "trocken"/)).toBeInTheDocument();
    expect(screen.getByLabelText('The term')).toBeInTheDocument();
  });

  test('a list that does not load says so and can be fetched again', async () => {
    getSweetnessTerms.mockResolvedValueOnce(refused(500, { error: 'Failed to fetch sweetness terms' }));
    render(<WineRecordSection wine={WINE} canSuggest apiFetch={vi.fn()} />);
    await screen.findByText('Sweetness');
    fireEvent.click(screen.getByText('Suggest a fix'));
    fireEvent.click(screen.getByLabelText('Suggest a fix for Sweetness'));
    expect(await screen.findByText('Couldn’t load the list of sweetness terms.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByLabelText('The term')).toBeInTheDocument();
    expect(getSweetnessTerms).toHaveBeenCalledTimes(2);
  });
});
