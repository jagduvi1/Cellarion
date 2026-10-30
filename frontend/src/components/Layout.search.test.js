import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Layout from './Layout';

// The Search link opens the all-bottles page scoped to everything, so a wine
// that is already drunk can be found too (the page's own default is in-cellar,
// which the Statistics chart links rely on).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { username: 'ann', roles: [], plan: 'free' }, logout: vi.fn() }),
}));
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }));
vi.mock('../hooks/useUnreadBlog', () => ({ default: () => 0 }));
vi.mock('../utils/featureFlags', () => ({ useFeature: () => false }));
vi.mock('../utils/offlineQueue', () => ({ getQueueStatus: () => ({ pending: 0, attention: 0 }) }));
vi.mock('../utils/useOfflineNow', () => ({
  useOfflineNow: () => ({ offline: false, modeOn: false }),
  isOfflineCapablePage: () => true,
}));
// The bar's own widgets are not what this is about.
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('./InstallPrompt', () => ({ default: () => null }));
vi.mock('./AnnouncementBanner', () => ({ default: () => null }));
vi.mock('./DemoBanner', () => ({ default: () => null }));
vi.mock('./OfflineBanner', () => ({ default: () => null }));
vi.mock('./OfflinePageNotice', () => ({ default: () => null }));
vi.mock('./OfflinePrompt', () => ({ default: () => null }));

const renderLayout = (path = '/cellars') => render(
  <MemoryRouter initialEntries={[path]}>
    <Layout><p>page</p></Layout>
  </MemoryRouter>
);


const ARIA = 'Search all your bottles';

test('the header has a Search icon next to the bell with everything in scope', () => {
  const { container } = renderLayout();
  const search = within(container.querySelector('.navbar-right')).getByRole('link', { name: ARIA });
  expect(search).toHaveAttribute('href', '/bottles?status=all');
});

test('the desktop link row no longer carries a text Search link', () => {
  const { container } = renderLayout();
  expect(within(container.querySelector('.navbar-links')).queryByRole('link', { name: /search/i })).toBeNull();
});

test('the header Search icon is marked current on /bottles', () => {
  const { container } = renderLayout('/bottles');
  const search = within(container.querySelector('.navbar-right')).getByRole('link', { name: ARIA });
  expect(search).toHaveClass('active');
});

test('the phone bottom bar reads Cellars, Search, Statistics, Community, More', () => {
  const { container } = renderLayout();
  const bar = container.querySelector('.bottom-nav');
  const items = within(bar).getAllByRole('link').map(a => a.getAttribute('href'));
  expect(items).toEqual(['/cellars', '/bottles?status=all', '/statistics', '/community/discussions']);
  expect(within(bar).queryByRole('link', { name: 'nav.settings' })).toBeNull();
});

test('Settings leads the More menu', () => {
  const { container } = renderLayout();
  fireEvent.click(screen.getByRole('button', { name: 'nav.more' }));
  const first = container.querySelector('.mobile-menu a');
  expect(first).toHaveAttribute('href', '/settings');
});
