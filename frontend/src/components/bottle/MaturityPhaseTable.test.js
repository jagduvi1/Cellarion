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

  // Release audit 2026-10-13: the marked row now comes from the maturity status.
  describe('a reviewed profile: the row marked as now is the phase its status names', () => {
    const marked = (profile) => rows(render(<MaturityPhaseTable profile={{ status: 'reviewed', ...profile }} />).container)
      .filter((r) => r.active).map((r) => r.cls);

    it('an open-ended earlier phase no longer leaves two rows marked', () => {
      expect(marked({ vintage: '2018', earlyFrom: 2020, peakFrom: 2024, peakUntil: 2030, lateFrom: 2031, lateUntil: 2035 })).toEqual(['peak']);
    });
    it('a phase with only an end year is marked', () => {
      expect(marked({ vintage: '2018', earlyFrom: 2020, earlyUntil: 2023, peakUntil: 2030 })).toEqual(['peak']);
    });
    it('a gap year marks the phase the status names', () => {
      expect(marked({ vintage: '2020', earlyFrom: 2021, earlyUntil: 2024, peakFrom: 2028, peakUntil: 2032 })).toEqual(['early']);
    });
    it('a late phase with no end is marked once it has begun', () => {
      expect(marked({ vintage: '2015', earlyFrom: 2017, earlyUntil: 2019, peakFrom: 2020, peakUntil: 2023, lateFrom: 2024 })).toEqual(['late']);
    });
    it('before the first phase and past prime, no row is marked', () => {
      expect(marked({ vintage: '2025', earlyFrom: 2028, earlyUntil: 2029, peakFrom: 2030, peakUntil: 2035 })).toEqual([]);
      expect(marked({ vintage: '2010', earlyFrom: 2012, earlyUntil: 2014, peakFrom: 2015, peakUntil: 2020, lateFrom: 2021, lateUntil: 2024 })).toEqual([]);
    });
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
