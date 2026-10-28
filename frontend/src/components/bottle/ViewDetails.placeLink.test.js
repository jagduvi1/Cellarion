import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ViewDetails from './ViewDetails';

// An unplaced bottle offers "Place in a rack" on its own page (support ticket
// 2026-10-26: placing was reachable only from the rack page). The link opens
// the rack page in the add flow's placing mode with this one bottle queued.
// Renders the REAL component, like ViewDetails.serving.test.js.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, a) => (typeof a === 'string' ? a : key),
  }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', roles: [], preferences: {} }, apiFetch: vi.fn() }) }));
vi.mock('../../api/wines', () => ({ markNotWine: vi.fn() }));
vi.mock('./WineRecordSection', () => ({ default: () => null }));
vi.mock('./ContributePrompt', () => ({ default: () => null }));
vi.mock('./DraftWineBanner', () => ({ default: () => null }));
vi.mock('./PriceHistoryTimeline', () => ({ default: () => null }));
vi.mock('./PriceTrackingToggle', () => ({ default: () => null }));
vi.mock('../CollapsibleBlock', () => ({ default: ({ children }) => <div>{children}</div> }));

const bottle = (over = {}) => ({
  _id: 'b1',
  vintage: '2018',
  status: 'active',
  quantity: 1,
  wineDefinition: { _id: 'w1', name: 'Barolo Bussia', producer: 'Prunotto', type: 'red', grapes: [], aiProfile: {} },
  ...over,
});

const props = (over = {}) => ({
  bottle: bottle(), rackInfo: null, cellarHasRacks: true, cellarId: 'c1', vintageProfile: null, priceHistory: [], currentRelease: null,
  rates: {}, userCurrency: 'USD', canEdit: true, hasImage: false, onEdit: vi.fn(), onRemove: vi.fn(), onReportWine: vi.fn(),
  ...over,
});

// The rack page's stand-in: shows the router state the link handed over.
function RacksProbe() {
  const { state } = useLocation();
  return <pre data-testid="racks-state">{JSON.stringify(state)}</pre>;
}

const renderDetails = (over) => render(
  <MemoryRouter initialEntries={['/bottle']}>
    <Routes>
      <Route path="/bottle" element={<ViewDetails {...props(over)} />} />
      <Route path="/cellars/c1/racks" element={<RacksProbe />} />
    </Routes>
  </MemoryRouter>,
);

test('an unplaced bottle in a cellar with racks links to the rack page with itself as the placing queue', () => {
  renderDetails();
  const link = screen.getByRole('link', { name: /Not in a rack yet · Place in a rack/ });
  expect(link).toHaveAttribute('href', '/cellars/c1/racks');
  fireEvent.click(link);
  expect(screen.getByTestId('racks-state').textContent).toBe('{"placeQueue":["b1"],"placeFrom":"bottle"}');
});

test('a placed bottle shows its slot instead; no racks, no edit right or an order on its way shows nothing', () => {
  const { unmount } = renderDetails({ rackInfo: { rackId: 'r1', rackName: 'Wine Fridge', position: 7, inRoom: false } });
  expect(screen.queryByText(/Place in a rack/)).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Wine Fridge/ })).toBeInTheDocument();
  unmount();

  for (const over of [{ cellarHasRacks: false }, { canEdit: false }, { bottle: bottle({ status: 'ordered' }) }]) {
    const r = renderDetails(over);
    expect(screen.queryByText(/Place in a rack/)).not.toBeInTheDocument();
    r.unmount();
  }
});
