import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// "Your drink window" in early access: the member's own window as a timeline,
// and an editor that slides its four boundaries in whole years on the same
// bar, saving the four fields the classic edit form writes.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const opts = (a && typeof a === 'object') ? a : ((b && typeof b === 'object') ? b : {});
    const text = typeof a === 'string' ? a : (opts.defaultValue ?? key);
    return text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ''));
  };
  return { useTranslation: () => ({ t }) };
});
const { apiFetch } = vi.hoisted(() => ({ apiFetch: () => {} }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch, user: { id: 'u1' } }) }));
vi.mock('../../api/bottles', () => ({ updateBottle: vi.fn() }));
vi.mock('../BetaBadge', () => ({ default: ({ feature }) => <div data-testid="beta-badge">{feature}</div> }));

const { updateBottle } = await import('../../api/bottles');
const { default: PersonalWindowTimeline, startingWindow, editorAxis, personalPhaseLabels } = await import('./PersonalWindowTimeline');
const { handleLimits, middleThird } = await import('./DrinkWindowEditor');
const { getMaturityPhases } = await import('../../utils/maturityUtils');
const { getPersonalWindowStatus } = await import('../../utils/drinkStatus');

const Y = 2026;
const labels = personalPhaseLabels((k, d) => (typeof d === 'string' ? d : k));
const okRes = (body) => ({ ok: true, json: async () => body });
const slider = (name) => screen.getByRole('slider', { name });
const yearOf = (name) => Number(slider(name).getAttribute('aria-valuenow'));

const renderWindow = (bottleOver = {}, props = {}) => {
  const bottle = { _id: 'b1', vintage: '2018', ...bottleOver };
  return render(
    <PersonalWindowTimeline
      bottle={bottle}
      personalWindow={getPersonalWindowStatus(bottle, Y)}
      canEdit
      year={Y}
      {...props}
    />
  );
};

beforeEach(() => { vi.clearAllMocks(); });

describe('startingWindow', () => {
  test('the member\'s own window as stored, its peak kept', () => {
    const pw = getPersonalWindowStatus({ drinkFrom: 2024, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 }, Y);
    expect(startingWindow(pw, [], labels, Y)).toEqual({ drinkFrom: 2024, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 });
  });

  test('open ends start where the bar draws them: no start → this year, no end → where it fades out', () => {
    const onlyTo = getPersonalWindowStatus({ drinkTo: 2030 }, Y);
    expect(startingWindow(onlyTo, [], labels, Y)).toEqual({ drinkFrom: Y, peakFrom: null, peakUntil: null, drinkTo: 2030 });
    const onlyFrom = getPersonalWindowStatus({ drinkFrom: 2024 }, Y);
    expect(startingWindow(onlyFrom, [], labels, Y)).toEqual({ drinkFrom: 2024, peakFrom: null, peakUntil: null, drinkTo: Y + 3 });
  });

  test('no window of one\'s own: the sommelier\'s early start, peak and late end', () => {
    const profile = { status: 'reviewed', vintage: '2018', earlyFrom: 2022, earlyUntil: 2025, peakFrom: 2026, peakUntil: 2032, lateFrom: 2033, lateUntil: 2038 };
    const somm = getMaturityPhases(profile, labels);
    expect(startingWindow(null, somm, labels, Y)).toEqual({ drinkFrom: 2022, peakFrom: 2026, peakUntil: 2032, drinkTo: 2038 });
  });

  test('a sommelier window that is all peak gives a window without one', () => {
    const somm = getMaturityPhases({ status: 'reviewed', vintage: '2018', peakFrom: 2024, peakUntil: 2030 }, labels);
    expect(startingWindow(null, somm, labels, Y)).toEqual({ drinkFrom: 2024, peakFrom: null, peakUntil: null, drinkTo: 2030 });
  });

  test('nothing to start from: this year and the five after it', () => {
    expect(startingWindow(null, [], labels, Y)).toEqual({ drinkFrom: Y, peakFrom: null, peakUntil: null, drinkTo: Y + 5 });
  });
});

