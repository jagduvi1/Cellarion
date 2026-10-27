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


test('the top bar links to Search with everything in scope', () => {
  const { container } = renderLayout();
  const search = within(container.querySelector('.navbar-links')).getByRole('link', { name: 'nav.search' });
  expect(search).toHaveAttribute('href', '/bottles?status=all');
});

test('the top bar marks Search as the current page on /bottles', () => {
  const { container } = renderLayout('/bottles');
  const search = within(container.querySelector('.navbar-links')).getByRole('link', { name: 'nav.search' });
  expect(search).toHaveClass('active');
});

test("the phone's More menu has Search with everything in scope", () => {
  const { container } = renderLayout();
  fireEvent.click(screen.getByRole('button', { name: 'nav.more' }));
  const search = within(container.querySelector('.mobile-menu')).getByRole('link', { name: 'nav.search' });
  expect(search).toHaveAttribute('href', '/bottles?status=all');
});
