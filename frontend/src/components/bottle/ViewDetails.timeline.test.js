import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ViewDetails from './ViewDetails';
import { updateBottle } from '../../api/bottles';

// The drink window as a timeline is early access (flag maturityTimeline):
// with the flag on, the status moves from its own badge onto the timeline's
// marker, so the phase is no longer named twice above the table. The
// member's own window is a timeline too, whose years an editor slides on the
// bar and saves into the fields the classic edit form writes. Without one,
// whoever may edit the bottle is offered one under the sommelier's window —
// in early access the sliding editor, otherwise the edit form at its window.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const opts = (a && typeof a === 'object') ? a : ((b && typeof b === 'object') ? b : {});
    const text = typeof a === 'string' ? a : (opts.defaultValue ?? key);
    return text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ''));
  };
  return { useTranslation: () => ({ t }) };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', roles: [], preferences: {} }, apiFetch: vi.fn() }) }));
vi.mock('../../api/bottles', () => ({ updateBottle: vi.fn() }));
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

const renderDetails = (bottleOver = {}, props = {}) => render(
  <MemoryRouter>
    <ViewDetails
      bottle={{ _id: 'b1', vintage: '2018', status: 'active', quantity: 1, wineDefinition: { _id: 'w1', name: 'Barolo', type: 'red', grapes: [] }, ...bottleOver }}
      rackInfo={null} cellarId="c1" vintageProfile={vintageProfile} priceHistory={[]} currentRelease={null}
      rates={{}} userCurrency="USD" canEdit hasImage={false} onEdit={vi.fn()} onRemove={vi.fn()} onReportWine={vi.fn()}
      {...props}
    />
  </MemoryRouter>
);
const yearOf = (name) => Number(screen.getByRole('slider', { name }).getAttribute('aria-valuenow'));

afterEach(() => { timelineOn = false; vi.clearAllMocks(); });

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

test("flag on with a personal window: the sommelier's marker shows only the year, not its status", () => {
  timelineOn = true;
  renderDetails({ drinkFrom: THIS_YEAR - 1, drinkTo: THIS_YEAR + 5 });
  expect(document.querySelector('.bd-maturity-reviewed .mt-now-label').textContent).toBe(String(THIS_YEAR));
});

