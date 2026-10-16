import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarOnOrder from './CellarOnOrder';

// Bottles bought for a cellar that have not arrived yet: grouped per
// delivery, and "Mark as arrived" turns some or all of a group into ordinary
// bottles (one request: single arrive for one bottle, bulk for several).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, opts) => {
      if (opts && opts.count !== undefined) return `${k}:${opts.count}`;
      if (opts && opts.month) return `${k}:${opts.month}`;
      return k;
    },
    i18n: { language: 'en-GB' },
  }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner' };
const ordered = (id, month) => ({
  _id: id, status: 'ordered', vintage: '2023', bottleSize: '750ml', price: 60, currency: 'EUR',
  expectedArrival: month, wineDefinition: { _id: 'w1', name: 'Léoville Barton', producer: 'Barton' },
});
const MARCH = '2027-03-01T12:00:00Z';

let api;
beforeEach(() => {
  api = vi.fn(async (url) => {
    if (url === '/api/cellars/c1/on-order') {
      return ok({ cellar: CELLAR, bottles: [ordered('b1', MARCH), ordered('b2', MARCH), ordered('b3', MARCH)], total: 3 });
    }
    if (url === '/api/bottles/bulk') return ok({ done: 2, doneIds: ['b1', 'b2'], skipped: [] });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1' } };
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/on-order']}>
    <Routes><Route path="/cellars/:id/on-order" element={<CellarOnOrder />} /></Routes>
  </MemoryRouter>,
);

test('one row per delivery with its count, month and the paid total', async () => {
  renderPage();
  expect(await screen.findByText('Léoville Barton')).toBeInTheDocument();
  expect(screen.getByText(/onOrder.qty:3/)).toBeInTheDocument();
  expect(screen.getByText('onOrder.expected:March 2027')).toBeInTheDocument();
  expect(screen.getByText('onOrder.paidTotal')).toBeInTheDocument();
});

test('marking two of three as arrived sends ONE bulk request and leaves the third on the list', async () => {
  renderPage();
  fireEvent.click(await screen.findByText('onOrder.markArrived'));
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
  fireEvent.click(screen.getByText('onOrder.confirmArrived'));

  await waitFor(() => expect(screen.getByText('onOrder.arrivedNote:2')).toBeInTheDocument());
  const bulk = api.mock.calls.find(([u]) => u === '/api/bottles/bulk');
  const body = JSON.parse(bulk[1].body);
  expect(body.action).toBe('arrive');
  expect(body.bottleIds).toEqual(['b1', 'b2']);
  expect(screen.getByText(/onOrder.qty:1/)).toBeInTheDocument();
});

test('"Change month" moves the whole delivery in ONE bulk update', async () => {
  api.mockImplementation(async (url) => {
    if (url === '/api/cellars/c1/on-order') {
      return ok({ cellar: CELLAR, bottles: [ordered('b1', MARCH), ordered('b2', MARCH)], total: 2 });
    }
    if (url === '/api/bottles/bulk') return ok({ done: 2, doneIds: ['b1', 'b2'], skipped: [] });
    return ok({});
  });
  renderPage();
  fireEvent.click(await screen.findByText('onOrder.changeMonth'));
  const input = document.querySelector('input[type=month]');
  expect(input.value).toBe('2027-03');
  fireEvent.change(input, { target: { value: '2027-06' } });
  fireEvent.click(screen.getByText('onOrder.saveMonth'));

  await waitFor(() => expect(screen.getByText('onOrder.expected:June 2027')).toBeInTheDocument());
  const body = JSON.parse(api.mock.calls.find(([u]) => u === '/api/bottles/bulk')[1].body);
  expect(body).toEqual({ action: 'update', bottleIds: ['b1', 'b2'], fields: { expectedArrival: '2027-06' } });
  expect(screen.getByText(/onOrder.qty:2/)).toBeInTheDocument();
});

test('bottles another member already marked as arrived leave the list too', async () => {
  api.mockImplementation(async (url) => {
    if (url === '/api/cellars/c1/on-order') {
      return ok({ cellar: CELLAR, bottles: [ordered('b1', MARCH), ordered('b2', MARCH), ordered('b3', MARCH)], total: 3 });
    }
    if (url === '/api/bottles/bulk') return ok({ done: 1, doneIds: ['b1'], skipped: [{ id: 'b2', reason: 'not_on_order' }] });
    return ok({});
  });
  renderPage();
  fireEvent.click(await screen.findByText('onOrder.markArrived'));
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
  fireEvent.click(screen.getByText('onOrder.confirmArrived'));
  await waitFor(() => expect(screen.getByText('onOrder.arrivedNote:1')).toBeInTheDocument());
  expect(screen.getByText(/onOrder.qty:1/)).toBeInTheDocument();
});

test('a failed arrive re-reads the list (it may have been out of date)', async () => {
  let loads = 0;
  api.mockImplementation(async (url) => {
    if (url === '/api/cellars/c1/on-order') {
      loads += 1;
      return ok({ cellar: CELLAR, bottles: loads === 1 ? [ordered('b1', MARCH)] : [], total: loads === 1 ? 1 : 0 });
    }
    if (url === '/api/bottles/b1/arrive') return { ok: false, status: 409, json: async () => ({ error: 'This bottle is not on order', code: 'not_on_order' }) };
    return ok({});
  });
  renderPage();
  fireEvent.click(await screen.findByText('onOrder.markArrived'));
  fireEvent.click(screen.getByText('onOrder.confirmArrived'));
  expect(await screen.findByText('This bottle is not on order')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('onOrder.emptyTitle')).toBeInTheDocument());
  expect(loads).toBe(2);
});

test('a viewer sees the list without the arrive action', async () => {
  api.mockImplementation(async (url) => (url === '/api/cellars/c1/on-order'
    ? ok({ cellar: { ...CELLAR, userRole: 'viewer' }, bottles: [ordered('b1', null)], total: 1 })
    : ok({})));
  renderPage();
  expect(await screen.findByText('onOrder.noDate')).toBeInTheDocument();
  expect(screen.queryByText('onOrder.markArrived')).toBeNull();
});

test('nothing on order shows the empty state', async () => {
  api.mockImplementation(async () => ok({ cellar: CELLAR, bottles: [], total: 0 }));
  renderPage();
  expect(await screen.findByText('onOrder.emptyTitle')).toBeInTheDocument();
});

// "It would be good to be able to edit the quantity of bottles on order": an
// order line's own "Change quantity". More bottles copy the order; fewer move
// the most recently added to Recently deleted, with Undo.
describe('Change quantity', () => {
  const withCreated = (b, created) => ({ ...b, createdAt: created, purchaseLocation: 'Shop', purchaseDate: '2026-09-01T00:00:00.000Z', notes: 'label torn' });
  const ORDER = [
    withCreated(ordered('b1', MARCH), '2026-09-01T10:00:00Z'),
    withCreated(ordered('b2', MARCH), '2026-09-01T10:00:01Z'),
    withCreated(ordered('b3', MARCH), '2026-09-02T10:00:00Z'), // added last
  ];
  let onOrderList;
  beforeEach(() => {
    onOrderList = ORDER;
    api.mockImplementation(async (url, opts) => {
      if (url === '/api/cellars/c1/on-order') return ok({ cellar: CELLAR, bottles: onOrderList, total: onOrderList.length });
      if (url === '/api/bottles' && opts?.method === 'POST') return { ok: true, status: 201, json: async () => ({ bottle: { _id: 'new' } }) };
      if (url === '/api/bottles/bulk-delete') {
        const ids = JSON.parse(opts.body).bottleIds;
        return ok({ deleted: ids.length, deletedIds: ids, skipped: [], batchId: 'batch1' });
      }
      if (url === '/api/bottles/trash/restore') return ok({ restored: 1, skipped: [] });
      return ok({});
    });
  });
  const setQty = async (n) => {
    fireEvent.click(await screen.findByText('onOrder.changeQty'));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: String(n) } });
    fireEvent.click(screen.getByText('onOrder.saveQty'));
  };

  test('more: new bottles on order with this order\'s wine, size, price, shop and month', async () => {
    renderPage();
    await setQty(5);
    await waitFor(() => expect(api.mock.calls.filter(([u, o]) => u === '/api/bottles' && o?.method === 'POST')).toHaveLength(2));
    const body = JSON.parse(api.mock.calls.find(([u, o]) => u === '/api/bottles' && o?.method === 'POST')[1].body);
    expect(body).toMatchObject({
      cellar: 'c1', wineDefinition: 'w1', vintage: '2023', bottleSize: '750ml',
      onOrder: true, expectedArrival: '2027-03', price: 60, currency: 'EUR', purchaseLocation: 'Shop',
    });
    // The purchase is copied, not one bottle's own remarks.
    expect(body.notes).toBeUndefined();
    // The list is read again, with the new bottles in it.
    await waitFor(() => expect(api.mock.calls.filter(([u]) => u === '/api/cellars/c1/on-order').length).toBe(2));
  });

  test('fewer: the most recently added go to Recently deleted, in one request, said with Undo', async () => {
    renderPage();
    await setQty(2);
    await waitFor(() => expect(api.mock.calls.some(([u]) => u === '/api/bottles/bulk-delete')).toBe(true));
    const body = JSON.parse(api.mock.calls.find(([u]) => u === '/api/bottles/bulk-delete')[1].body);
    expect(body.bottleIds).toEqual(['b3']);
    expect(await screen.findByText(/onOrder.qty:2/)).toBeInTheDocument();
    expect(screen.getByText('common.undo')).toBeInTheDocument();
  });

  test('a blank or 0 is refused, never read as 1 (no bottles taken off by a guess)', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('onOrder.changeQty'));
    for (const v of ['', '0', '2.5']) {
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: v } });
      expect(screen.getByText('onOrder.saveQty').closest('button')).toBeDisabled();
      expect(screen.getByText('onOrder.qtyRange')).toBeInTheDocument();
    }
    expect(api.mock.calls.some(([u]) => u === '/api/bottles/bulk-delete')).toBe(false);
  });

  test('bottles that arrived meanwhile are left alone (only bottles still on order go) and the list is read again', async () => {
    api.mockImplementation(async (url, opts) => {
      if (url === '/api/cellars/c1/on-order') return ok({ cellar: CELLAR, bottles: onOrderList, total: onOrderList.length });
      if (url === '/api/bottles/bulk-delete') {
        expect(JSON.parse(opts.body).onlyOnOrder).toBe(true);
        return ok({ deleted: 1, deletedIds: ['b3'], skipped: [{ id: 'b2', reason: 'not_on_order' }], batchId: 'batch1' });
      }
      return ok({});
    });
    renderPage();
    await setQty(1);
    expect(await screen.findByText('onOrder.qtyArrivedMeanwhile')).toBeInTheDocument();
    await waitFor(() => expect(api.mock.calls.filter(([u]) => u === '/api/cellars/c1/on-order').length).toBe(2));
  });

  test('a new notice after an Undo has its own Undo again', async () => {
    renderPage();
    await setQty(2);
    fireEvent.click(await screen.findByText('common.undo'));
    await waitFor(() => expect(screen.queryByText('common.undo')).toBeNull());
    await setQty(1);
    expect(await screen.findByText('common.undo')).toBeInTheDocument();
  });

  test('a line holding two purchases: the new bottles copy the most recent one, and say so', async () => {
    onOrderList = [ORDER[0], ORDER[1], { ...ORDER[2], price: 75, purchaseLocation: 'Other shop' }];
    renderPage();
    fireEvent.click(await screen.findByText('onOrder.changeQty'));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    expect(screen.getByText('onOrder.qtyAddHintMixed')).toBeInTheDocument();
    fireEvent.click(screen.getByText('onOrder.saveQty'));
    await waitFor(() => expect(api.mock.calls.some(([u, o]) => u === '/api/bottles' && o?.method === 'POST')).toBe(true));
    const body = JSON.parse(api.mock.calls.find(([u, o]) => u === '/api/bottles' && o?.method === 'POST')[1].body);
    expect(body).toMatchObject({ price: 75, purchaseLocation: 'Other shop', onOrder: true });
  });

  test('bottles added together (same purchase, saved milliseconds apart) are one purchase, not a mix', async () => {
    onOrderList = ORDER.map((b, i) => ({ ...b, purchaseDate: `2026-09-01T10:00:0${i}.123Z` }));
    renderPage();
    fireEvent.click(await screen.findByText('onOrder.changeQty'));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    expect(screen.getByText('onOrder.qtyAddHint')).toBeInTheDocument();
    expect(screen.queryByText('onOrder.qtyAddHintMixed')).toBeNull();
  });

  test('"Mark as arrived" offers the whole order again after its size changed', async () => {
    renderPage();
    await setQty(2);
    await screen.findByText(/onOrder.qty:2/);
    fireEvent.click(screen.getByText('onOrder.markArrived'));
    expect(screen.getByRole('spinbutton')).toHaveValue(2);
  });

  test('a wine still waiting for review can only have bottles taken off', async () => {
    onOrderList = ORDER.map((b) => ({ ...b, wineDefinition: null, pendingWineRequest: { _id: 'r1', wineName: 'Unknown red' } }));
    renderPage();
    fireEvent.click(await screen.findByText('onOrder.changeQty'));
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveAttribute('max', '3');
    expect(screen.getByText('onOrder.qtyOnlyFewer')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.click(screen.getByText('onOrder.saveQty'));
    await new Promise((r) => setTimeout(r, 50));
    expect(api.mock.calls.some(([u, o]) => u === '/api/bottles' && o?.method === 'POST')).toBe(false);
  });
});

