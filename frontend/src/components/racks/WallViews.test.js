import { render, fireEvent } from '@testing-library/react';
import RackRenderer from './RackRenderer';
import PrintRackMap from './PrintRackMap';
import ZoneEditorModal from './ZoneEditorModal';

// A wall rack is one rack built from boxes. The three views that draw a rack
// (the racks page, the printed map, the zone editor) must all show the boxes
// with their planks and doors: the slots alone are a cloud of circles with
// nothing to tell an X's four piles from a rack's rows, and a slot number
// means nothing without the box it lies in.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, d) => (typeof d === 'string' ? d : k), i18n: { language: 'en' } }),
}));

// A1 an X of three a triangle (positions 1–12), B1 shelves 2 × 3 (13–18),
// C1 closed and two cells wide, A2 a diagonal of four a half (19–26); the
// three cells beside it are empty wall.
const WALL = {
  _id: 'w1', name: 'Wall', type: 'wall', rows: 2, cols: 4, slots: [], zones: [],
  typeConfig: {
    boxes: [
      { _id: 'a', x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 3 },
      { _id: 'b', x: 1, y: 0, w: 1, h: 1, kind: 'shelves', rows: 2, cols: 3 },
      { _id: 'c', x: 2, y: 0, w: 2, h: 1, kind: 'closed' },
      { _id: 'd', x: 0, y: 1, w: 1, h: 1, kind: 'slash', perSection: 4 },
    ],
  },
};
const boxes = (root) => [...root.querySelectorAll('[data-wall-box]')];
const box = (root, label) => root.querySelector(`[data-wall-box="${label}"]`);

test('the racks page draws every box of a wall: its frame, its planks or doors, and its name', () => {
  const onSlotClick = vi.fn();
  const { container } = render(<RackRenderer rack={WALL} canEdit onSlotClick={onSlotClick} />);
  expect(boxes(container).map((b) => b.getAttribute('data-wall-box'))).toEqual(['A1', 'B1', 'C1', 'A2']);
  expect(box(container, 'A1').querySelectorAll('line')).toHaveLength(2);
  expect(box(container, 'B1').querySelectorAll('line')).toHaveLength(1);
  expect(box(container, 'A2').querySelectorAll('line')).toHaveLength(1);
  // A pair of doors, each with its knob.
  expect(box(container, 'C1').querySelectorAll('circle')).toHaveLength(2);
  // A box is named by its column letter and row number, written along the wall's edges.
  expect([...container.querySelectorAll('text.wall-axis')].map((t) => t.textContent)).toEqual(['A', 'B', 'C', 'D', '1', '2']);

  // 12 + 6 + 0 + 8 slots, and a tap on one opens that slot.
  const slots = [...container.querySelectorAll('.rack-slot-g')];
  expect(slots).toHaveLength(26);
  fireEvent.click(slots[12]);
  expect(onSlotClick).toHaveBeenCalledWith(13, null);
});

test('a wall is drawn as its boxes only: no panel behind the cells that hold no box', () => {
  const { container } = render(<RackRenderer rack={WALL} />);
  const svg = container.querySelector('svg.rack-svg');
  const width = svg.getAttribute('viewBox').split(' ')[2];
  // The one panel every other rack has spans the whole drawing.
  expect([...svg.querySelectorAll('rect')].some((r) => r.getAttribute('width') === width)).toBe(false);

  const grid = render(<RackRenderer rack={{ _id: 'g', name: 'Grid', type: 'grid', rows: 2, cols: 3, slots: [] }} />).container;
  expect(boxes(grid)).toHaveLength(0);
  const gridSvg = grid.querySelector('svg.rack-svg');
  const gridWidth = gridSvg.getAttribute('viewBox').split(' ')[2];
  expect([...gridSvg.querySelectorAll('rect')].some((r) => r.getAttribute('width') === gridWidth)).toBe(true);
});

test('the printed map shows the boxes too, and numbers every slot once', () => {
  const { container } = render(<PrintRackMap rack={WALL} />);
  expect(boxes(container)).toHaveLength(4);
  const numbers = [...container.querySelectorAll('text:not(.wall-axis)')].map((t) => t.textContent);
  expect(numbers).toEqual(Array.from({ length: 26 }, (_, i) => String(i + 1)));
  expect(container.querySelectorAll('text.wall-axis')).toHaveLength(6);
});

test('the zone editor shows the boxes too, with one target a slot', () => {
  render(<ZoneEditorModal rack={{ ...WALL, zones: [{ name: 'Whites', color: '#1565C0', positions: [] }] }} onSave={vi.fn()} onClose={vi.fn()} />);
  const map = document.querySelector('.zones-map-svg');
  expect(boxes(map)).toHaveLength(4);
  expect(map.querySelectorAll('text:not(.wall-axis)')).toHaveLength(26);
});
