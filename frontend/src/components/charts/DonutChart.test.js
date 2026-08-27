import { render } from '@testing-library/react';
import DonutChart from './DonutChart';

// i18n: only the aria-label and the "bottles" caption go through t() — the
// identity stub keeps the geometry assertions independent of locale files.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

// Geometry constants mirrored from the component.
const SIZE = 180;
const R = SIZE * 0.355;
const C = 2 * Math.PI * R;

const segs = (...values) =>
  values.map((value, i) => ({ type: `t${i}`, label: `T${i}`, value, color: '#111111' }));

/** The arc circles, in render order (index 0 is the background track). */
function arcCircles(container) {
  return [...container.querySelectorAll('circle')].slice(1);
}

describe('DonutChart', () => {
  test('every arc dash + gap sums to the circumference (regression: ticket 6a8b497c)', () => {
    // 62/19/7/3/1 of 92 — the exact distribution from the report, where the
    // old `${len} ${C}` gap made the 67% segment render as 42% with a
    // phantom track-coloured quarter from 12 to 3 o'clock.
    const { container } = render(
      <DonutChart segments={segs(62, 19, 7, 3, 1)} total={92} />
    );
    const arcs = arcCircles(container);
    expect(arcs).toHaveLength(5);
    for (const arc of arcs) {
      const [dash, gap] = arc.getAttribute('stroke-dasharray').split(' ').map(Number);
      expect(dash + gap).toBeCloseTo(C, 6);
    }
  });

  test('arc lengths are proportional and tile the full ring', () => {
    const { container } = render(
      <DonutChart segments={segs(62, 19, 7, 3, 1)} total={92} />
    );
    const dashes = arcCircles(container).map(
      (a) => Number(a.getAttribute('stroke-dasharray').split(' ')[0])
    );
    expect(dashes[0]).toBeCloseTo((62 / 92) * C, 6);
    expect(dashes.reduce((s, d) => s + d, 0)).toBeCloseTo(C, 6);
  });

  test('a single 100% segment renders as a full ring', () => {
    const { container } = render(<DonutChart segments={segs(10)} total={10} />);
    const [dash, gap] = arcCircles(container)[0]
      .getAttribute('stroke-dasharray').split(' ').map(Number);
    expect(dash).toBeCloseTo(C, 6);
    expect(gap).toBeCloseTo(0, 6);
  });

  test('zero-value segments are skipped', () => {
    const { container } = render(<DonutChart segments={segs(5, 0, 5)} total={10} />);
    expect(arcCircles(container)).toHaveLength(2);
  });

  test('track and centre text use theme variables, not hardcoded dark colours', () => {
    const { container } = render(<DonutChart segments={segs(1)} total={1} />);
    const track = container.querySelector('circle');
    expect(track.style.stroke).toContain('var(--color-border-light');
    const [count, caption] = container.querySelectorAll('text');
    expect(count.style.fill).toContain('var(--color-text');
    expect(caption.style.fill).toContain('var(--color-text-muted');
  });
});
