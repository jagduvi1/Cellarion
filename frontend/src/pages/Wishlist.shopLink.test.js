import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// A wishlist entry can carry the shop page the member saw the wine on. The
// list shows it as a link labelled by its site (only an http(s) address is
// ever a link), and the edit dialog sets or clears it.

vi.mock('react-i18next', () => ({
  // An error code has a translation; everything else reads as its key.
  useTranslation: () => ({ t: (k, o) => (k.startsWith('errors.codes.') ? `translated:${k}` : o && o.host ? `${k}:${o.host}` : k) }),
  Trans: ({ i18nKey }) => <span>{i18nKey}</span>,
}));
vi.mock('../components/WineImage', () => ({ default: () => null }));
vi.mock('../components/AddToCellarButton', () => ({ default: () => null }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const item = (id, over = {}) => ({
  _id: id, status: 'wanted', priority: 'medium',
  wineDefinition: { _id: `w-${id}`, name: `Wine ${id}`, producer: 'P', type: 'red' },
  ...over,
});
let items;
const api = vi.fn(async (url, opts) => {
  if (url.startsWith('/api/wishlist?')) return ok({ items, total: items.length });
  if (opts?.method === 'PUT') return ok({ item: { ...items[0], ...JSON.parse(opts.body) } });
  return ok({});
});

const { default: Wishlist } = await import('./Wishlist');
const renderPage = () => render(<MemoryRouter><Wishlist /></MemoryRouter>);
const itemOf = (name) => screen.getByText(name).closest('.wishlist-item');

beforeEach(() => {
  api.mockClear();
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} } };
  items = [
    item('i1', { shopUrl: 'https://www.shop.example/wine/123' }),
    item('i2'),
    item('i3', { shopUrl: 'javascript:alert(1)' }),
  ];
});

test('an entry with a shop link shows it, labelled by its site, opening in a new tab', async () => {
  renderPage();
  await screen.findByText('Wine i1');

  const link = within(itemOf('Wine i1')).getByRole('link', { name: 'wishlist.shopLinkAt:shop.example' });
  expect(link).toHaveAttribute('href', 'https://www.shop.example/wine/123');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('no link without a shop link, and never one for an address that is not http(s)', async () => {
  renderPage();
  await screen.findByText('Wine i2');

  expect(within(itemOf('Wine i2')).queryByRole('link')).toBeNull();
  expect(within(itemOf('Wine i3')).queryByRole('link')).toBeNull();
});

test('the edit dialog sends the shop link with the other fields', async () => {
  renderPage();
  await screen.findByText('Wine i1');

  fireEvent.click(within(itemOf('Wine i1')).getByTitle('wishlist.edit'));
  const field = screen.getByLabelText('wishlist.shopUrl');
  expect(field).toHaveValue('https://www.shop.example/wine/123');
  fireEvent.change(field, { target: { value: '  shop.example/other  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'wishlist.save' }));

  await waitFor(() => expect(api.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true));
  const [url, opts] = api.mock.calls.find(([, o]) => o?.method === 'PUT');
  expect(url).toBe('/api/wishlist/i1');
  expect(JSON.parse(opts.body)).toMatchObject({ shopUrl: 'shop.example/other' });
});

test('a refused shop link shows the translated reason from its code', async () => {
  api.mockImplementation(async (url, opts) => {
    if (url.startsWith('/api/wishlist?')) return ok({ items, total: items.length });
    if (opts?.method === 'PUT') {
      return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: 'The shop link must be a web address (http:// or https://)', code: 'wishlist_shop_url_invalid' }) };
    }
    return ok({});
  });
  renderPage();
  await screen.findByText('Wine i1');

  fireEvent.click(within(itemOf('Wine i1')).getByTitle('wishlist.edit'));
  fireEvent.change(screen.getByLabelText('wishlist.shopUrl'), { target: { value: 'ftp://shop.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'wishlist.save' }));

  expect(await screen.findByText('translated:errors.codes.wishlist_shop_url_invalid')).toBeInTheDocument();
});
