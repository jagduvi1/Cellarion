import { render, fireEvent } from '@testing-library/react';
import RackRenderer from './RackRenderer';
import { SLOT_RADIUS } from '../../utils/rackLayouts';

// On a phone a slot is small and the gap between two is dead space: each slot
// answers taps a little beyond its circle, invisibly — up to half the way to
// its nearest neighbour, never into it. Racks whose slots sit closer keep the
// plain circle.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, d) => (typeof d === 'string' ? d : k), i18n: { language: 'en' } }),
}));

const rack = (over) => ({ _id: 'r1', name: 'Rack', type: 'grid', rows: 2, cols: 3, slots: [], ...over });
const hits = (container) => [...container.querySelectorAll('circle.rack-slot-hit')];

test('a grid rack: every slot gets a transparent tap circle, half-way to its neighbour', () => {
  const onSlotClick = vi.fn();
  const { container } = render(<RackRenderer rack={rack()} canEdit onSlotClick={onSlotClick} />);
  const circles = hits(container);
  expect(circles).toHaveLength(6);
  for (const c of circles) {
    expect(c.getAttribute('fill')).toBe('transparent');
    // Grid pitch is 48 units: 24 reaches the midpoint, not past it.
    expect(Number(c.getAttribute('r'))).toBeCloseTo(SLOT_RADIUS * 1.2);
  }
  // It is part of the slot: a tap on it opens that slot.
  fireEvent.click(circles[4]);
  expect(onSlotClick).toHaveBeenCalledWith(5, null);
});

test('a rack whose slots sit closer than that (an X-rack) keeps the plain circle', () => {
  const { container } = render(<RackRenderer rack={rack({ type: 'x-rack', typeConfig: {} })} canEdit onSlotClick={() => {}} />);
  expect(hits(container)).toHaveLength(0);
});

test('a shelf with a back row (its slots sit behind the front ones) keeps the plain circles', () => {
  const { container } = render(<RackRenderer rack={rack({ type: 'shelf', rows: 2, cols: 3, typeConfig: { backCols: 2 } })} canEdit onSlotClick={() => {}} />);
  expect(container.querySelectorAll('.rack-slot-g').length).toBeGreaterThan(0);
  expect(hits(container)).toHaveLength(0);
});
