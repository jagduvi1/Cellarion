import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ViewDetails from './ViewDetails';

// The drink window as a timeline is early access (flag maturityTimeline):
// with the flag on, the status moves from its own badge onto the timeline's
// marker, so the phase is no longer named twice above the table.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, a) => (typeof a === 'string' ? a : key) }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', roles: [], preferences: {} }, apiFetch: vi.fn() }) }));
let timelineOn = false;
vi.mock('../../utils/featureFlags', () => ({ useFeature: (key) => key === 'maturityTimeline' && timelineOn }));
vi.mock('../BetaBadge', () => ({ default: ({ feature }) => <div data-testid="beta-badge">{feature}</div> }));
vi.mock('../../api/wines', () => ({ markNotWine: vi.fn() }));
vi.mock('./WineRecordSection', () => ({ default: () => null }));
vi.mock('./ContributePrompt', () => ({ default: () => null }));
vi.mock('./DraftWineBanner', () => ({ default: () => null }));
vi.mock('./PriceHistoryTimeline', () => ({ default: () => null }));
vi.mock('./PriceTrackingToggle', () => ({ default: () => null }));
vi.mock('../CollapsibleBlock', () => ({ default: ({ children }) => <div>{children}</div> }));

const THIS_YEAR = new Date().getFullYear();
const vintageProfile = {
  status: 'reviewed', vintage: '2018',
  earlyFrom: THIS_YEAR - 2, earlyUntil: THIS_YEAR + 1, peakFrom: THIS_YEAR + 2, peakUntil: THIS_YEAR + 9,
};

const renderDetails = (bottleOver = {}) => render(
  <MemoryRouter>
    <ViewDetails
      bottle={{ _id: 'b1', vintage: '2018', status: 'active', quantity: 1, wineDefinition: { _id: 'w1', name: 'Barolo', type: 'red', grapes: [] }, ...bottleOver }}
      rackInfo={null} cellarId="c1" vintageProfile={vintageProfile} priceHistory={[]} currentRelease={null}
      rates={{}} userCurrency="USD" canEdit hasImage={false} onEdit={vi.fn()} onRemove={vi.fn()} onReportWine={vi.fn()}
    />
  </MemoryRouter>
);

afterEach(() => { timelineOn = false; });

test('flag off: the status badge above the phase table, no timeline', () => {
  renderDetails();
  expect(document.querySelector('.bd-maturity-reviewed > .maturity-badge--early')).not.toBeNull();
  expect(screen.queryByTestId('maturity-timeline')).toBeNull();
  expect(screen.queryByTestId('beta-badge')).toBeNull();
  expect(document.querySelector('.bd-maturity-table')).not.toBeNull();
});

test('flag on: the timeline carries the status, the badge of its own is gone, the table folds into the details', () => {
  timelineOn = true;
  renderDetails();
  expect(screen.getByTestId('maturity-timeline')).toBeInTheDocument();
  expect(screen.getByTestId('beta-badge')).toHaveTextContent('maturityTimeline');
  expect(document.querySelector('.bd-maturity-reviewed > .maturity-badge')).toBeNull();
  expect(document.querySelector('.mt-now-label').className).toContain('maturity-badge--early');
  const table = document.querySelector('.mt-details .bd-maturity-table');
  expect(table).not.toBeNull();
  expect(table).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
  expect(table).toBeVisible();
});

test('flag on with a personal window: the marker shows only the year, not the sommelier\'s status', () => {
  timelineOn = true;
  renderDetails({ drinkFrom: THIS_YEAR - 1, drinkTo: THIS_YEAR + 5 });
  expect(document.querySelector('.mt-now-label').textContent).toBe(String(THIS_YEAR));
});
