import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WineRequests from './WineRequests';

// #1460: a request may carry up to three links and a back-label photo. The
// list shows every link, and the form sends the links in the user's order
// with the back label beside the front photo.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, dv) => (typeof dv === 'string' ? dv : key) }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));
// The camera component needs media APIs jsdom lacks; the form's own inputs
// are what these tests exercise.
vi.mock('../components/PhotoCapture', () => ({ default: () => <div data-testid="photo-capture" /> }));

const jsonRes = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });

beforeEach(() => { vi.clearAllMocks(); });

test('every link of a request is listed', async () => {
  apiFetch.mockImplementation(() => jsonRes({ requests: [{
    _id: 'r1', wineName: 'Salmos', status: 'pending', createdAt: '2026-10-09T00:00:00.000Z',
    sourceUrl: 'https://winery.example/s', sourceUrls: ['https://winery.example/s', 'https://review.example/s'],
  }] }));
  render(<WineRequests />);
  expect(await screen.findByRole('link', { name: 'https://review.example/s' })).toHaveAttribute('href', 'https://review.example/s');
  expect(screen.getByRole('link', { name: 'https://winery.example/s' })).toBeInTheDocument();
});

test('an older request that knows one link still lists it', async () => {
  apiFetch.mockImplementation(() => jsonRes({ requests: [{
    _id: 'r1', wineName: 'Salmos', status: 'resolved', createdAt: '2026-10-09T00:00:00.000Z', sourceUrl: 'https://winery.example/s',
  }] }));
  render(<WineRequests />);
  expect(await screen.findByRole('link', { name: 'https://winery.example/s' })).toBeInTheDocument();
});

test('a second link and the back label travel in the request, the first link as sourceUrl', async () => {
  apiFetch.mockImplementation((url, opts) => (opts && opts.method === 'POST' ? jsonRes({ wineRequest: {} }) : jsonRes({ requests: [] })));
  render(<WineRequests />);
  fireEvent.click(await screen.findByText('+ wineRequests.newRequest'));

  fireEvent.change(screen.getByPlaceholderText('wineRequests.wineNamePlaceholder'), { target: { value: 'Salmos 2019' } });
  fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: 'https://winery.example/s' } });
  fireEvent.click(screen.getByText('+ Add another link'));
  const linkInputs = screen.getAllByPlaceholderText('https://...');
  expect(linkInputs).toHaveLength(2);
  fireEvent.change(linkInputs[1], { target: { value: 'https://review.example/s' } });
  const imageInputs = screen.getAllByPlaceholderText('Paste image URL…');
  expect(imageInputs).toHaveLength(2); // front, back
  fireEvent.change(imageInputs[1], { target: { value: 'https://cdn.example.com/back.png' } });

  fireEvent.click(screen.getByText('wineRequests.submitRequest'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/wine-requests', expect.objectContaining({ method: 'POST' })));
  const sent = JSON.parse(apiFetch.mock.calls.find((c) => c[1] && c[1].method === 'POST')[1].body);
  expect(sent).toMatchObject({
    wineName: 'Salmos 2019',
    sourceUrl: 'https://winery.example/s',
    sourceUrls: ['https://winery.example/s', 'https://review.example/s'],
    image: null,
    backImage: 'https://cdn.example.com/back.png',
  });
});

test('no more than three links can be added', async () => {
  apiFetch.mockImplementation(() => jsonRes({ requests: [] }));
  render(<WineRequests />);
  fireEvent.click(await screen.findByText('+ wineRequests.newRequest'));
  fireEvent.click(screen.getByText('+ Add another link'));
  fireEvent.click(screen.getByText('+ Add another link'));
  expect(screen.queryByText('+ Add another link')).toBeNull();
  expect(screen.getAllByPlaceholderText('https://...')).toHaveLength(3);
  fireEvent.click(screen.getAllByText('Remove')[0]);
  expect(screen.getAllByPlaceholderText('https://...')).toHaveLength(2);
  expect(screen.getByText('+ Add another link')).toBeInTheDocument();
});
