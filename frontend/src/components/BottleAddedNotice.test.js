import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

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
  renderIt({ name: 'Barolo 2019', count: 2, history: false });
  expect(screen.getByRole('status')).toHaveTextContent('bottleNotice.added:{"name":"Barolo 2019","count":2}');
  expect(screen.getByRole('link', { name: 'Add another bottle' })).toHaveAttribute('href', '/cellars/c1/add-bottle');
});

test('a bottle added straight to the history says so', () => {
  renderIt({ name: 'Barolo 2019', count: 1, history: true });
  expect(screen.getByRole('status')).toHaveTextContent('bottleNotice.addedToHistory:{"name":"Barolo 2019","count":1}');
});

test('✕ closes it', () => {
  const onDismiss = vi.fn();
  renderIt({ name: 'Barolo 2019', count: 1 }, onDismiss);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('without a wine name there is no quoted stand-in', () => {
  renderIt({ name: '', count: 3 });
  expect(screen.getByRole('status')).toHaveTextContent('bottleNotice.addedUnnamed:{"count":3}');
});

// Release audit 2026-10-16: the next bottle is added the same way, and the
// add page comes back to where the notice was.
test('"Add another bottle" carries the way back and the mode of the bottle just added', () => {
  function Where() {
    const loc = useLocation();
    return <p data-testid="where">{JSON.stringify(loc.state)}</p>;
  }
  render(
    <MemoryRouter initialEntries={['/cellars/c1/on-order']}>
      <Routes>
        <Route path="/cellars/:id/on-order" element={<BottleAddedNotice notice={{ name: 'Barolo 2019', count: 1, onOrder: true }} cellarId="c1" onDismiss={vi.fn()} />} />
        <Route path="/cellars/:id/add-bottle" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Add another bottle' }));
  expect(JSON.parse(screen.getByTestId('where').textContent)).toEqual({ cameFrom: '/cellars/c1/on-order', addMode: 'onOrder' });
});
