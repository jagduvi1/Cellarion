import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// "This wine in your cellar" (support ticket 2026-09-16): the viewer's other
// bottles of this wine, and what happened to the ones already drunk. Pins the
// three decisions that make the card worth having — it hides itself when there
// is nothing to say, it links each drunk sibling to its own page without
// linking the bottle you are on, and it keeps other vintages in a separate,
// collapsed section rather than merging them into one list.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t }) };
});
vi.mock('../../api/bottles', () => ({ fetchLotHistory: vi.fn() }));
vi.mock('../RatingDisplay', () => ({ default: ({ value }) => <span data-testid="rating">{value}</span> }));
vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
}));
const { apiFetch } = vi.hoisted(() => ({ apiFetch: () => {} }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch, user: { preferences: { ratingScale: '5' } } }),
}));

const { fetchLotHistory } = await import('../../api/bottles');
const { default: LotHistory } = await import('./LotHistory');

const respond = (lots) => fetchLotHistory.mockResolvedValue({ ok: true, json: async () => ({ lots }) });

const lot = (vintage, over = {}) => ({
  wine: { wine_id: 'w1', name: 'Ch. Test' },
  vintage,
  counts: { total: 1, remaining: 1, consumed: 0 },
  consumed_events: [],
  ...over,
});
const event = (id, over = {}) => ({
  bottle_id: id, date: '2026-01-10T00:00:00.000Z', reason: 'drank',
  rating: 4, rating_scale: '5', note: 'Singing now', ...over,
});

const mount = (props = {}) => render(<LotHistory apiFetch={apiFetch} bottleId="b1" vintage="2020" {...props} />);

beforeEach(() => vi.clearAllMocks());

describe('LotHistory', () => {
  test('a lone bottle that was never drunk renders nothing — no empty box on a one-bottle cellar', async () => {
    respond([lot('2020')]);
    const { container } = mount();
    await waitFor(() => expect(fetchLotHistory).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('asks for every vintage in one call, so the toggle below needs no second request', async () => {
    respond([lot('2020')]);
    mount();
    await waitFor(() => expect(fetchLotHistory).toHaveBeenCalledWith(apiFetch, 'b1', { vintages: 'all' }));
  });

  test('shows the counts and each drunk sibling with its rating and note, linked to its own page', async () => {
    respond([lot('2020', {
      counts: { total: 3, remaining: 1, consumed: 2 },
      consumed_events: [event('b2'), event('b3', { note: 'Still tight', rating: 3 })],
    })]);
    mount();

    expect(await screen.findByText('lotHistory.title')).toBeInTheDocument();
    expect(screen.getByText('lotHistory.remaining:{"count":1}')).toBeInTheDocument();
    expect(screen.getByText('lotHistory.consumed:{"count":2}')).toBeInTheDocument();
    expect(screen.getByText('\u201CSinging now\u201D')).toBeInTheDocument();
    expect(screen.getByText('\u201CStill tight\u201D')).toBeInTheDocument();
    expect(screen.getAllByTestId('rating').map((n) => n.textContent)).toEqual(['4', '3']);

    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/bottles/b2', '/bottles/b3']);
  });

  test('the bottle you are looking at is counted but never linked to the page you are on', async () => {
    respond([lot('2020', {
      counts: { total: 2, remaining: 0, consumed: 2 },
      consumed_events: [event('b1'), event('b2')],
    })]);
    mount();

    expect(await screen.findByText('lotHistory.thisBottle')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/bottles/b2');
  });

  test('other vintages are a collapsed section, never merged into this vintage', async () => {
    respond([
      lot('2020', { counts: { total: 2, remaining: 2, consumed: 0 } }),
      lot('2019', { counts: { total: 2, remaining: 0, consumed: 2 }, consumed_events: [event('b9', { note: 'The 2019 was ready' })] }),
    ]);
    mount();

    // Collapsed: the older vintage's note is not on screen until asked for.
    expect(await screen.findByText('lotHistory.showOtherVintages:{"count":1}')).toBeInTheDocument();
    expect(screen.queryByText('\u201CThe 2019 was ready\u201D')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'lotHistory.showOtherVintages:{"count":1}' }));
    expect(screen.getByText('2019')).toBeInTheDocument();
    expect(screen.getByText('\u201CThe 2019 was ready\u201D')).toBeInTheDocument();
    // And it says why they are kept apart.
    expect(screen.getByText('lotHistory.otherVintagesHint')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'lotHistory.hideOtherVintages' }));
    expect(screen.queryByText('\u201CThe 2019 was ready\u201D')).not.toBeInTheDocument();
  });

  test('a lone bottle of this vintage still renders when another vintage has history', async () => {
    respond([
      lot('2020'),
      lot('2019', { counts: { total: 1, remaining: 0, consumed: 1 }, consumed_events: [event('b9')] }),
    ]);
    mount();
    expect(await screen.findByText('lotHistory.title')).toBeInTheDocument();
  });

  test('a vintage the viewer no longer holds says so rather than showing a blank block', async () => {
    respond([lot('2019', { counts: { total: 1, remaining: 0, consumed: 1 }, consumed_events: [event('b9')] })]);
    mount({ vintage: '2021' });
    expect(await screen.findByText('lotHistory.noneThisVintage')).toBeInTheDocument();
  });

  test('a failed request renders nothing instead of breaking the bottle page', async () => {
    fetchLotHistory.mockRejectedValue(new Error('offline'));
    const { container } = mount();
    await waitFor(() => expect(fetchLotHistory).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('an error response renders nothing', async () => {
    fetchLotHistory.mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) });
    const { container } = mount();
    await waitFor(() => expect(fetchLotHistory).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
