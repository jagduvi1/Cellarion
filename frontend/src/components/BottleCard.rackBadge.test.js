import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The English text with its {{vars}} filled in, as the app shows it.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => (typeof fallback === 'string'
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '')
      : key),
  }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('./AuthImage', () => ({ default: ({ src, alt }) => <img src={src} alt={alt} /> }));

const BottleCard = (await import('./BottleCard')).default;

const BOTTLE = {
  _id: 'b1', status: 'active', vintage: '2013',
  wineDefinition: { _id: 'w1', name: 'Barolo Albe', producer: 'G.D. Vajra', type: 'red' },
};

// Forum request 2026-10-13: finding a bottle should not mean opening it — the
// cellar list's rack badge names the slot as well as the rack.
describe('BottleCard rack badge', () => {
  test.each(['list', 'card'])('names the rack and the slot (%s view)', (viewMode) => {
    const rackMap = new Map([['b1', { rackId: 'r1', rackName: 'Fridge', position: 12, inRoom: false }]]);
    render(<MemoryRouter><BottleCard bottle={BOTTLE} rackMap={rackMap} cellarId="c1" viewMode={viewMode} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Fridge · slot 12/ })).toBeInTheDocument();
  });

  test('a rack slot without a number shows the rack name alone', () => {
    const rackMap = new Map([['b1', { rackId: 'r1', rackName: 'Bin', position: null, inRoom: false }]]);
    render(<MemoryRouter><BottleCard bottle={BOTTLE} rackMap={rackMap} cellarId="c1" viewMode="list" /></MemoryRouter>);
    const badge = screen.getByRole('link', { name: /Bin/ });
    expect(badge.textContent).not.toMatch(/slot/);
  });
});
