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

describe('BottleCard long-press (post-ship audit 2026-09-03)', () => {
  test('a long press enters select mode, and the next tap is not swallowed when no click followed the press', () => {
    vi.useFakeTimers();
    try {
      const onLongPress = vi.fn();
      const onToggleSelect = vi.fn();
      const props = { bottle: BOTTLE, rackMap: new Map(), cellarId: 'c1', viewMode: 'list', onLongPress };
      const { rerender } = render(<MemoryRouter><BottleCard {...props} /></MemoryRouter>);
      const card = screen.getByText('Barolo Albe').closest('[role="button"]');

      fireEvent.pointerDown(card, { clientX: 10, clientY: 10, pointerType: 'touch', button: 0 });
      vi.advanceTimersByTime(600);
      expect(onLongPress).toHaveBeenCalledTimes(1);
      fireEvent.pointerUp(card); // on touch no click follows a long press

      // The parent enters select mode with this card ticked.
      rerender(<MemoryRouter><BottleCard {...props} selectable selected onToggleSelect={onToggleSelect} /></MemoryRouter>);
      fireEvent.pointerDown(card, { clientX: 10, clientY: 10, pointerType: 'touch', button: 0 });
      fireEvent.pointerUp(card);
      fireEvent.click(card);
      expect(onToggleSelect).toHaveBeenCalledTimes(1); // not eaten by a stale swallow flag
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Which photo a card shows (support ticket 2026-09-05, discussion #1227): the
 * owner's chosen default, else the owner's OWN photo — pending or approved —
 * else the registry image. Approval used to make a card go blank because the
 * own-photo lookup dropped approved rows and the card preferred the registry
 * image, which most wines do not have.
 */
describe('BottleCard image precedence', () => {
  const WITH_REGISTRY_IMAGE = {
    ...BOTTLE,
    wineDefinition: { ...BOTTLE.wineDefinition, image: '/api/uploads/processed/registry.png', imageCredit: 'someone else' },
  };

  test("the owner's own photo beats the registry image and carries no credit line", () => {
    const { container } = renderCard({ bottle: { ...WITH_REGISTRY_IMAGE, pendingImageUrl: '/api/uploads/processed/mine.png' } });
    expect(container.querySelector('img').getAttribute('src')).toBe('/api/uploads/processed/mine.png');
    expect(screen.queryByText('someone else')).not.toBeInTheDocument();
  });

  test('a chosen default beats both', () => {
    const { container } = renderCard({ bottle: { ...WITH_REGISTRY_IMAGE, pendingImageUrl: '/api/uploads/processed/mine.png', defaultImageUrl: '/api/uploads/processed/default.png' } });
    expect(container.querySelector('img').getAttribute('src')).toBe('/api/uploads/processed/default.png');
  });

  test('with no own photo the registry image shows, with its credit', () => {
    const { container } = renderCard({ bottle: WITH_REGISTRY_IMAGE });
    expect(container.querySelector('img').getAttribute('src')).toBe('/api/uploads/processed/registry.png');
    expect(screen.getByText('someone else')).toBeInTheDocument();
  });

  test('no photo at all renders no image', () => {
    const { container } = renderCard();
    expect(container.querySelector('img')).toBeNull();
  });
});

/** A private draft wine (2026-09-12) is marked on the card in both views. */
describe('BottleCard private-draft badge', () => {
  test('a draft wine shows the badge in list and grid view; an ordinary wine does not', () => {
    const draftBottle = { ...BOTTLE, wineDefinition: { ...BOTTLE.wineDefinition, draft: true } };
    const { unmount } = renderCard({ bottle: draftBottle });
    expect(screen.getByText('bottleCard.draftWine')).toBeInTheDocument();
    unmount();
    const grid = renderCard({ bottle: draftBottle, viewMode: 'grid' });
    expect(screen.getByText('bottleCard.draftWine')).toBeInTheDocument();
    grid.unmount();
    renderCard();
    expect(screen.queryByText('bottleCard.draftWine')).not.toBeInTheDocument();
  });
});

/**
 * Support ticket 2026-10-09: a stacked card gets two direct actions. "Info"
 * opens the vintage page and "Drink one" takes a single bottle out without
 * expanding the group first; the card's own click still expands. Hidden in
 * select mode, where a tap means "toggle" and nothing else.
 */
describe('BottleCard stacked card actions', () => {
  test('Info and Drink one call their handlers without expanding the group, in both views', () => {
    for (const viewMode of ['list', 'card']) {
      const onClick = vi.fn();
      const onInfo = vi.fn();
      const onDrinkOne = vi.fn();
      const { unmount } = renderCard({ viewMode, groupCount: 4, onClick, onInfo, onDrinkOne });
      fireEvent.click(screen.getByText('bottleCard.groupInfo'));
      fireEvent.click(screen.getByText('bottleCard.groupDrinkOne'));
      expect(onInfo).toHaveBeenCalledTimes(1);
      expect(onDrinkOne).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('Barolo Albe'));
      expect(onClick).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  test('the caller decides: no handlers, no actions; select mode hides them', () => {
    const { unmount: u1 } = renderCard({});
    expect(screen.queryByText('bottleCard.groupDrinkOne')).toBeNull();
    u1();
    const { unmount } = renderCard({ groupCount: 3, onClick: vi.fn() });
    expect(screen.queryByText('bottleCard.groupDrinkOne')).toBeNull();
    unmount();
    renderCard({ groupCount: 3, onClick: vi.fn(), onInfo: vi.fn(), onDrinkOne: vi.fn(), selectable: true, onToggleSelect: vi.fn() });
    expect(screen.queryByText('bottleCard.groupInfo')).toBeNull();
    expect(screen.queryByText('bottleCard.groupDrinkOne')).toBeNull();
  });

  test('only Info when the caller cannot consume (a viewer of a shared cellar)', () => {
    renderCard({ groupCount: 2, onClick: vi.fn(), onInfo: vi.fn() });
    expect(screen.getByText('bottleCard.groupInfo')).toBeInTheDocument();
    expect(screen.queryByText('bottleCard.groupDrinkOne')).toBeNull();
  });
});

/**
 * Early access, one page per wine and vintage: a tap on any entry opens the
 * vintage page, and "Drink one" sits on every card — the last bottle of a
 * vintage looks and behaves like the ones before it. The stack still expands
 * from the ⊕ in select mode, through its own handler.
 */
describe('BottleCard with one page per wine and vintage (early access)', () => {
  test('a single bottle carries Drink one too, compact and named for screen readers; the card itself opens the page', () => {
    const onClick = vi.fn(); // navigate to the vintage page
    const onDrinkOne = vi.fn();
    const { container } = renderCard({ onClick, onDrinkOne, actionsInline: true });
    const drink = screen.getByRole('button', { name: 'bottleCard.drinkOneAria' });
    expect(container.querySelector('.bottle-group-actions--inline')).not.toBeNull();
    fireEvent.click(drink);
    expect(onDrinkOne).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Barolo Albe'));
    expect(onClick).toHaveBeenCalledTimes(1);
    // A tap opens a page, so the card shows ›, like a single bottle.
    expect(container.querySelector('.bottle-chevron').textContent).toBe('›');
  });

  test('a stack whose tap opens the page shows ›, and in select mode its ⊕ expands through onExpand', () => {
    const onClick = vi.fn();
    const onExpand = vi.fn();
    const { container, unmount } = renderCard({ groupCount: 3, onClick, onExpand, onDrinkOne: vi.fn(), actionsInline: true });
    expect(container.querySelector('.bottle-chevron').textContent).toBe('›');
    unmount();

    const onToggleSelect = vi.fn();
    renderCard({ groupCount: 3, onClick, onExpand, selectable: true, onToggleSelect });
    fireEvent.click(screen.getByLabelText('bottleCard.expandGroup'));
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });
});

/**
 * Photos per vintage (support ticket 2026-10-09): a public photo of this
 * wine AND vintage shows before the wine's generic registry image, which may
 * be another year's label — but never before the owner's own photo.
 */
describe('BottleCard same-vintage photo', () => {
  const WITH_BOTH = {
    ...BOTTLE,
    wineDefinition: { ...BOTTLE.wineDefinition, image: '/api/uploads/processed/registry.png', imageCredit: 'registry credit' },
    vintageImageUrl: '/api/uploads/processed/vintage-2013.webp', vintageImageCredit: 'Anna',
  };

  test('beats the registry image, with its own credit', () => {
    const { container } = renderCard({ bottle: WITH_BOTH });
    expect(container.querySelector('img').getAttribute('src')).toBe('/api/uploads/processed/vintage-2013.webp');
    expect(screen.getByText('Anna')).toBeInTheDocument();
    expect(screen.queryByText('registry credit')).toBeNull();
  });

  test('yields to the owner\'s own photo', () => {
    const { container } = renderCard({ bottle: { ...WITH_BOTH, pendingImageUrl: '/api/uploads/processed/mine.png' } });
    expect(container.querySelector('img').getAttribute('src')).toBe('/api/uploads/processed/mine.png');
    expect(screen.queryByText('Anna')).toBeNull();
  });

  // Johan, 2026-10-09: "a new vintage without an image should display the
  // wine's image … so we always show an image". The owner's photo of ANOTHER
  // vintage never beats the wine's image; it only stands in when there is none.
  test('a photo of another vintage loses to the wine\'s image, and fills in only when the wine has none', () => {
    const other = '/api/uploads/processed/mine-2015.webp';
    const { container, unmount } = renderCard({ bottle: {
      ...BOTTLE,
      wineDefinition: { ...BOTTLE.wineDefinition, image: '/api/uploads/processed/registry.png', imageCredit: 'registry credit' },
      otherVintageImageUrl: other,
    } });
    expect(container.querySelector('img').getAttribute('src')).toBe('/api/uploads/processed/registry.png');
    expect(screen.getByText('registry credit')).toBeInTheDocument();
    unmount();

    const second = renderCard({ bottle: { ...BOTTLE, otherVintageImageUrl: other } });
    expect(second.container.querySelector('img').getAttribute('src')).toBe(other);
    expect(screen.queryByText('registry credit')).toBeNull();
  });
});
