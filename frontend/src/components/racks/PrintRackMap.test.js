import { render } from '@testing-library/react';
import PrintRackMap from './PrintRackMap';
import { computeLayout, SLOT_RADIUS } from '../../utils/rackLayouts';

// The Cellar Book's map: every slot numbered, the number being the key into
// the printed list. A shelf cell holding several bottles gets them all on the
// cell's centre from the layout — a reported overlap: they printed on top of
// each other, numbers stacked. They are fanned out like the rack view's.

const bottle = (type) => ({ _id: `b-${type}`, vintage: 2018, wineDefinition: { name: 'Wine', type } });
const rack = (over) => ({ _id: 'r1', name: 'Rack', slots: [], ...over });
const circles = (c) => [...c.querySelectorAll('circle')].map(e => ({
  cx: Number(e.getAttribute('cx')), cy: Number(e.getAttribute('cy')), r: Number(e.getAttribute('r')),
}));
const numbers = (c) => [...c.querySelectorAll('text')].map(e => ({
  n: Number(e.textContent), x: Number(e.getAttribute('x')), y: Number(e.getAttribute('y')), size: Number(e.getAttribute('font-size')),
}));
const at = (p) => `${p.cx ?? p.x},${p.cy ?? p.y}`;

test('an open shelf of one cell holding five, two filled: five bottles apart, each number once in its own spot', () => {
  const { container } = render(<PrintRackMap rack={rack({
    type: 'shelf', rows: 1, cols: 1, typeConfig: { bottlesPerCell: 5, backCols: 0 },
    slots: [{ position: 1, bottle: bottle('red') }, { position: 2, bottle: bottle('white') }],
  })} />);

  const drawn = circles(container);
  expect(drawn).toHaveLength(5);
  expect(new Set(drawn.map(at)).size).toBe(5);
  for (const c of drawn) expect(c.r).toBeLessThan(SLOT_RADIUS);

  const nums = numbers(container);
  expect(nums.map(n => n.n).sort()).toEqual([1, 2, 3, 4, 5]);
  expect(new Set(nums.map(at)).size).toBe(5);
  // Each number sits on its own bottle and is sized from that bottle.
  for (const n of nums) {
    expect(drawn.some(c => at(c) === at(n))).toBe(true);
    expect(n.size).toBeLessThan(drawn[0].r);
  }

  // The two filled bottles are type-coloured, the other three dashed outlines.
  const fills = [...container.querySelectorAll('circle')].map(e => e.getAttribute('fill'));
  expect(fills.filter(f => f === 'none')).toHaveLength(3);
  // The cell is outlined (beside the map's own frame).
  expect(container.querySelectorAll('rect')).toHaveLength(2);
  // Numbers go on top of every bottle of the cell (neighbours overlap a little).
  const cell = container.querySelector('svg > g');
  const kids = [...cell.children];
  const lastShape = kids.map(k => !!k.querySelector('circle')).lastIndexOf(true);
  const firstNumber = kids.findIndex(k => !!k.querySelector('text'));
  expect(firstNumber).toBeGreaterThan(lastShape);
});

test('a grid rack prints as before: one full-size circle per slot on the layout centre, numbered', () => {
  const layout = computeLayout('grid', 2, 3);
  const { container } = render(<PrintRackMap rack={rack({
    type: 'grid', rows: 2, cols: 3,
    slots: [{ position: 2, bottle: bottle('red') }, { position: 6, bottle: bottle('sparkling') }],
    disabledPositions: [4],
  })} />);

  const drawn = circles(container);
  expect(drawn).toEqual(layout.slots.map(s => ({ cx: s.cx, cy: s.cy, r: SLOT_RADIUS })));
  const nums = numbers(container);
  // The disabled slot is crossed out, not numbered.
  expect(nums.map(n => n.n)).toEqual([1, 2, 3, 5, 6]);
  for (const n of nums) {
    const s = layout.slots.find(x => x.position === n.n);
    expect([n.x, n.y]).toEqual([s.cx, s.cy]);
    expect(n.size).toBeCloseTo(SLOT_RADIUS * (n.n === 2 || n.n === 6 ? 0.66 : 0.62));
  }
  expect(container.querySelectorAll('rect')).toHaveLength(1);
  expect(container.querySelectorAll('line')).toHaveLength(2);
});

