import { render, screen, fireEvent } from '@testing-library/react';
import ZoneEditorModal from './ZoneEditorModal';
import { computeLayout, SLOT_RADIUS } from '../../utils/rackLayouts';

// The zone editor's map numbers every slot and paints it on a click. A shelf
// cell holding several bottles gets them all on the cell's centre from the
// layout, so they are fanned out like the rack view's — otherwise the
// numbers and click targets of one cell stack on top of each other.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, d) => (typeof d === 'string' ? d : k) }),
}));

const rack = (over) => ({ _id: 'r1', name: 'Rack', slots: [], zones: [{ name: 'Whites', color: '#1565C0', positions: [] }], ...over });
const map = () => document.querySelector('.zones-map-svg');
const circles = () => [...map().querySelectorAll('circle')];
const at = (e) => `${e.getAttribute('cx') ?? e.getAttribute('x')},${e.getAttribute('cy') ?? e.getAttribute('y')}`;

test('a shelf cell of five: five targets apart, each numbered once, and a click paints that one', () => {
  render(<ZoneEditorModal rack={rack({ type: 'shelf', rows: 1, cols: 1, typeConfig: { bottlesPerCell: 5, backCols: 0 } })} onSave={vi.fn()} onClose={vi.fn()} />);
  const targets = circles();
  expect(targets).toHaveLength(5);
  expect(new Set(targets.map(at)).size).toBe(5);
  for (const c of targets) expect(Number(c.getAttribute('r'))).toBeLessThan(SLOT_RADIUS);

  const nums = [...map().querySelectorAll('text')];
  expect(nums.map(n => n.textContent)).toEqual(['1', '2', '3', '4', '5']);
  expect(new Set(nums.map(at)).size).toBe(5);
  nums.forEach((n, i) => expect(at(n)).toBe(at(targets[i])));

  fireEvent.click(targets[3]);
  expect(screen.getByText('1', { selector: '.zones-count' })).toBeInTheDocument();
  expect(targets[3].getAttribute('fill')).toBe('#1565C0');
  expect(targets.filter(c => c.getAttribute('fill') === '#1565C0')).toHaveLength(1);
});

test('a grid rack keeps one full-size target per slot on the layout centre', () => {
  const layout = computeLayout('grid', 2, 3);
  render(<ZoneEditorModal rack={rack({ type: 'grid', rows: 2, cols: 3 })} onSave={vi.fn()} onClose={vi.fn()} />);
  const targets = circles();
  expect(targets.map(c => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy')), Number(c.getAttribute('r'))]))
    .toEqual(layout.slots.map(s => [s.cx, s.cy, SLOT_RADIUS]));
  // Each number stays inside its own slot's group.
  for (const c of targets) expect(c.parentNode.querySelector('text')).not.toBeNull();
});
