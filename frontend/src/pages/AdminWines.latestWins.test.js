import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// The admin wine list reloads on every search, filter, sort and page change,
// and a filter change also sends the list back to page 1 — two loads in
// flight. The table must show the latest load's wines, whichever answers last.

vi.mock('react-i18next', () => {
  const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const getWines = vi.fn();
const jsonRes = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
vi.mock('../api/admin', async (importOriginal) => ({
  ...(await importOriginal()),
  adminGetWines: (...a) => getWines(...a),
  adminGetCountries: async () => jsonRes({ countries: [] }),
  adminGetGrapes: async () => jsonRes({ grapes: [] }),
  adminGetWineProposals: async () => jsonRes({ pendingCount: 0 }),
  adminGetOwnerInquiries: async () => jsonRes({ pendingCount: 0 }),
}));

const AdminWines = (await import('./AdminWines')).default;

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const wine = (id, name, type = 'red') => ({ _id: id, name, producer: 'Example Estate', type, grapes: [] });
const listOf = (wines, { total = wines.length, pages = 1 } = {}) => jsonRes({ wines, total, pages });
const paramsOf = (call) => new URLSearchParams(String(call[1]));

beforeEach(() => { vi.clearAllMocks(); });

test('a slower load for an earlier filter does not replace the current list', async () => {
  const red = deferred();
  const white = deferred();
  getWines
    .mockResolvedValueOnce(listOf([wine('w0', 'Opening Wine')]))
    .mockReturnValueOnce(red.promise)
    .mockReturnValueOnce(white.promise);
  render(<AdminWines />);
  expect(await screen.findByText('Opening Wine')).toBeInTheDocument();

  const typeFilter = screen.getByDisplayValue('wines.allTypes');
  fireEvent.change(typeFilter, { target: { value: 'red' } });
  await waitFor(() => expect(getWines).toHaveBeenCalledTimes(2));
  fireEvent.change(typeFilter, { target: { value: 'white' } });
  await waitFor(() => expect(getWines).toHaveBeenCalledTimes(3));
  expect(paramsOf(getWines.mock.calls[2]).get('type')).toBe('white');

  await act(async () => { white.resolve(listOf([wine('w2', 'White Wine', 'white')])); });
  expect(await screen.findByText('White Wine')).toBeInTheDocument();
  await act(async () => { red.resolve(listOf([wine('w1', 'Red Wine')])); });
  expect(screen.queryByText('Red Wine')).toBeNull();
  expect(screen.getByText('White Wine')).toBeInTheDocument();
});

test('a filter change on page 2 shows page 1 of the new filter even when page 2 answers last', async () => {
  getWines
    .mockResolvedValueOnce(listOf([wine('w0', 'Page One Wine')], { total: 120, pages: 3 }))
    .mockResolvedValueOnce(listOf([wine('w5', 'Page Two Wine')], { total: 120, pages: 3 }));
  render(<AdminWines />);
  expect(await screen.findByText('Page One Wine')).toBeInTheDocument();
  fireEvent.click(screen.getByText('common.next'));
  expect(await screen.findByText('Page Two Wine')).toBeInTheDocument();

  const pageTwo = deferred();
  const pageOne = deferred();
  getWines.mockReturnValueOnce(pageTwo.promise).mockReturnValueOnce(pageOne.promise);
  fireEvent.change(screen.getByDisplayValue('wines.allTypes'), { target: { value: 'red' } });
  await waitFor(() => expect(getWines).toHaveBeenCalledTimes(4));
  expect(paramsOf(getWines.mock.calls[2]).get('page')).toBe('2');
  expect(paramsOf(getWines.mock.calls[3]).get('page')).toBe('1');

  await act(async () => { pageOne.resolve(listOf([wine('r1', 'Red Page One')], { total: 60, pages: 2 })); });
  expect(await screen.findByText('Red Page One')).toBeInTheDocument();
  await act(async () => { pageTwo.resolve(listOf([wine('r9', 'Red Page Two')], { total: 60, pages: 2 })); });
  expect(screen.queryByText('Red Page Two')).toBeNull();
  expect(screen.getByText('Red Page One')).toBeInTheDocument();
});