test('flag off: the personal window stays the badge and its years, no personal timeline', () => {
  renderDetails({ drinkFrom: THIS_YEAR - 1, drinkTo: THIS_YEAR + 5 });
  expect(screen.queryByTestId('personal-window')).toBeNull();
  const classic = document.querySelector('.bd-personal-window');
  expect(classic.querySelector('.maturity-badge--peak').textContent).toBe('bottleDetail.personalDrinkNow');
  expect(classic.textContent).toContain(`${THIS_YEAR - 1}–${THIS_YEAR + 5}`);
  expect(screen.queryByRole('button', { name: 'Set your own window' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Adjust your drink window' })).toBeNull();
});

test('flag on: the personal window is a timeline with its own status on the marker', () => {
  timelineOn = true;
  renderDetails({ drinkFrom: THIS_YEAR - 1, peakFrom: THIS_YEAR + 1, peakUntil: THIS_YEAR + 3, drinkTo: THIS_YEAR + 5 });
  expect(document.querySelector('.bd-personal-window')).toBeNull();
  const own = screen.getByTestId('personal-window');
  const label = own.querySelector('.mt-now-label');
  expect(label.textContent).toBe(`${THIS_YEAR} · bottleDetail.personalEarly`);
  expect(label.className).toContain('maturity-badge--early');
  expect(own.querySelectorAll('.mt-seg')).toHaveLength(3);
  // The sommelier's timeline below stays, without a status of its own.
  expect(document.querySelector('.bd-maturity-reviewed .mt-now-label').textContent).toBe(String(THIS_YEAR));
});

test('flag on, someone who cannot edit: the timeline without Adjust, and no offer of a window', () => {
  timelineOn = true;
  const { unmount } = renderDetails({ drinkFrom: THIS_YEAR - 1, drinkTo: THIS_YEAR + 5 }, { canEdit: false });
  expect(within(screen.getByTestId('personal-window')).getByTestId('maturity-timeline')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Adjust your drink window' })).toBeNull();
  unmount();
  renderDetails({}, { canEdit: false });
  expect(screen.queryByTestId('personal-window')).toBeNull();
});

test('Adjust: a handle moves by keyboard and stops at its neighbour; Save sends the four fields and patches the page', async () => {
  timelineOn = true;
  const stored = { drinkFrom: THIS_YEAR - 1, peakFrom: THIS_YEAR + 2, peakUntil: THIS_YEAR + 5, drinkTo: THIS_YEAR + 5 };
  updateBottle.mockResolvedValue({ ok: true, json: async () => ({ bottle: { _id: 'b1', ...stored } }) });
  const onBottleChange = vi.fn();
  renderDetails({ drinkFrom: THIS_YEAR - 1, peakFrom: THIS_YEAR + 1, peakUntil: THIS_YEAR + 3, drinkTo: THIS_YEAR + 5 }, { onBottleChange });
  fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
  const peakUntil = screen.getByRole('slider', { name: 'Peak until' });
  expect(peakUntil).toHaveAttribute('aria-valuetext', `Peak until ${THIS_YEAR + 3}`);
  fireEvent.keyDown(peakUntil, { key: 'PageUp' });
  // Five years on would pass the window's end: it stops there.
  expect(yearOf('Peak until')).toBe(THIS_YEAR + 5);
  fireEvent.keyDown(screen.getByRole('slider', { name: 'Peak from' }), { key: 'ArrowUp' });
  expect(yearOf('Peak from')).toBe(THIS_YEAR + 2);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onBottleChange).toHaveBeenCalledWith(stored));
  expect(updateBottle).toHaveBeenCalledWith(expect.anything(), 'b1', stored);
  expect(screen.queryByRole('slider')).toBeNull();
});

// The sommelier's section: the one whose heading is "Aging & maturity".
const sommSection = () => screen.getByText('bottleDetail.sommMaturity').closest('.bd-section');

test("no window yet: 'Set your own window' sits under the sommelier's timeline and starts the handles on its years", async () => {
  timelineOn = true;
  const created = { drinkFrom: THIS_YEAR - 2, peakFrom: THIS_YEAR + 2, peakUntil: THIS_YEAR + 9, drinkTo: THIS_YEAR + 9 };
  updateBottle.mockResolvedValue({ ok: true, json: async () => ({ bottle: { _id: 'b1', ...created } }) });
  const onBottleChange = vi.fn();
  renderDetails({}, { onBottleChange });
  // No "Your drink window" section holding only a link.
  expect(screen.queryByTestId('personal-window')).toBeNull();
  expect(screen.queryByText('bottleDetail.personalWindow')).toBeNull();
  const offer = within(sommSection()).getByTestId('personal-window-offer');
  // Below the sommelier's timeline, in the same section.
  const sommTimeline = within(sommSection()).getByTestId('maturity-timeline');
  expect(sommTimeline.compareDocumentPosition(offer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(within(offer).getByRole('button', { name: 'Set your own window' }));
  // The editor opens right there.
  expect(within(offer).getAllByRole('slider')).toHaveLength(4);
  // Early from THIS_YEAR - 2, peak THIS_YEAR + 2 … + 9 and no late phase: the window ends with the peak.
  expect([yearOf('Drink from'), yearOf('Peak from'), yearOf('Peak until'), yearOf('Drink until')])
    .toEqual([THIS_YEAR - 2, THIS_YEAR + 2, THIS_YEAR + 9, THIS_YEAR + 9]);
  expect(screen.queryByRole('button', { name: 'Remove my window' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onBottleChange).toHaveBeenCalledWith(created));
  expect(updateBottle).toHaveBeenCalledWith(expect.anything(), 'b1', created);
});

test('a wine the sommelier has not reviewed yet: the offer is there too, from this year to five years on', () => {
  timelineOn = true;
  renderDetails({}, { vintageProfile: { status: 'pending', vintage: '2018' } });
  const offer = within(sommSection()).getByTestId('personal-window-offer');
  fireEvent.click(within(offer).getByRole('button', { name: 'Set your own window' }));
  expect(screen.getAllByRole('slider')).toHaveLength(2);
  expect([yearOf('Drink from'), yearOf('Drink until')]).toEqual([THIS_YEAR, THIS_YEAR + 5]);
});

test('no sommelier section (an unknown vintage): the offer gets a small section of its own', () => {
  timelineOn = true;
  const { unmount } = renderDetails({ vintage: 'Unknown' });
  expect(screen.queryByText('bottleDetail.sommMaturity')).toBeNull();
  const own = screen.getByTestId('personal-window');
  expect(own).toHaveTextContent('bottleDetail.personalWindow');
  expect(within(own).getByRole('button', { name: 'Set your own window' })).toBeInTheDocument();
  unmount();

  // Classic: the same place, opening the edit form at its window.
  timelineOn = false;
  const onEdit = vi.fn();
  renderDetails({ vintage: 'Unknown' }, { onEdit });
  const classic = screen.getByText('bottleDetail.personalWindow').closest('.bd-section');
  fireEvent.click(within(classic).getByRole('button', { name: 'Set your own drink window' }));
  expect(onEdit).toHaveBeenCalledWith({ focus: 'drinkWindow' });
});

test('a window made under the sommelier\'s moves to its own section with the keyboard on Adjust; removed, the offer is back', async () => {
  timelineOn = true;
  const created = { drinkFrom: THIS_YEAR, peakFrom: null, peakUntil: null, drinkTo: THIS_YEAR + 5 };
  updateBottle.mockResolvedValue({ ok: true, json: async () => ({ bottle: { _id: 'b1', ...created } }) });
  function Page() {
    const [bottle, setBottle] = useState({ _id: 'b1', vintage: '2018', status: 'active', quantity: 1, wineDefinition: { _id: 'w1', name: 'Barolo', type: 'red', grapes: [] } });
    return (
      <MemoryRouter>
        <ViewDetails
          bottle={bottle} rackInfo={null} cellarId="c1" vintageProfile={{ status: 'pending', vintage: '2018' }} priceHistory={[]} currentRelease={null}
          rates={{}} userCurrency="USD" canEdit hasImage={false} onEdit={vi.fn()} onRemove={vi.fn()} onReportWine={vi.fn()}
          onBottleChange={(patch) => setBottle((b) => ({ ...b, ...patch }))}
        />
      </MemoryRouter>
    );
  }
  render(<Page />);
  fireEvent.click(screen.getByRole('button', { name: 'Set your own window' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const adjust = await screen.findByRole('button', { name: 'Adjust your drink window' });
  expect(within(screen.getByTestId('personal-window')).getByTestId('maturity-timeline')).toBeInTheDocument();
  expect(screen.queryByTestId('personal-window-offer')).toBeNull();
  expect(adjust).toHaveFocus();

  updateBottle.mockResolvedValue({ ok: true, json: async () => ({ bottle: { _id: 'b1', drinkFrom: null, peakFrom: null, peakUntil: null, drinkTo: null } }) });
  fireEvent.click(adjust);
  fireEvent.click(screen.getByRole('button', { name: 'Remove my window' }));
  const offer = await screen.findByTestId('personal-window-offer');
  expect(screen.queryByTestId('personal-window')).toBeNull();
  expect(within(offer).getByRole('button', { name: 'Set your own window' })).toHaveFocus();
});

test('a drink that is not wine gets no drink-window offer, in early access or not', () => {
  const notWine = { wineDefinition: { _id: 'w1', name: 'IPA', type: 'other', grapes: [], nonWine: true } };
  timelineOn = true;
  const { unmount } = renderDetails(notWine);
  expect(screen.queryByRole('button', { name: /Set your own/ })).toBeNull();
  unmount();
  timelineOn = false;
  renderDetails(notWine);
  expect(screen.queryByRole('button', { name: /Set your own/ })).toBeNull();
});

test("the offer waits for the sommelier's profile, which the handles start from", () => {
  timelineOn = true;
  const { rerender } = renderDetails({}, { vintageProfile: null });
  expect(screen.queryByRole('button', { name: 'Set your own window' })).toBeNull();
  rerender(
    <MemoryRouter>
      <ViewDetails
        bottle={{ _id: 'b1', vintage: '2018', status: 'active', quantity: 1, wineDefinition: { _id: 'w1', name: 'Barolo', type: 'red', grapes: [] } }}
        rackInfo={null} cellarId="c1" vintageProfile={vintageProfile} priceHistory={[]} currentRelease={null}
        rates={{}} userCurrency="USD" canEdit hasImage={false} onEdit={vi.fn()} onRemove={vi.fn()} onReportWine={vi.fn()}
      />
    </MemoryRouter>
  );
  expect(screen.getByRole('button', { name: 'Set your own window' })).toBeInTheDocument();
});

describe('classic (no early access)', () => {
  test("no window yet: an editor gets 'Set your own drink window' under the sommelier's window, opening the edit form there", () => {
    const onEdit = vi.fn();
    renderDetails({}, { onEdit });
    const section = sommSection();
    const link = within(section).getByRole('button', { name: 'Set your own drink window' });
    expect(section.querySelector('.bd-maturity-table').compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No section of its own while the sommelier's is there.
    expect(screen.queryByText('bottleDetail.personalWindow')).toBeNull();
    fireEvent.click(link);
    expect(onEdit).toHaveBeenCalledWith({ focus: 'drinkWindow' });
  });

  test('a window of their own: "Change" in its block opens the edit form at the window', () => {
    const onEdit = vi.fn();
    renderDetails({ drinkFrom: THIS_YEAR - 1, drinkTo: THIS_YEAR + 5 }, { onEdit });
    const block = document.querySelector('.bd-personal-window');
    fireEvent.click(within(block).getByRole('button', { name: 'Change your drink window' }));
    expect(onEdit).toHaveBeenCalledWith({ focus: 'drinkWindow' });
    expect(screen.queryByRole('button', { name: 'Set your own drink window' })).toBeNull();
  });

  test('someone who cannot edit the bottle gets neither link', () => {
    const { unmount } = renderDetails({}, { canEdit: false });
    expect(screen.queryByRole('button', { name: 'Set your own drink window' })).toBeNull();
    unmount();
    renderDetails({ drinkFrom: THIS_YEAR - 1, drinkTo: THIS_YEAR + 5 }, { canEdit: false });
    expect(document.querySelector('.bd-personal-window')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Change your drink window' })).toBeNull();
  });
});
