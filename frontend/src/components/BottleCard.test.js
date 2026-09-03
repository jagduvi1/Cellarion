import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('./AuthImage', () => ({ default: ({ src, alt }) => <img src={src} alt={alt} /> }));

const BottleCard = (await import('./BottleCard')).default;

const BOTTLE = {
  _id: 'b1', status: 'active', vintage: '2013',
  wineDefinition: { _id: 'w1', name: 'Barolo Albe', producer: 'G.D. Vajra', type: 'red' },
};

const renderCard = (props = {}) => render(
  <MemoryRouter>
    <BottleCard bottle={BOTTLE} rackMap={new Map()} cellarId="c1" viewMode="list" {...props} />
  </MemoryRouter>,
);

/**
 * A stacked card (several identical bottles) in select mode: a tap toggles the
 * whole group, and the ⊕ is a real button that expands it instead — the only
 * way to pick one bottle out of five (Johan, 2026-09-03, from the phone).
 */
describe('BottleCard stacked card in select mode', () => {
  test('a tap toggles the selection; the expand button opens the group without touching it', () => {
    const onToggleSelect = vi.fn();
    const onClick = vi.fn(); // the parent's toggleGroup
    renderCard({ groupCount: 5, onClick, selectable: true, selected: false, onToggleSelect });

    fireEvent.click(screen.getByText('Barolo Albe'));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();

    const expand = screen.getByLabelText('bottleCard.expandGroup');
    fireEvent.click(expand);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledTimes(1); // unchanged — the click did not bubble into the card

    fireEvent.keyDown(expand, { key: 'Enter' });
    expect(onToggleSelect).toHaveBeenCalledTimes(1); // keyboard on the button never reaches the card
  });

  test('outside select mode the whole card still expands the group, with no extra button', () => {
    const onClick = vi.fn();
    renderCard({ groupCount: 5, onClick });
    expect(screen.queryByLabelText('bottleCard.expandGroup')).toBeNull();
    fireEvent.click(screen.getByText('Barolo Albe'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a single bottle in select mode has no expand button', () => {
    renderCard({ selectable: true, onToggleSelect: vi.fn() });
    expect(screen.queryByLabelText('bottleCard.expandGroup')).toBeNull();
  });

  test('the grid view offers the same expand button on a stacked card', () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    renderCard({ viewMode: 'card', groupCount: 3, onClick, selectable: true, onToggleSelect });
    fireEvent.click(screen.getByLabelText('bottleCard.expandGroup'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
  });
});
