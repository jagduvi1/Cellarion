import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import AdminWineReports from './AdminWineReports';

// Switching the status tab (or the page) while a list is still loading leaves
// two loads in flight. The list must show the latest one's reports, whichever
// answers last.

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const getReports = vi.fn();
vi.mock('../api/admin', () => ({
  adminGetWineReports: (...a) => getReports(...a),
  adminResolveWineReport: vi.fn(),
  adminDismissWineReport: vi.fn(),
}));

const jsonRes = (body) => ({ ok: true, json: () => Promise.resolve(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const report = (id, name, status) => ({
  _id: id, reason: 'wrong_info', status, createdAt: '2026-10-01T00:00:00.000Z',
  wineDefinition: { name }, user: { username: 'member' },
});

beforeEach(() => { vi.clearAllMocks(); });

test('a slower load for the previous tab does not replace the current tab\'s list', async () => {
  const pending = deferred();
  const resolved = deferred();
  getReports.mockReturnValueOnce(pending.promise).mockReturnValueOnce(resolved.promise);
  render(<AdminWineReports />);
  await waitFor(() => expect(getReports).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
  await waitFor(() => expect(getReports).toHaveBeenCalledTimes(2));
  expect(getReports.mock.calls[1][1]).toContain('status=resolved');

  await act(async () => { resolved.resolve(jsonRes({ reports: [report('r2', 'Resolved Wine', 'resolved')], total: 1 })); });
  expect(await screen.findByText('Resolved Wine')).toBeInTheDocument();

  await act(async () => { pending.resolve(jsonRes({ reports: [report('r1', 'Pending Wine', 'pending'), report('r3', 'Other Pending Wine', 'pending')], total: 2 })); });
  expect(screen.queryByText('Pending Wine')).toBeNull();
  expect(screen.getByText('Resolved Wine')).toBeInTheDocument();
  expect(screen.getByText('1 report')).toBeInTheDocument();
});

test('the list keeps loading until the current tab\'s load answers', async () => {
  const pending = deferred();
  const resolved = deferred();
  getReports.mockReturnValueOnce(pending.promise).mockReturnValueOnce(resolved.promise);
  render(<AdminWineReports />);
  await waitFor(() => expect(getReports).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
  await waitFor(() => expect(getReports).toHaveBeenCalledTimes(2));

  await act(async () => { pending.resolve(jsonRes({ reports: [report('r1', 'Pending Wine', 'pending')], total: 1 })); });
  expect(screen.queryByText('Pending Wine')).toBeNull();
  expect(screen.getByText('Loading…')).toBeInTheDocument();

  await act(async () => { resolved.resolve(jsonRes({ reports: [report('r2', 'Resolved Wine', 'resolved')], total: 1 })); });
  expect(await screen.findByText('Resolved Wine')).toBeInTheDocument();
  expect(screen.queryByText('Loading…')).toBeNull();
});
