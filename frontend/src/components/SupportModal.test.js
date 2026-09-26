import { cloneElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SupportModal from './SupportModal';

// Support's answer is emailed as well, unless the user turned that off
// (2026-09-26). The form says so where the user gives us the reason to email
// them, and links to the setting.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, fallback) => (typeof fallback === 'string' ? fallback : k) }),
  // Renders the key, and the <settings> link with a label, so both are testable.
  Trans: ({ i18nKey, components }) => (
    <span>{i18nKey} {components?.settings ? cloneElement(components.settings, {}, 'Settings') : null}</span>
  ),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const renderModal = () => render(
  <MemoryRouter><SupportModal onClose={() => {}} /></MemoryRouter>,
);

test('says the answer will be emailed too, with a link to turn it off', () => {
  auth = { apiFetch: vi.fn(), user: { preferences: { notifications: {} } } };
  renderModal();

  expect(screen.getByText(/support\.emailNotice$/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings#preferences');
});

test('an account stored before the setting existed counts as on', () => {
  auth = { apiFetch: vi.fn(), user: { preferences: {} } };
  renderModal();
  expect(screen.getByText(/support\.emailNotice$/)).toBeInTheDocument();
});

test('with answer emails turned off, it says where the answer will be instead', () => {
  auth = { apiFetch: vi.fn(), user: { preferences: { notifications: { supportReply: { email: false } } } } };
  renderModal();

  expect(screen.getByText(/support\.emailNoticeOff/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings#preferences');
});