describe('editorAxis', () => {
  test('from the year before the vintage to five past the latest of the end, the sommelier\'s and ten years on', () => {
    expect(editorAxis({ drinkFrom: 2024, drinkTo: 2030 }, { vintageYear: 2018, sommLastYear: 2040, year: Y })).toEqual({ lo: 2017, hi: 2045 });
    expect(editorAxis({ drinkFrom: 2024, drinkTo: 2030 }, { vintageYear: NaN, sommLastYear: null, year: Y })).toEqual({ lo: 2023, hi: Y + 15 });
  });

  test('an old vintage pulls the bar back ten years at most', () => {
    expect(editorAxis({ drinkFrom: 2020, drinkTo: 2030 }, { vintageYear: 1961, sommLastYear: null, year: Y }).lo).toBe(2009);
  });

  test('never past the years the server accepts', () => {
    expect(editorAxis({ drinkFrom: 1900, drinkTo: 2195 }, { vintageYear: 1900, year: Y })).toEqual({ lo: 1900, hi: 2200 });
  });
});

describe('handle limits and a new peak', () => {
  const axis = { lo: 2017, hi: 2045 };
  test('each handle stops at its neighbours, the window\'s ends at the axis', () => {
    const w = { drinkFrom: 2024, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 };
    expect(handleLimits(w, 'drinkFrom', axis)).toEqual([2017, 2027]);
    expect(handleLimits(w, 'peakFrom', axis)).toEqual([2024, 2030]);
    expect(handleLimits(w, 'peakUntil', axis)).toEqual([2027, 2035]);
    expect(handleLimits(w, 'drinkTo', axis)).toEqual([2030, 2045]);
    const noPeak = { drinkFrom: 2024, peakFrom: null, peakUntil: null, drinkTo: 2035 };
    expect(handleLimits(noPeak, 'drinkFrom', axis)).toEqual([2017, 2035]);
    expect(handleLimits(noPeak, 'drinkTo', axis)).toEqual([2024, 2045]);
  });

  test('a new peak is the middle third of the window', () => {
    expect(middleThird(2024, 2035)).toEqual({ peakFrom: 2028, peakUntil: 2031 });
    expect(middleThird(2024, 2026)).toEqual({ peakFrom: 2025, peakUntil: 2025 });
    expect(middleThird(2024, 2025)).toEqual({ peakFrom: 2024, peakUntil: 2025 });
  });
});

