import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Layout from './Layout';

// Help was linked only from the Connect-your-AI page, so nobody found it
// (usability plan, Step 6). It now sits beside Support in the top bar and in
// the phone's More menu.

// The inline English default, else the key.
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

test('the top bar links to Help right after Support', () => {
  const { container } = renderLayout();
  const help = within(container.querySelector('.navbar-links')).getByRole('link', { name: 'Help' });
  expect(help).toHaveAttribute('href', '/help');
  expect(help.previousElementSibling).toHaveAttribute('href', '/support');
});

test('the top bar marks Help as the current page on /help', () => {
  const { container } = renderLayout('/help');
  const help = within(container.querySelector('.navbar-links')).getByRole('link', { name: 'Help' });
  expect(help).toHaveClass('active');
});

test("the phone's More menu has Help after Support, and following it closes the menu", () => {
  const { container } = renderLayout();
  expect(container.querySelector('.mobile-menu')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'nav.more' }));
  const menu = container.querySelector('.mobile-menu');
  const help = within(menu).getByRole('link', { name: 'Help' });
  expect(help).toHaveAttribute('href', '/help');
  expect(help.previousElementSibling).toHaveAttribute('href', '/support');

  fireEvent.click(help);
  expect(container.querySelector('.mobile-menu')).toBeNull();
});
