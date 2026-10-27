import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ViewDetails from './ViewDetails';

// The serving line on the bottle page: the sommelier's trait (or the style's
// default) read against the phase the vintage is in today. Renders the REAL
// component — the page tests mock it away, which is how a declaration-order
// crash in it once reached a production build.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, a, b) => {
      const opts = (a && typeof a === 'object') ? a : (b || {});
      const text = {
        'serving.temperature': `Serve at ${opts.range}`,
        'serving.air.decant_long': 'decant one to two hours before serving',
        'serving.air.pour': 'open and pour',
        'serving.bySommelier': 'Set by the sommelier',
        'serving.byStyle': 'Style guideline',
      }[key];
      return text || (typeof a === 'string' ? a : key);
    },
  }),
}));
let unit = 'C';
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', roles: [], preferences: { temperatureUnit: unit } }, apiFetch: vi.fn() }) }));
vi.mock('../../api/wines', () => ({ markNotWine: vi.fn() }));
vi.mock('./WineRecordSection', () => ({ default: () => null }));
vi.mock('./ContributePrompt', () => ({ default: () => null }));
vi.mock('./DraftWineBanner', () => ({ default: () => null }));
vi.mock('./PriceHistoryTimeline', () => ({ default: () => null }));
vi.mock('./PriceTrackingToggle', () => ({ default: () => null }));
vi.mock('../CollapsibleBlock', () => ({ default: ({ children }) => <div>{children}</div> }));

const THIS_YEAR = new Date().getFullYear();

const bottle = (over = {}) => ({
  _id: 'b1',
  vintage: '2018',
  status: 'active',
  quantity: 1,
  wineDefinition: {
    _id: 'w1', name: 'Barolo Bussia', producer: 'Prunotto', type: 'red', grapes: [],
    aiProfile: { body: 'full', needsAir: 'long', description: 'Tar and roses.' },
  },
  ...over,
});

const props = (over = {}) => ({
  bottle: bottle(), rackInfo: null, cellarId: 'c1', vintageProfile: null, priceHistory: [], currentRelease: null,
  rates: {}, userCurrency: 'USD', canEdit: true, hasImage: false, onEdit: vi.fn(), onRemove: vi.fn(), onReportWine: vi.fn(),
  ...over,
});

const renderDetails = (over) => render(<MemoryRouter><ViewDetails {...props(over)} /></MemoryRouter>);

test('a young wine that needs air: the sommelier\'s temperature and "decant", from the window\'s phase today', () => {
  const vintageProfile = {
    status: 'reviewed', earlyFrom: THIS_YEAR - 2, earlyUntil: THIS_YEAR + 3, peakFrom: THIS_YEAR + 4, peakUntil: THIS_YEAR + 14,
  };
  renderDetails({ vintageProfile });
  const line = document.querySelector('.bd-serving');
  expect(line).not.toBeNull();
  expect(line.textContent).toBe('Serve at 16–18 °C; decant one to two hours before serving. (Set by the sommelier)');
});

test('with no window yet, the line shows the style\'s temperature and no guess about the wine\'s age', () => {
  renderDetails({ bottle: bottle({ wineDefinition: { _id: 'w2', name: 'Cru', type: 'red', grapes: [], aiProfile: { body: 'light' } } }) });
  expect(document.querySelector('.bd-serving').textContent).toBe('Serve at 13–15 °C. (Style guideline)');
});

test('a member who reads Fahrenheit sees the same advice in °F', () => {
  unit = 'F';
  try {
    renderDetails({ bottle: bottle({ wineDefinition: { _id: 'w4', name: 'Cru', type: 'red', grapes: [], aiProfile: { body: 'full' } } }) });
    expect(document.querySelector('.bd-serving').textContent).toBe('Serve at 61–64 °F. (Style guideline)');
  } finally {
    unit = 'C';
  }
});

test('a drink that is not wine has no serving line', () => {
  renderDetails({ bottle: bottle({ wineDefinition: { _id: 'w3', name: 'Cidre', type: null, nonWine: true, grapes: [], aiProfile: {} } }) });
  expect(document.querySelector('.bd-serving')).toBeNull();
  expect(screen.queryByText(/Serve at/)).toBeNull();
});
