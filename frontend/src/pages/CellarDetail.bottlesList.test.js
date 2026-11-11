import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The cellar page's bottle list: the row of view buttons, the select-mode
// bar and the cards themselves, in the list view and the card view. Its
// markup, and what it hands each card, is pinned here as snapshots, so that
// moving the list to a file of its own can be shown to change nothing: the
// snapshots must come out the same, without an update.
//
// What the list DOES is pinned elsewhere (the notice after a drink, keeping
// one's place, the sort, the filter counts); this file is only about what it
// renders.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
// Early access: off, as for most members, unless a test turns it on.
let earlyAccess = false;
vi.mock('../utils/featureFlags', () => ({ useFeature: () => earlyAccess }));
// A card is a component of its own. Here it shows what the list handed it
// (every prop by name, a plain value by its value), and two buttons that call
// the handlers a test needs: tick the card, and unfold a stack.
vi.mock('../components/BottleCard', () => ({
  default: ({ bottle, onToggleSelect, onExpand, ...props }) => {
    const handed = { ...props, onToggleSelect, onExpand };
    const shown = Object.keys(handed).sort()
      .filter((k) => handed[k] !== undefined)
      .map((k) => {
        const v = handed[k];
        if (typeof v === 'function') return `${k}()`;
        if (v && typeof v === 'object') return `${k}{}`;
        return `${k}=${v}`;
      });
    return (
      <div data-card={bottle._id}>
        <p>{shown.join(' ')}</p>
        <button type="button" onClick={onToggleSelect}>{`tick-${bottle._id}`}</button>
        {onExpand && <button type="button" onClick={onExpand}>{`unfold-${bottle._id}`}</button>}
      </div>
    );
  },
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner', bottleCount: 5 };
const bottle = (id, wine) => ({ _id: id, status: 'active', vintage: '2019', cellar: 'c1', wineDefinition: wine });
// A stack of two identical bottles, a single bottle, and one still waiting
// for its wine to be added to the registry.
const ITEMS = [
  { key: 'w1::2019::750ml', count: 2, bottles: [bottle('b1', { _id: 'w1', name: 'Barolo' }), bottle('b2', { _id: 'w1', name: 'Barolo' })] },
  { key: 'w2::2019::750ml', count: 1, bottles: [bottle('b3', { _id: 'w2', name: 'Chablis' })] },
  { key: 'none:b4::2019::750ml', count: 1, bottles: [{ ...bottle('b4', null), pendingWineRequest: { wineName: 'Cuvée Exemple' } }] },
];

const memoryStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
};

let api;
beforeEach(() => {
  earlyAccess = false;
  api = vi.fn(async (url) => {
    // Five bottles in the cellar, four loaded: there is more to load.
    if (url.startsWith('/api/cellars/c1?')) {
      return ok({ cellar: CELLAR, bottles: { items: ITEMS, total: 5 }, facets: {}, baseFacets: {}, facetMeta: {} });
    }
    if (url === '/api/cellars') return ok({ cellars: [CELLAR] });
    if (url.startsWith('/api/racks')) return ok({ racks: [] });
    if (url.startsWith('/api/climate/')) return ok({ devices: [] });
    return ok({});
  });
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} }, updatePreferences: vi.fn(async () => ({ success: true })) };
});
afterEach(() => vi.unstubAllGlobals());

const { default: CellarDetail } = await import('./CellarDetail');
const renderList = async () => {
  const { container } = render(
    <MemoryRouter initialEntries={['/cellars/c1']}>
      <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'tick-b1' });
  // The racks have answered (none), so nothing about the cards is still to come.
  await waitFor(() => expect(api.mock.calls.some(([u]) => u.startsWith('/api/racks'))).toBe(true));
  const part = (selector) => container.querySelector(selector);
  return {
    toolbar: () => part('.bottles-view-toggle'),
    bulkBar: () => part('.bulk-bar'),
    cards: () => part('.bottles-list, .bottles-grid'),
    loadMore: () => part('.load-more-wrap'),
  };
};

describe('the list view, as the page opens', () => {
  test('the view buttons, the cards and "load more"', async () => {
    const list = await renderList();

    expect(list.toolbar()).toMatchSnapshot('view buttons');
    expect(list.cards()).toMatchSnapshot('cards');
    expect(list.loadMore()).toMatchSnapshot('load more');
    expect(list.bulkBar()).toBeNull();
  });

  test('"Show on cards" opens its menu of details', async () => {
    const list = await renderList();
    fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.cardFields' }));

    expect(list.toolbar()).toMatchSnapshot();
  });

  test('a stack unfolded: its bar, then each of its bottles', async () => {
    const list = await renderList();
    fireEvent.click(screen.getByRole('button', { name: 'unfold-b1' }));

    expect(list.cards()).toMatchSnapshot();
  });
});

describe('the card view', () => {
  test('the view buttons lose the two list-only ones, and the cards are told', async () => {
    const list = await renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Card view' }));

    expect(list.toolbar()).toMatchSnapshot('view buttons');
    expect(list.cards()).toMatchSnapshot('cards');
  });
});

describe('select mode', () => {
  const enterSelectMode = async () => {
    const list = await renderList();
    fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.selectBottles' }));
    return list;
  };

  test('nothing ticked: the bar counts none and its actions wait', async () => {
    const list = await enterSelectMode();

    expect(list.bulkBar()).toMatchSnapshot('bar');
    expect(list.cards()).toMatchSnapshot('cards');
  });

  test('a stack ticked: both its bottles count, and the actions are ready', async () => {
    const list = await enterSelectMode();
    fireEvent.click(screen.getByRole('button', { name: 'tick-b1' }));

    expect(list.bulkBar()).toMatchSnapshot('bar');
    expect(list.cards()).toMatchSnapshot('cards');
  });

  test('with early access on, the bar offers the action still in early access', async () => {
    earlyAccess = true;
    const list = await enterSelectMode();

    expect(list.bulkBar()).toMatchSnapshot();
  });
});
