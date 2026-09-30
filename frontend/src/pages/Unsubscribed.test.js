import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => {
  const t = (key) => key;
  return { useTranslation: () => ({ t }), Trans: ({ i18nKey }) => i18nKey };
});

const Unsubscribed = (await import('./Unsubscribed')).default;

const at = (url) => render(<MemoryRouter initialEntries={[url]}><Unsubscribed /></MemoryRouter>);

// The support-reply email's "stop emailing me answers" link turns off ONE
// email; the page must not tell that person they left everything (2026-09-30).
test('the support-only link says only support answers stopped', () => {
  at('/unsubscribed?only=support');
  expect(screen.getByText('unsubscribed.messageSupport')).toBeInTheDocument();
  expect(screen.queryByText('unsubscribed.message')).toBeNull();
});

test('the all-categories link keeps its message', () => {
  at('/unsubscribed');
  expect(screen.getByText('unsubscribed.message')).toBeInTheDocument();
});
