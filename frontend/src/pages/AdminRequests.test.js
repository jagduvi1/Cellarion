import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AdminRequests from './AdminRequests';

// Audit 2026-08-03 H5: the admin wine-request queue sent no page/limit params
// and dropped the server's `total`, so anything beyond the oldest 50 requests
// per status was permanently unreachable through the UI. These tests pin the
// pagination contract: page/limit are sent, the total is shown, the filter
// resets to page 1, and a page that fell off the end snaps back.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && opts.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const getWineRequests = vi.fn();
vi.mock('../api/admin', () => ({
  adminGetWineRequests: (...a) => getWineRequests(...a),
  adminResolveWineRequest: vi.fn(),
  adminRejectWineRequest: vi.fn(),
  adminGetCountries: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ countries: [] }) }),
  adminGetGrapes: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ grapes: [] }) }),
  adminGetRegions: vi.fn(),
  adminGetAppellations: vi.fn(),
}));

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  getAiWineInfo: vi.fn(),
}));

const jsonRes = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

const makeRequests = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    _id: `req-${offset + i}`,
    wineName: `Wine ${offset + i}`,
    status: 'pending',
    user: { username: 'user1' },
    createdAt: '2026-08-01T00:00:00.000Z',
  }));

beforeEach(() => {
  vi.clearAllMocks();
});

test('requests page 1 with the backend limit and shows the true total', async () => {
  getWineRequests.mockResolvedValue(jsonRes({ count: 50, total: 137, requests: makeRequests(50) }));
  render(<AdminRequests />);

  await waitFor(() => expect(screen.getByText('Wine 0')).toBeInTheDocument());
  expect(getWineRequests).toHaveBeenCalledWith(apiFetch, '?page=1&limit=50&status=pending');
  // Total count is on screen (previously dropped entirely).
  expect(screen.getByText('admin.requests.totalCount:137')).toBeInTheDocument();
});

test('Next fetches page 2; rows beyond the first 50 become reachable', async () => {
  getWineRequests.mockImplementation((_af, params) =>
    Promise.resolve(
      params.includes('page=2')
        ? jsonRes({ count: 50, total: 137, requests: makeRequests(50, 50) })
        : jsonRes({ count: 50, total: 137, requests: makeRequests(50) })
    )
  );
  render(<AdminRequests />);
  await waitFor(() => expect(screen.getByText('Wine 0')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'common.next' }));

  await waitFor(() => expect(screen.getByText('Wine 50')).toBeInTheDocument());
  expect(getWineRequests).toHaveBeenLastCalledWith(apiFetch, '?page=2&limit=50&status=pending');
  // Previous is now enabled, Next still enabled (3 pages of 137).
  expect(screen.getByRole('button', { name: 'common.previous' })).not.toBeDisabled();
});

test('hides the pager when everything fits on one page', async () => {
  getWineRequests.mockResolvedValue(jsonRes({ count: 3, total: 3, requests: makeRequests(3) }));
  render(<AdminRequests />);
  await waitFor(() => expect(screen.getByText('Wine 0')).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'common.next' })).toBeNull();
});

test('changing the status filter resets to page 1', async () => {
  getWineRequests.mockResolvedValue(jsonRes({ count: 50, total: 120, requests: makeRequests(50) }));
  render(<AdminRequests />);
  await waitFor(() => expect(screen.getByText('Wine 0')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'common.next' }));
  await waitFor(() =>
    expect(getWineRequests).toHaveBeenLastCalledWith(apiFetch, '?page=2&limit=50&status=pending')
  );

  fireEvent.click(screen.getByRole('button', { name: 'resolved' }));
  await waitFor(() =>
    expect(getWineRequests).toHaveBeenLastCalledWith(apiFetch, '?page=1&limit=50&status=resolved')
  );
});

test('snaps back to the last page when the current page falls off the end', async () => {
  // Page 1 shows 120 pending. By the time the admin clicks Next the queue has
  // been cleared down to 30 — the page-2 fetch comes back empty with the new
  // total, and the component must snap back to (and refetch) page 1 instead of
  // stranding the admin on an empty page.
  getWineRequests.mockImplementation((_af, params) =>
    Promise.resolve(
      params.includes('page=2')
        ? jsonRes({ count: 0, total: 30, requests: [] })
        : jsonRes({ count: 30, total: 30, requests: makeRequests(30) })
    )
  );
  getWineRequests.mockResolvedValueOnce(jsonRes({ count: 50, total: 120, requests: makeRequests(50) }));

  render(<AdminRequests />);
  await waitFor(() => expect(screen.getByText('Wine 0')).toBeInTheDocument());
  expect(screen.getByText('admin.requests.totalCount:120')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'common.next' }));

  // Page 2 overshot (totalPages is now 1) → automatic refetch of page 1.
  await waitFor(() =>
    expect(getWineRequests).toHaveBeenLastCalledWith(apiFetch, '?page=1&limit=50&status=pending')
  );
  await waitFor(() => expect(screen.getByText('admin.requests.totalCount:30')).toBeInTheDocument());
  expect(screen.getByText('Wine 0')).toBeInTheDocument();
});