// An add on order lands here and says so, with the next one a tap away
// (newcomer walkthrough 2026-10-15).
test('bottles just added on order are announced with "Add another bottle"', async () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/cellars/c1/on-order', state: { addedNotice: { name: 'Barolo 2016', count: 3, history: false } } }]}>
      <Routes><Route path="/cellars/:id/on-order" element={<CellarOnOrder />} /></Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: /Add another bottle|bottleNotice\.addAnother/ })).toHaveAttribute('href', '/cellars/c1/add-bottle');
  expect(screen.getByRole('status')).toHaveTextContent(/bottleNotice\.added|Barolo 2016/);
});

// Release audit 2026-10-16: a retry after a raise that stopped part-way adds
// only what is still missing — also when the list could not be re-read.
test('a raise that stopped part-way, retried while the list could not be re-read, adds only the rest', async () => {
  let posts = 0;
  let offline = false;
  api.mockImplementation(async (url, opts) => {
    if (url === '/api/cellars/c1/on-order') {
      if (offline) throw new TypeError('Failed to fetch');
      return ok({ cellar: CELLAR, bottles: [ordered('b1', MARCH), ordered('b2', MARCH)], total: 2 });
    }
    if (url === '/api/bottles' && opts?.method === 'POST') {
      posts += 1;
      if (posts === 4) { offline = true; throw new TypeError('Failed to fetch'); }
      return { ok: true, status: 201, json: async () => ({ bottle: { _id: `n${posts}` } }) };
    }
    return ok({});
  });
  renderPage();
  fireEvent.click(await screen.findByText('onOrder.changeQty'));
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
  fireEvent.click(screen.getByText('onOrder.saveQty'));
  // 3 added, the 4th failed, and the list could not be read again.
  expect(await screen.findByText('onOrder.loadFailed')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('onOrder.saveQty').closest('button')).toBeEnabled());

  offline = false;
  fireEvent.click(screen.getByText('onOrder.saveQty'));
  // 2 + 3 are there: 2 more make 7 (not 5 more, which made 10).
  await waitFor(() => expect(posts).toBe(6));
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toBe(6);
});

test('a lowering that took nothing off says so (no silent no-op)', async () => {
  api.mockImplementation(async (url) => {
    if (url === '/api/cellars/c1/on-order') return ok({ cellar: CELLAR, bottles: [ordered('b1', MARCH), ordered('b2', MARCH), ordered('b3', MARCH)], total: 3 });
    if (url === '/api/bottles/bulk-delete') return ok({ deleted: 0, deletedIds: [], skipped: [{ id: 'b3', reason: 'not_found' }] });
    return ok({});
  });
  renderPage();
  fireEvent.click(await screen.findByText('onOrder.changeQty'));
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
  fireEvent.click(screen.getByText('onOrder.saveQty'));
  expect(await screen.findByText('onOrder.qtyFailed')).toBeInTheDocument();
});
