import { render, screen } from '@testing-library/react';
import MaturityTimeline, { timelineModel } from './MaturityTimeline';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, a) => (typeof a === 'string' ? a : key) }),
}));

const phase = (cls, from, until) => ({ cls, label: cls, from, until });
const box = (m) => m.segments.map(({ cls, start, end, open }) => ({ cls, start, end, open }));

describe('timelineModel', () => {
  test('three closed phases end to end, the marker inside the one it falls in', () => {
    const m = timelineModel([phase('early', 2024, 2027), phase('peak', 2028, 2035), phase('late', 2036, 2040)], 2026);
    expect(box(m)).toEqual([
      { cls: 'early', start: 2024, end: 2027, open: false },
      { cls: 'peak', start: 2028, end: 2035, open: false },
      { cls: 'late', start: 2036, end: 2040, open: false },
    ]);
    expect([m.lo, m.hi, m.firstYear, m.lastYear]).toEqual([2024, 2040, 2024, 2040]);
    // 17 one-year cells; 2026 is the third, the marker in its middle.
    expect(m.marker).toBeCloseTo((2.5 / 17) * 100);
    expect(m.segments[0].left).toBe(0);
    expect(m.segments[2].left + m.segments[2].width).toBeCloseTo(100);
  });

  test('not ready yet: the axis starts this year, so the marker sits before the bar', () => {
    const m = timelineModel([phase('early', 2030, 2033), phase('peak', 2034, 2040)], 2026);
    expect(m.lo).toBe(2026);
    expect(m.marker).toBeLessThan(m.segments[0].left);
  });

  test('past its window: the axis runs on to this year, so the marker sits after the bar', () => {
    const m = timelineModel([phase('early', 2000, 2004), phase('peak', 2005, 2012)], 2026);
    expect(m.hi).toBe(2026);
    const last = m.segments[1];
    expect(m.marker).toBeGreaterThan(last.left + last.width);
    expect(m.lastYear).toBe(2012);
  });

  test('a last phase with no end runs on past this year, drawn open, with no end year printed', () => {
    const m = timelineModel([phase('early', 2020, 2024), phase('peak', 2025, undefined)], 2026);
    expect(box(m)[1]).toEqual({ cls: 'peak', start: 2025, end: 2029, open: true });
    expect(m.lastYear).toBeNull();
  });

  test('a phase with only an end starts this year, and one with only a start ends where the next begins', () => {
    const m = timelineModel([phase('early', undefined, 2028), phase('peak', 2029, undefined), phase('late', 2036, 2040)], 2026);
    expect(box(m)).toEqual([
      { cls: 'early', start: 2026, end: 2028, open: false },
      { cls: 'peak', start: 2029, end: 2035, open: false },
      { cls: 'late', start: 2036, end: 2040, open: false },
    ]);
  });

  test('a gap between two phases stays empty on the bar', () => {
    const m = timelineModel([phase('early', 2020, 2022), phase('peak', 2025, 2030)], 2026);
    const [a, b] = m.segments;
    expect(b.left).toBeGreaterThan(a.left + a.width);
  });

  test('no phases, no timeline', () => {
    expect(timelineModel([], 2026)).toBeNull();
  });
});

describe('MaturityTimeline', () => {
  const profile = { status: 'reviewed', vintage: '2020', earlyFrom: 2024, earlyUntil: 2027, peakFrom: 2028, peakUntil: 2035 };

  test('the marker carries the year and the status, in the status colour', () => {
    render(<MaturityTimeline profile={profile} status={{ status: 'early', hint: 'peakFrom', year: 2028 }} year={2026} />);
    const label = document.querySelector('.mt-now-label');
    expect(label.textContent).toContain('2026 · ');
    expect(label.textContent).toContain('maturity.hints.peakFrom');
    expect(label.className).toContain('maturity-badge--early');
    expect(document.querySelectorAll('.mt-seg')).toHaveLength(2);
    expect(screen.getByText('2024')).toBeInTheDocument();
    expect(screen.getByText('2035')).toBeInTheDocument();
  });

  test('without a status (a personal window takes precedence) the marker says only the year', () => {
    render(<MaturityTimeline profile={profile} status={null} year={2026} />);
    expect(document.querySelector('.mt-now-label').textContent).toBe('2026');
  });

  test('a profile without a single year draws nothing', () => {
    const { container } = render(<MaturityTimeline profile={{ status: 'reviewed', vintage: '2020' }} status={null} year={2026} />);
    expect(container).toBeEmptyDOMElement();
  });
});
