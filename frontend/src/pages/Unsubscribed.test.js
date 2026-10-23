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

// 2026-10-20: the owner-question email's "stop emailing me questions" link
// turns off ONE email too.
test('the owner-questions link says only curator questions stopped', () => {
  at('/unsubscribed?only=owner-questions');
  expect(screen.getByText('unsubscribed.messageOwnerQuestions')).toBeInTheDocument();
  expect(screen.queryByText('unsubscribed.message')).toBeNull();
});

// The drink-window email (on by default for new accounts) has its own stop
// link too; the page must say only those emails stopped.
test('the drink-window link says only drink-window emails stopped', () => {
  at('/unsubscribed?only=drink-window');
  expect(screen.getByText('unsubscribed.messageDrinkWindow')).toBeInTheDocument();
  expect(screen.queryByText('unsubscribed.message')).toBeNull();
});

test('an unknown only= value falls back to the all-categories message', () => {
  at('/unsubscribed?only=whatever');
  expect(screen.getByText('unsubscribed.message')).toBeInTheDocument();
});

test('the all-categories link keeps its message', () => {
  at('/unsubscribed');
  expect(screen.getByText('unsubscribed.message')).toBeInTheDocument();
});
