import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import UrgencyLadder from './UrgencyLadder';
import TopValueList from './TopValueList';
import CellarBreakdownViz from './CellarBreakdownViz';

/**
 * Analytics deep links (forum request, turbulent3964 2026-08-29): the three
 * lists that name a specific record link to it, so "Drink These Now" answers
 * "where is it and what does it look like" in one click.
 *
 * The id is optional in every payload — a client running against an older
 * server, or a bottle whose _id was dropped, must still render as plain text
 * rather than producing a link to /bottles/undefined.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, opts) => (opts && opts.count != null ? `${k}:${opts.count}` : k), i18n: { language: 'en' } }),
}));

const renderRouted = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('UrgencyLadder — Drink These Now', () => {
  const bottle = (over = {}) => ({
    id: 'b1', cellarId: 'c7', name: 'Barolo Riserva', producer: 'Vietti', vintage: 2016,
    type: 'red', status: 'declining', daysRemaining: -10, price: 60, ...over,
  });

  test('links each row to its bottle', () => {
    renderRouted(<UrgencyLadder bottles={[bottle()]} currency="EUR" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/cellars/c7/bottles/b1');
    expect(link).toHaveTextContent('Barolo Riserva');
    expect(link).toHaveTextContent('Vietti');
  });

  test('a row without an id renders as text, never a link to undefined', () => {
    const { container } = renderRouted(
      <UrgencyLadder bottles={[bottle({ id: undefined })]} currency="EUR" />
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.innerHTML).not.toContain('undefined');
    expect(screen.getByText('Barolo Riserva')).toBeInTheDocument();
  });

  // Regression: the first cut linked to /bottles/:id, which is NOT a route —
  // a bottle lives at /cellars/:cellarId/bottles/:bottleId, so an id-only row
  // must stay text rather than produce a 404 link.
  test('a bottle id without a cellar id does not become a link', () => {
    const { container } = renderRouted(
      <UrgencyLadder bottles={[bottle({ cellarId: undefined })]} currency="EUR" />
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.innerHTML).not.toContain('undefined');
    expect(screen.getByText('Barolo Riserva')).toBeInTheDocument();
  });

  test('mixed payload links only the rows that can be linked', () => {
    renderRouted(
      <UrgencyLadder bottles={[bottle(), bottle({ id: undefined, name: 'Unlinkable' })]} currency="EUR" />
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/cellars/c7/bottles/b1');
    expect(screen.getByText('Unlinkable')).toBeInTheDocument();
  });
});

describe('TopValueList — Most Valuable Bottles', () => {
  test('links each row to its bottle, and degrades without an id', () => {
    const { rerender } = renderRouted(
      <TopValueList bottles={[{ id: 'b9', cellarId: 'c3', name: 'Hillside Select', producer: 'Shafer', vintage: 2016, type: 'red', price: 400 }]} currency="USD" />
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/cellars/c3/bottles/b9');

    rerender(
      <MemoryRouter>
        <TopValueList bottles={[{ name: 'Hillside Select', producer: 'Shafer', vintage: 2016, type: 'red', price: 400 }]} currency="USD" />
      </MemoryRouter>
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Hillside Select')).toBeInTheDocument();
  });
});

describe('CellarBreakdownViz', () => {
  const cellar = (over = {}) => ({ id: 'c1', name: 'Main Cellar', bottleCount: 40, value: 900, uniqueWines: 30, ...over });

  test('links the cellar name to the cellar', () => {
    renderRouted(<CellarBreakdownViz cellars={[cellar()]} currency="EUR" />);
    const link = screen.getByRole('link', { name: 'Main Cellar' });
    expect(link).toHaveAttribute('href', '/cellars/c1');
  });

  test('only the name is a link — the bar stays a measurement', () => {
    renderRouted(<CellarBreakdownViz cellars={[cellar()]} currency="EUR" />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  test('a cellar without an id renders as text', () => {
    const { container } = renderRouted(<CellarBreakdownViz cellars={[cellar({ id: undefined })]} currency="EUR" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.innerHTML).not.toContain('undefined');
  });
});
