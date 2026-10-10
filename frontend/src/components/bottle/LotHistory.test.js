import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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
  Link: ({ to, children, state, ...rest }) => <a href={to} data-state={state ? JSON.stringify(state) : undefined} {...rest}>{children}</a>,
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
  bottle_id: id, cellar_id: 'c1', date: '2026-01-10T00:00:00.000Z', reason: 'drank',
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
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/cellars/c1/bottles/b2', '/cellars/c1/bottles/b3']);
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
    expect(links[0]).toHaveAttribute('href', '/cellars/c1/bottles/b2');
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

  test('a lone drunk bottle renders nothing — its one row would only repeat the consumption card above', async () => {
    respond([lot('2020', { counts: { total: 1, remaining: 0, consumed: 1 }, consumed_events: [event('b1')] })]);
    const { container } = mount();
    await waitFor(() => expect(fetchLotHistory).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('a bottle in a cellar the viewer does not own asks for nothing and renders nothing', async () => {
    respond([lot('2020', { counts: { total: 3, remaining: 1, consumed: 2 }, consumed_events: [event('b2'), event('b3')] })]);
    const { container } = mount({ isOwner: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchLotHistory).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  test('the reason label uses the shared history keys, so it translates like the rest of the page', async () => {
    respond([lot('2020', { counts: { total: 2, remaining: 1, consumed: 1 }, consumed_events: [event('b2', { reason: 'gifted' })] })]);
    mount();
    expect(await screen.findByText('history.reasonGifted')).toBeInTheDocument();
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

/**
 * Support ticket 2026-10-09 (follow-up): once the last bottle of a vintage is
 * drunk the cellar list has no group to open the vintage page from, so the
 * card offers the link — and shows for the link alone on a lone drunk bottle.
 */
describe('LotHistory and the vintage page link', () => {
  test('renders the link when given one, even with nothing else to say', async () => {
    respond([lot('2020')]);
    mount({ vintageHref: '/cellars/c1/vintages/w1/2020' });
    const link = await screen.findByText('lotHistory.openVintage');
    expect(link.closest('a')).toHaveAttribute('href', '/cellars/c1/vintages/w1/2020');
  });

  test('without a link the lone-bottle card still hides itself', async () => {
    respond([lot('2020')]);
    const { container } = mount();
    await waitFor(() => expect(fetchLotHistory).toHaveBeenCalled());
    expect(container.querySelector('.lot-history')).toBeNull();
  });
});

/**
 * On the vintage page itself (beta feedback 2026-10-10): the page already
 * says how many bottles there are, so no counts; the drunk bottles of this
 * vintage keep their dates, ratings and notes; the other vintages are rows
 * that open their own vintage pages, with no "kept apart" hint.
 */
describe('LotHistory on the vintage page', () => {
  const onPage = (over = {}) => mount({ vintagePage: { cellarId: 'c1', fromPath: '/cellars/c1/vintages/w1/2020', consumedCount: 2, ...over } });
  // Let the answer land before asserting on what is NOT there.
  const settle = () => act(() => new Promise((r) => { setTimeout(r, 0); }));

  test('this cellar\'s drunk bottles of the vintage, each linked to its page with the way back — no count line repeating the page', async () => {
    respond([lot('2020', {
      counts: { total: 4, remaining: 1, consumed: 3 },
      // b8 was drunk from another of the owner's cellars: not this page's.
      consumed_events: [event('b2'), event('b1', { note: 'Still tight' }), event('b8', { cellar_id: 'c9' })],
    })]);
    onPage();
    expect(await screen.findByText('lotHistory.drunkTitle')).toBeInTheDocument();
    expect(screen.queryByText('lotHistory.title')).toBeNull();
    expect(screen.queryByText(/lotHistory.remaining/)).toBeNull();
    // b1 is the bottle the page reads through, not a bottle on screen: linked too.
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/cellars/c1/bottles/b2', '/cellars/c1/bottles/b1']);
    expect(links[0]).toHaveAttribute('data-state', '{"fromVintage":"/cellars/c1/vintages/w1/2020"}');
    // Every drunk bottle of this cellar is shown: no "all in the history" link.
    expect(screen.queryByText(/lotHistory.allInHistory/)).toBeNull();
  });

  test('when the cellar drank more than the rows show, the card leads to the cellar history', async () => {
    respond([lot('2020', { counts: { total: 7, remaining: 1, consumed: 6 }, consumed_events: [event('b2'), event('b3')] })]);
    onPage({ consumedCount: 6 });
    const more = await screen.findByText(/lotHistory.allInHistory:\{"count":6\}/);
    expect(more.closest('a')).toHaveAttribute('href', '/cellars/c1/history');
  });

  test('other vintages are rows that open their own vintage page, in the cellar that holds them', async () => {
    respond([
      lot('2021', { cellar_ids: ['c2'], counts: { total: 2, remaining: 2, consumed: 0 } }),
      lot('2020'),
      lot('2018', { cellar_ids: ['c2', 'c1'], counts: { total: 3, remaining: 1, consumed: 2 } }),
      lot('NV', { cellar_ids: [] }),
    ]);
    onPage();
    expect(await screen.findByText('lotHistory.otherVintagesTitle')).toBeInTheDocument();
    expect(screen.queryByText('lotHistory.otherVintagesHint')).toBeNull();
    expect(screen.queryByText(/lotHistory.showOtherVintages/)).toBeNull();
    const hrefs = [...document.querySelectorAll('.lot-history__vintage-row')].map((a) => a.getAttribute('href'));
    // 2021 only in c2; 2018 in this cellar too, so here; no cellar named → here.
    expect(hrefs).toEqual(['/cellars/c2/vintages/w1/2021', '/cellars/c1/vintages/w1/2018', '/cellars/c1/vintages/w1/NV']);
    expect(screen.getByText('2018').closest('a')).toHaveTextContent('lotHistory.remaining:{"count":1} · lotHistory.consumed:{"count":2}');
  });

  test('nothing drunk here and no other vintage: nothing at all', async () => {
    // Drunk only from another cellar: nothing for this page either.
    respond([lot('2020', { counts: { total: 3, remaining: 2, consumed: 1 }, consumed_events: [event('b8', { cellar_id: 'c9' })] })]);
    const { container } = onPage({ consumedCount: 0 });
    await waitFor(() => expect(fetchLotHistory).toHaveBeenCalled());
    await settle();
    expect(container).toBeEmptyDOMElement();
  });
});
