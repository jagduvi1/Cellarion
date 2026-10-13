import { render } from '@testing-library/react';
import MaturityPhaseTable from './MaturityPhaseTable';

// Beta feedback 2026-10-12: an early and an optimal phase that shared a year
// were both marked as now.
describe('MaturityPhaseTable', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const rows = (container) => [...container.querySelectorAll('.bd-maturity-row')].map((r) => ({
    cls: r.querySelector('.bd-maturity-phase-dot').className.replace(/.*--/, ''),
    range: r.querySelector('.bd-maturity-phase-range').textContent,
    yrs: r.querySelector('.bd-maturity-phase-yrs')?.textContent,
    active: r.classList.contains('bd-maturity-row--active'),
  }));

  it('lists the phases end to end, a one-year phase as one year, and marks one phase as now', () => {
    const profile = { vintage: '2025', earlyFrom: 2026, earlyUntil: 2026, peakFrom: 2026, peakUntil: 2029, lateFrom: 2030, lateUntil: 2032 };
    const { container } = render(<MaturityPhaseTable profile={profile} />);
    expect(rows(container)).toEqual([
      { cls: 'early', range: '2026', yrs: '1 yr', active: true },
      { cls: 'peak', range: '2027–2029', yrs: '2–4 yrs', active: false },
      { cls: 'late', range: '2030–2032', yrs: '5–7 yrs', active: false },
    ]);
  });

  it('keeps open-ended phases as before', () => {
    const profile = { vintage: '2020', earlyFrom: 2022, earlyUntil: 2025, peakFrom: 2026 };
    const { container } = render(<MaturityPhaseTable profile={profile} />);
    expect(rows(container)).toEqual([
      { cls: 'early', range: '2022–2025', yrs: '2–5 yrs', active: false },
      { cls: 'peak', range: 'from 2026', yrs: '6+ yrs', active: true },
    ]);
  });
});
