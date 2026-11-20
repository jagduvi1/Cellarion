import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Statistics from './Statistics';

// The Statistics page's ways into the maturity section: the health card's
// phase counts take the reader to the Maturity Status card (scrolled into view,
// focus on its heading), and with two or more cellars a "by cellar" table sits
// right after that card.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o && typeof o === 'object' && o.count != null ? `${k}:${o.count}` : k) }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
// The map and the value chart are not under test and pull in heavy chart code.
vi.mock('../components/charts/WorldMapChart', () => ({ default: () => null }));
vi.mock('../components/ValueOverTimeChart', () => ({ default: () => null }));

const bands = () => ({ '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 });
const view = () => ({ byRating: bands(), avg: null, count: 0 });
const phases = (o) => ({ declining: 0, late: 0, peak: 0, early: 0, notReady: 0, noProfile: 0, ...o });

const statsWith = (cellarBreakdown) => ({
  overview: {
    totalBottles: 20, totalConsumed: 0, uniqueWines: 12, totalCellars: cellarBreakdown.length,
    totalCountries: 2, totalGrapes: 3, totalValue: 0, currency: 'EUR', avgPrice: 0,
    avgRating: null, avgConsumedRating: null, targetRatingScale: '5',
    oldestVintage: null, newestVintage: null, avgVintageAge: null,
    bottlesDrunk: 0, bottlesGifted: 0, bottlesSold: 0,
    healthScore: 72, healthGrade: 'B', regretIndex: 25,
  },
  byType: { red: 20 }, byCountry: [], byRegion: [], byGrape: [], byVintage: [], byRating: bands(),
  ratingViews: { all: view(), cellar: view(), history: view() },
  byBottleSize: {}, byPurchaseYear: [],
  maturity: phases({ declining: 4, late: 2, peak: 6, early: 3, notReady: 1, noProfile: 4 }),
  maturityCoverage: { sommSet: 16, none: 4 },
  topValueBottles: [], consumptionByYear: [], consumptionByReason: { drank: 0, gifted: 0, sold: 0, other: 0 },
  cellarBreakdown,
  maturityForecast: [], urgencyLadder: [], holdingTime: [], joyPerDollar: [],
  regretSignal: { surprises: [], disappointments: [], avgDelta: null, count: 0 },
  pace: { avgIntakePerYear: 0, avgOutputPerYear: 0, netPerYear: 0, runway: null },
  topProducers: [],
});

const HOUSE = { id: 'cA', name: 'House', bottleCount: 10, value: 0, uniqueWines: 6, maturity: phases({ peak: 6, early: 3, noProfile: 1 }), regretIndex: 0 };
const STORE = { id: 'cB', name: 'Storage unit', bottleCount: 10, value: 0, uniqueWines: 6, maturity: phases({ declining: 4, late: 2, notReady: 1, noProfile: 3 }), regretIndex: 57 };

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
}

const renderPage = async (cellars) => {
  auth = { apiFetch: vi.fn(async (url) => (url === '/api/stats/overview' ? ok({ stats: statsWith(cellars) }) : ok({}))) };
  render(
    <MemoryRouter initialEntries={['/statistics']}>
      <Routes>
        <Route path="/statistics" element={<Statistics />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByRole('heading', { name: 'statistics.title' });
};

const maturityHeading = () => screen.getByRole('heading', { name: 'statistics.sections.maturityStatus' });
const scoreCardControl = () => screen.getByRole('button', { name: /statistics\.maturity\.goToSection/ });

let scrollIntoView;
beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  delete Element.prototype.scrollIntoView;
  vi.unstubAllGlobals();
});

test("the score card's maturity counts are a focusable control that moves to the Maturity Status section", async () => {
  await renderPage([STORE, HOUSE]);
  const control = scoreCardControl();
  control.focus();
  expect(control).toHaveFocus();

  fireEvent.click(control);

  const heading = maturityHeading();
  expect(heading).toHaveFocus();
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView.mock.contexts[0]).toBe(heading.closest('.stats-card'));
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
});

test('with reduced motion asked for, the move to the section is instant', async () => {
  vi.stubGlobal('matchMedia', vi.fn((query) => ({ matches: query.includes('prefers-reduced-motion: reduce'), media: query })));
  await renderPage([STORE, HOUSE]);
  fireEvent.click(scoreCardControl());
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  expect(maturityHeading()).toHaveFocus();
});

test('the by-cellar table follows the Maturity Status card with two cellars, and is absent with one', async () => {
  await renderPage([STORE, HOUSE]);
  const table = screen.getByRole('heading', { name: /statistics\.sections\.maturityByCellar/ }).closest('.stats-card');
  expect(maturityHeading().closest('.stats-card').nextElementSibling).toBe(table);
  expect(within(table).getByRole('link', { name: 'Storage unit' })).toHaveAttribute('href', '/cellars/cB');
});

test('one cellar: no by-cellar table', async () => {
  await renderPage([HOUSE]);
  expect(screen.queryByRole('heading', { name: /statistics\.sections\.maturityByCellar/ })).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});

test("a Maturity Status segment still opens every owned cellar's bottles in that phase", async () => {
  await renderPage([STORE, HOUSE]);
  const card = maturityHeading().closest('.stats-card');
  // The bar's segment (its legend row opens the same list).
  fireEvent.click(within(card).getByRole('button', { name: 'statistics.maturityPhases.peak: 6' }));
  expect(screen.getByTestId('where')).toHaveTextContent('/cellars/cB?maturity=peak&scope=owned');
});