describe('PersonalWindowTimeline', () => {
  test('the window as a timeline, the personal status on the marker', () => {
    renderWindow({ drinkFrom: 2024, peakFrom: 2028, peakUntil: 2030, drinkTo: 2035 });
    expect(screen.getByTestId('maturity-timeline')).toBeInTheDocument();
    const label = document.querySelector('.mt-now-label');
    expect(label.textContent).toBe(`${Y} · bottleDetail.personalEarly`);
    expect(label.className).toContain('maturity-badge--early');
    expect([...document.querySelectorAll('.mt-seg')].map((s) => s.className)).toEqual(['mt-seg mt-seg--early', 'mt-seg mt-seg--peak', 'mt-seg mt-seg--late']);
    expect(screen.getByRole('button', { name: 'Adjust your drink window' })).toHaveTextContent('Adjust');
  });

  test('without a peak: one segment, named as drinking, with "drink now" on the marker', () => {
    renderWindow({ drinkFrom: 2024, drinkTo: 2030 });
    expect(document.querySelectorAll('.mt-seg')).toHaveLength(1);
    expect(document.querySelector('.mt-legend').textContent).toBe('Ready to drink');
    expect(document.querySelector('.mt-now-label').textContent).toBe(`${Y} · bottleDetail.personalDrinkNow`);
  });

  test('a viewer who cannot edit sees the timeline, no Adjust; without a window, nothing', () => {
    const { unmount } = renderWindow({ drinkFrom: 2024, drinkTo: 2030 }, { canEdit: false });
    expect(screen.getByTestId('maturity-timeline')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    const { container } = renderWindow({}, { canEdit: false, sommReviewed: true });
    expect(container).toBeEmptyDOMElement();
  });

  test('Adjust opens the handles on the window\'s years, the first one focused', () => {
    renderWindow({ drinkFrom: 2024, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    expect(screen.getAllByRole('slider')).toHaveLength(4);
    expect(slider('Drink from')).toHaveFocus();
    expect(slider('Peak from')).toHaveAttribute('aria-valuetext', 'Peak from 2027');
    expect([yearOf('Drink from'), yearOf('Peak from'), yearOf('Peak until'), yearOf('Drink until')]).toEqual([2024, 2027, 2030, 2035]);
    expect(slider('Peak until')).toHaveAttribute('aria-valuemin', '2027');
    expect(slider('Peak until')).toHaveAttribute('aria-valuemax', '2035');
    expect(screen.getByTestId('beta-badge')).toHaveTextContent('maturityTimeline');
  });

  test('the keyboard moves a handle a year, five with Page keys, to its limits with Home/End, never past a neighbour', () => {
    renderWindow({ drinkFrom: 2024, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    const peakFrom = slider('Peak from');
    fireEvent.keyDown(peakFrom, { key: 'ArrowRight' });
    expect(yearOf('Peak from')).toBe(2028);
    fireEvent.keyDown(peakFrom, { key: 'ArrowDown' });
    fireEvent.keyDown(peakFrom, { key: 'ArrowLeft' });
    expect(yearOf('Peak from')).toBe(2026);
    fireEvent.keyDown(peakFrom, { key: 'PageUp' });
    // Stops at peak until (2030), not 2031.
    expect(yearOf('Peak from')).toBe(2030);
    fireEvent.keyDown(peakFrom, { key: 'Home' });
    expect(yearOf('Peak from')).toBe(2024);
    fireEvent.keyDown(slider('Drink from'), { key: 'ArrowRight' });
    expect(yearOf('Drink from')).toBe(2024);
    fireEvent.keyDown(slider('Drink until'), { key: 'End' });
    expect(yearOf('Drink until')).toBe(Number(slider('Drink until').getAttribute('aria-valuemax')));
  });

  test('Save sends the four fields and hands back what the server stored', async () => {
    updateBottle.mockResolvedValue(okRes({ bottle: { _id: 'b1', drinkFrom: 2025, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 } }));
    const onSaved = vi.fn();
    renderWindow({ drinkFrom: 2024, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 }, { onSaved });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    fireEvent.keyDown(slider('Drink from'), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ drinkFrom: 2025, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 }));
    expect(updateBottle).toHaveBeenCalledWith(apiFetch, 'b1', { drinkFrom: 2025, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 });
  });

  test('an open end stays open when Save is pressed without moving its handle', async () => {
    updateBottle.mockResolvedValue(okRes({ bottle: { _id: 'b1', drinkFrom: 2020, drinkTo: null } }));
    renderWindow({ drinkFrom: 2020 });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    // The open end is drawn where the bar fades out, so it has a handle.
    expect(yearOf('Drink until')).toBe(2029);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateBottle).toHaveBeenCalledWith(apiFetch, 'b1', { drinkFrom: 2020, peakFrom: null, peakUntil: null, drinkTo: null }));
  });

  test('moving the handle of an open end closes it at the chosen year', async () => {
    updateBottle.mockResolvedValue(okRes({ bottle: { _id: 'b1', drinkFrom: 2020, drinkTo: 2030 } }));
    renderWindow({ drinkFrom: 2020 });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    fireEvent.keyDown(slider('Drink until'), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateBottle).toHaveBeenCalledWith(apiFetch, 'b1', { drinkFrom: 2020, peakFrom: null, peakUntil: null, drinkTo: 2030 }));
  });

  test('Mark a peak adds the middle third; Remove peak saves the window without one', async () => {
    updateBottle.mockResolvedValue(okRes({ bottle: { drinkFrom: 2024, drinkTo: 2035 } }));
    renderWindow({ drinkFrom: 2024, drinkTo: 2035 });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    expect(screen.getAllByRole('slider')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Mark a peak' }));
    expect([yearOf('Peak from'), yearOf('Peak until')]).toEqual([2028, 2031]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove peak' }));
    expect(screen.queryByRole('slider', { name: 'Peak from' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateBottle).toHaveBeenCalledWith(apiFetch, 'b1', { drinkFrom: 2024, peakFrom: null, peakUntil: null, drinkTo: 2035 }));
  });

  test('a refused save shows the server\'s message and keeps the handles', async () => {
    updateBottle.mockResolvedValue({ ok: false, json: async () => ({ error: 'peakUntil cannot be after drinkTo' }) });
    const onSaved = vi.fn();
    renderWindow({ drinkFrom: 2024, drinkTo: 2030 }, { onSaved });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('peakUntil cannot be after drinkTo');
    expect(screen.getAllByRole('slider')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test('Cancel (or Escape) drops the changes and gives the focus back to Adjust', () => {
    renderWindow({ drinkFrom: 2024, drinkTo: 2030 });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    fireEvent.keyDown(slider('Drink from'), { key: 'PageUp' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('button', { name: 'Adjust your drink window' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    expect(yearOf('Drink from')).toBe(2024);
    fireEvent.keyDown(slider('Drink from'), { key: 'Escape' });
    expect(screen.queryByRole('slider')).toBeNull();
    expect(updateBottle).not.toHaveBeenCalled();
  });

  test('Remove my window clears all four years, as emptying them in the edit form does', async () => {
    updateBottle.mockResolvedValue(okRes({ bottle: { _id: 'b1', drinkFrom: null, peakFrom: null, peakUntil: null, drinkTo: null } }));
    const onSaved = vi.fn();
    renderWindow({ drinkFrom: 2024, peakFrom: 2026, peakUntil: 2028, drinkTo: 2030 }, { onSaved });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove my window' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ drinkFrom: null, peakFrom: null, peakUntil: null, drinkTo: null }));
    expect(updateBottle).toHaveBeenCalledWith(apiFetch, 'b1', { drinkFrom: null, peakFrom: null, peakUntil: null, drinkTo: null });
  });

  test('no window yet: "Set your own window" starts from the sommelier\'s years, and offers no removal', () => {
    const vintageProfile = { status: 'reviewed', vintage: '2018', earlyFrom: 2023, earlyUntil: 2026, peakFrom: 2027, peakUntil: 2033, lateFrom: 2034, lateUntil: 2040 };
    renderWindow({}, { sommReviewed: true, vintageProfile });
    expect(screen.queryByTestId('maturity-timeline')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set your own window' }));
    expect([yearOf('Drink from'), yearOf('Peak from'), yearOf('Peak until'), yearOf('Drink until')]).toEqual([2023, 2027, 2033, 2040]);
    expect(screen.queryByRole('button', { name: 'Remove my window' })).toBeNull();
  });

  // jsdom has no PointerEvent: a MouseEvent carries clientX and button.
  const withPointerEvents = (fn) => {
    const had = 'PointerEvent' in window;
    if (!had) {
      window.PointerEvent = class extends MouseEvent {
        constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
      };
    }
    try { fn(); } finally { if (!had) delete window.PointerEvent; }
  };
  // Vintage 2018 → axis 2017 … 2041 (25 years) on 250 px: 10 px a year.
  const tenPxAYear = () => {
    document.querySelector('.dwe-axis').getBoundingClientRect = () => ({ left: 0, width: 250, top: 0, height: 100, right: 250, bottom: 100 });
  };

  test('two handles of a row drawn over each other: the first move picks the one to drag', () => withPointerEvents(() => {
    renderWindow({ drinkFrom: 2030, drinkTo: 2030 });
    fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
    tenPxAYear();
    // Drink from's handle at 130 px, drink until's at 140 px: a press at 136 is on both.
    const drinkTo = slider('Drink until');
    fireEvent.pointerDown(drinkTo, { pointerId: 3, clientX: 136, button: 0 });
    fireEvent.pointerMove(drinkTo, { pointerId: 3, clientX: 100 });
    expect([yearOf('Drink from'), yearOf('Drink until')]).toEqual([2027, 2030]);
    expect(slider('Drink from')).toHaveFocus();
    fireEvent.pointerUp(drinkTo, { pointerId: 3, clientX: 100 });
  }));

  test('a handle follows the pointer in whole years and stops at its neighbour', () => {
    withPointerEvents(() => {
      renderWindow({ drinkFrom: 2024, peakFrom: 2027, peakUntil: 2030, drinkTo: 2035 });
      fireEvent.click(screen.getByRole('button', { name: 'Adjust your drink window' }));
      tenPxAYear();
      const peakFrom = slider('Peak from');
      fireEvent.pointerDown(peakFrom, { pointerId: 7, clientX: 100, button: 0 });
      fireEvent.pointerMove(peakFrom, { pointerId: 7, clientX: 112 });
      // A start handle sits on the left edge of its year: 2017 + round(112 / 10).
      expect(yearOf('Peak from')).toBe(2028);
      fireEvent.pointerMove(peakFrom, { pointerId: 7, clientX: 200 });
      expect(yearOf('Peak from')).toBe(2030);
      fireEvent.pointerUp(peakFrom, { pointerId: 7, clientX: 200 });
      fireEvent.pointerMove(peakFrom, { pointerId: 7, clientX: 50 });
      expect(yearOf('Peak from')).toBe(2030);
    });
  });
});
