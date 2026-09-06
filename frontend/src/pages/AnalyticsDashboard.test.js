import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsDashboard from './AnalyticsDashboard';

// The analytics table moved here from the cellar page (support ticket
// 2026-09-05). These tests pin the tab contract: ?view=table opens the Table
// tab, ?cellar=<id> preselects that cellar's scope, and the boards stay the
// default so the nav link still lands on the pages people just look at.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fb) => (typeof fb === 'string' ? fb : key) }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: vi.fn() }) }));
vi.mock('../components/AnalyticsCharts', () => ({ default: () => null }));
vi.mock('../components/AnalyticsTable', () => ({
  default: ({ cellarId }) => <div data-testid="analytics-table">scope:{cellarId || 'all'}</div>,
}));

const jsonRes = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
vi.mock('../api/analytics', () => ({
  listDashboards: vi.fn(async () => jsonRes({ dashboards: [] })),
  createDashboard: vi.fn(), updateDashboard: vi.fn(), deleteDashboard: vi.fn(),
  runAnalyticsQuery: vi.fn(async () => jsonRes({ mode: 'grouped', buckets: [], measureLabels: [], scope: { bottles: 'active' } })),
}));

const CELLAR = 'a'.repeat(24);
const renderAt = (url) => render(
  <MemoryRouter initialEntries={[url]}><AnalyticsDashboard /></MemoryRouter>
);

test('opens on the Boards tab with the default widgets', async () => {
  renderAt('/dashboard');
  expect(screen.getByRole('tab', { name: 'Boards' })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByText('My cellar')).toBeInTheDocument();
  expect(screen.queryByTestId('analytics-table')).toBeNull();
});

test('?view=table&cellar=<id> opens the table with that cellar preselected', async () => {
  renderAt(`/dashboard?view=table&cellar=${CELLAR}`);
  expect(screen.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByTestId('analytics-table')).toHaveTextContent(`scope:${CELLAR}`);
  expect(screen.queryByText('My cellar')).toBeNull();
});

test('a malformed cellar parameter is dropped rather than sent as a scope', async () => {
  renderAt('/dashboard?view=table&cellar=%3Cscript%3E');
  expect(await screen.findByTestId('analytics-table')).toHaveTextContent('scope:all');
});

test('the tabs switch both ways', async () => {
  renderAt(`/dashboard?view=table&cellar=${CELLAR}`);
  await screen.findByTestId('analytics-table');
  fireEvent.click(screen.getByRole('tab', { name: 'Boards' }));
  expect(await screen.findByText('My cellar')).toBeInTheDocument();
  expect(screen.queryByTestId('analytics-table')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
  // Leaving the table forgot the cellar: the table now opens on all cellars.
  expect(await screen.findByTestId('analytics-table')).toHaveTextContent('scope:all');
});
