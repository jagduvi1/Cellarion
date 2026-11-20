/**
 * The bell's way to the list of curator questions: shown only while a curator
 * question (or a curator's reply) is among the notifications already loaded,
 * and read from them — the bell asks the server for nothing of its own.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const notif = vi.hoisted(() => ({ list: [] }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('../utils/timeAgo', () => ({ default: () => 'a moment ago' }));
vi.mock('../contexts/NotificationContext', () => ({
  useNotifications: () => ({ notifications: notif.list, unreadCount: 0, markRead: vi.fn(), markAllRead: vi.fn() }),
}));

const NotificationBell = (await import('./NotificationBell')).default;

const n = (id, type) => ({ _id: id, type, title: `Title ${id}`, message: 'Message', link: null, read: true, createdAt: '2026-11-01T00:00:00.000Z' });
const openBell = () => {
  const view = render(<MemoryRouter><NotificationBell /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'notificationBell.title' }));
  return view;
};

test('a curator question among the notifications: a link to every question, which closes the dropdown', () => {
  notif.list = [n('a', 'restock_alert'), n('b', 'owner_inquiry')];
  openBell();
  const link = screen.getByRole('link', { name: 'curatorQuestions.allLink' });
  expect(link).toHaveAttribute('href', '/questions');
  fireEvent.click(link);
  expect(screen.queryByText('Title a')).toBeNull();
});

test('a curator reply counts too', () => {
  notif.list = [n('c', 'owner_inquiry_resolved')];
  openBell();
  expect(screen.getByRole('link', { name: 'curatorQuestions.allLink' })).toHaveAttribute('href', '/questions');
});

// owner_inquiry_response goes to the curator who asked, not to an owner.
test('no curator question loaded: no link, and the empty bell stays as it was', () => {
  notif.list = [n('a', 'restock_alert'), n('d', 'owner_inquiry_response')];
  const { unmount } = openBell();
  expect(screen.getByText('Title d')).toBeInTheDocument();
  expect(screen.queryByRole('link')).toBeNull();
  unmount();

  notif.list = [];
  openBell();
  expect(screen.getByText('notificationBell.empty')).toBeInTheDocument();
  expect(screen.queryByRole('link')).toBeNull();
});
