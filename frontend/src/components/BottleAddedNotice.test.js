import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// After a save the cellar page says what was added and offers the next one
// (newcomer walkthrough 2026-10-15).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, a) => (a && typeof a === 'object' ? `${key}:${JSON.stringify(a)}` : (typeof a === 'string' ? a : key)) }),
}));
const { default: BottleAddedNotice } = await import('./BottleAddedNotice');

const renderIt = (notice, onDismiss = vi.fn()) => render(
  <MemoryRouter><BottleAddedNotice notice={notice} cellarId="c1" onDismiss={onDismiss} /></MemoryRouter>,
);

test('says what was added, with the count, and leads to the add page for the next one', () => {
  renderIt({ name: 'Barolo 2019', count: 2, history: false, at: 1 });
  expect(screen.getByRole('status')).toHaveTextContent('bottleNotice.added:{"name":"Barolo 2019","count":2}');
  expect(screen.getByRole('link', { name: 'Add another bottle' })).toHaveAttribute('href', '/cellars/c1/add-bottle');
});

test('a bottle added straight to the history says so', () => {
  renderIt({ name: 'Barolo 2019', count: 1, history: true, at: 1 });
  expect(screen.getByRole('status')).toHaveTextContent('bottleNotice.addedToHistory:{"name":"Barolo 2019","count":1}');
});

test('✕ closes it', () => {
  const onDismiss = vi.fn();
  renderIt({ name: 'Barolo 2019', count: 1, at: 1 }, onDismiss);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
