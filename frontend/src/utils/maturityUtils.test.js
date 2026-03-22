import { getMaturityPhases, isPhaseActive } from './maturityUtils';

// ---------------------------------------------------------------------------
// getMaturityPhases
// ---------------------------------------------------------------------------
describe('getMaturityPhases', () => {
  const labels = { early: 'Early', peak: 'Peak', late: 'Late' };

  it('returns all three phases when all have from/until data', () => {
    const profile = {
      vintage: '2015',
      earlyFrom: 2020, earlyUntil: 2025,
      peakFrom: 2025,  peakUntil: 2030,
      lateFrom: 2030,  lateUntil: 2040,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases).toHaveLength(3);
    expect(phases[0].label).toBe('Early');
    expect(phases[0].cls).toBe('early');
    expect(phases[1].label).toBe('Peak');
    expect(phases[1].cls).toBe('peak');
    expect(phases[2].label).toBe('Late');
    expect(phases[2].cls).toBe('late');
  });

  it('includes vintageInt parsed from profile.vintage', () => {
    const profile = {
      vintage: '2015',
      earlyFrom: 2020, earlyUntil: 2025,
      peakFrom: 2025,  peakUntil: 2030,
      lateFrom: 2030,  lateUntil: 2040,
    };
    const phases = getMaturityPhases(profile, labels);
    phases.forEach(p => {
      expect(p.vintageInt).toBe(2015);
    });
  });

  it('filters out phases with no from and no until', () => {
    const profile = {
      vintage: '2018',
      earlyFrom: 2022, earlyUntil: 2026,
      // peak has no data
      peakFrom: undefined, peakUntil: undefined,
      lateFrom: 2030, lateUntil: 2040,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases).toHaveLength(2);
    expect(phases[0].cls).toBe('early');
    expect(phases[1].cls).toBe('late');
  });

  it('includes a phase when only "from" is set', () => {
    const profile = {
      vintage: '2020',
      earlyFrom: 2024, earlyUntil: undefined,
      peakFrom: undefined, peakUntil: undefined,
      lateFrom: undefined, lateUntil: undefined,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases).toHaveLength(1);
    expect(phases[0].cls).toBe('early');
    expect(phases[0].from).toBe(2024);
    expect(phases[0].until).toBeUndefined();
  });

  it('includes a phase when only "until" is set', () => {
    const profile = {
      vintage: '2020',
      earlyFrom: undefined, earlyUntil: undefined,
      peakFrom: undefined,  peakUntil: 2035,
      lateFrom: undefined,  lateUntil: undefined,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases).toHaveLength(1);
    expect(phases[0].cls).toBe('peak');
    expect(phases[0].until).toBe(2035);
  });

  it('returns empty array if no phases have data', () => {
    const profile = {
      vintage: '2020',
      earlyFrom: undefined, earlyUntil: undefined,
      peakFrom: undefined,  peakUntil: undefined,
      lateFrom: undefined,  lateUntil: undefined,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases).toEqual([]);
  });

  it('returns empty array if all from/until are null', () => {
    const profile = {
      vintage: '2020',
      earlyFrom: null, earlyUntil: null,
      peakFrom: null,  peakUntil: null,
      lateFrom: null,  lateUntil: null,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases).toEqual([]);
  });

  it('returns empty array if all from/until are 0 (falsy)', () => {
    const profile = {
      vintage: '2020',
      earlyFrom: 0, earlyUntil: 0,
      peakFrom: 0,  peakUntil: 0,
      lateFrom: 0,  lateUntil: 0,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases).toEqual([]);
  });

  it('preserves from and until values on returned phase objects', () => {
    const profile = {
      vintage: '2016',
      earlyFrom: 2020, earlyUntil: 2024,
      peakFrom: 2024,  peakUntil: 2030,
      lateFrom: 2030,  lateUntil: 2045,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases[0].from).toBe(2020);
    expect(phases[0].until).toBe(2024);
    expect(phases[1].from).toBe(2024);
    expect(phases[1].until).toBe(2030);
    expect(phases[2].from).toBe(2030);
    expect(phases[2].until).toBe(2045);
  });

  it('handles vintage as a non-numeric string', () => {
    const profile = {
      vintage: 'NV',
      earlyFrom: 2020, earlyUntil: 2025,
      peakFrom: undefined, peakUntil: undefined,
      lateFrom: undefined, lateUntil: undefined,
    };
    const phases = getMaturityPhases(profile, labels);
    expect(phases).toHaveLength(1);
    expect(phases[0].vintageInt).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// isPhaseActive
// ---------------------------------------------------------------------------
describe('isPhaseActive', () => {
  it('returns true when currentYear is within from-until range', () => {
    expect(isPhaseActive({ from: 2020, until: 2030 }, 2025)).toBe(true);
  });

  it('returns true when currentYear equals from', () => {
    expect(isPhaseActive({ from: 2025, until: 2030 }, 2025)).toBe(true);
  });

  it('returns true when currentYear equals until', () => {
    expect(isPhaseActive({ from: 2020, until: 2025 }, 2025)).toBe(true);
  });

  it('returns false when currentYear is before the from-until range', () => {
    expect(isPhaseActive({ from: 2025, until: 2030 }, 2020)).toBe(false);
  });

  it('returns false when currentYear is after the from-until range', () => {
    expect(isPhaseActive({ from: 2020, until: 2025 }, 2030)).toBe(false);
  });

  it('returns true when only from is set and currentYear >= from', () => {
    expect(isPhaseActive({ from: 2020, until: undefined }, 2025)).toBe(true);
  });

  it('returns true when only from is set and currentYear equals from', () => {
    expect(isPhaseActive({ from: 2025, until: undefined }, 2025)).toBe(true);
  });

  it('returns false when only from is set and currentYear < from', () => {
    expect(isPhaseActive({ from: 2030, until: undefined }, 2025)).toBe(false);
  });

  it('returns false when neither from nor until is set', () => {
    expect(isPhaseActive({ from: undefined, until: undefined }, 2025)).toBe(false);
  });

  it('returns false when from is null and until is null', () => {
    expect(isPhaseActive({ from: null, until: null }, 2025)).toBe(false);
  });

  it('returns false when from is 0 (falsy) and until is undefined', () => {
    // 0 is falsy in JS, so the function treats it as "no from"
    expect(isPhaseActive({ from: 0, until: undefined }, 2025)).toBe(false);
  });

  it('returns false when only until is set (no from)', () => {
    // The function only checks from-based conditions; with no from, returns false
    expect(isPhaseActive({ from: undefined, until: 2030 }, 2025)).toBe(false);
  });
});
