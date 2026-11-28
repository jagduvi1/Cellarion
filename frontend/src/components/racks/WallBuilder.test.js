import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import WallBuilder from './WallBuilder';
import { newWall, setGrid, usageByBox, wallFromRack, toTypeConfig } from '../../utils/wallEdit';
import backendWall from '../../../../backend/src/utils/wallGeometry.js';

// The wall builder is how a member draws their shelving: tap a box, choose
// what is inside. Every state it can reach must be a wall the server takes,
// and on a wall in use it must not offer what the server refuses (removing a
// box with bottles in it, giving it another content, shrinking it under a
// bottle), because a refusal after the fact reads as lost work.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const text = typeof opts === 'string' ? opts : (opts?.defaultValue ?? key);
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => (opts && typeof opts === 'object' && name in opts ? String(opts[name]) : `{{${name}}}`));
    },
  }),
}));

let latest;
function Harness({ start, usage }) {
  const [wall, setWall] = useState(start);
  latest = wall;
  return <WallBuilder wall={wall} onChange={setWall} usage={usage} />;
}
const box = (label) => screen.getByRole('button', { name: new RegExp(`^Box ${label},`) });
const kind = (name) => screen.getByRole('button', { name });
const serverSays = () => backendWall.validateWallConfig(toTypeConfig(latest), 'wall', latest.rows, latest.cols, false);

test('a new wall shows its four boxes; tapping one opens it, and another content is one tap', () => {
  render(<Harness start={newWall()} />);
  expect(screen.getAllByRole('button', { name: /^Box / })).toHaveLength(4);
  expect(screen.getByText('No box is chosen. Tap one in the wall above.')).toBeTruthy();

  fireEvent.click(box('B1'));
  expect(screen.getByText('Box B1')).toBeTruthy();
  expect(screen.getByText('Holds 24 bottle(s)')).toBeTruthy();
  expect(kind('X').getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(kind('Diagonal /'));
  expect(latest.boxes.find((b) => b.x === 1 && b.y === 0)).toMatchObject({ kind: 'slash', perSection: 14 });
  expect(screen.getByText('Holds 28 bottle(s)')).toBeTruthy();
  expect(screen.getByLabelText('Bottles per half').value).toBe('14');
  expect(serverSays()).toBeNull();
});

test('what a box holds is typed in, and a closed box asks for nothing', () => {
  render(<Harness start={newWall()} />);
  fireEvent.click(box('A1'));
  fireEvent.change(screen.getByLabelText('Bottles per triangle'), { target: { value: '9' } });
  expect(latest.boxes[0].perSection).toBe(9);
  expect(screen.getByText('Holds 36 bottle(s)')).toBeTruthy();

  fireEvent.click(kind('Rack'));
  fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '4' } });
  fireEvent.change(screen.getByLabelText('Bottles per row'), { target: { value: '3' } });
  expect(latest.boxes[0]).toMatchObject({ kind: 'rack', rows: 4, cols: 3 });

  fireEvent.click(kind('Closed'));
  expect(screen.getByText('Holds no bottles')).toBeTruthy();
  expect(screen.queryByLabelText('Rows')).toBeNull();
  expect(serverSays()).toBeNull();
});

test('a wider wall has empty cells; tapping one and choosing a content puts a box there', () => {
  render(<Harness start={setGrid(newWall(), 2, 3)} />);
  const empty = screen.getAllByRole('button', { name: /^Empty wall at / });
  expect(empty.map((e) => e.getAttribute('aria-label'))).toEqual(['Empty wall at C1, add a box', 'Empty wall at C2, add a box']);

  fireEvent.click(empty[0]);
  expect(screen.getByText('Empty wall at C1')).toBeTruthy();
  fireEvent.click(kind('Shelves'));
  expect(latest.boxes).toHaveLength(5);
  expect(latest.boxes[4]).toMatchObject({ x: 2, y: 0, kind: 'shelves' });
  // The new box is the one now open.
  expect(screen.getByText('Box C1')).toBeTruthy();
  expect(serverSays()).toBeNull();
});

test('a box grows into empty wall, and removing it leaves the cell open', () => {
  render(<Harness start={setGrid(newWall(), 2, 3)} />);
  fireEvent.click(box('B1'));
  const wide = screen.getByLabelText('Box width (cells)');
  expect(wide.getAttribute('max')).toBe('2');
  fireEvent.change(wide, { target: { value: '2' } });
  expect(latest.boxes.find((b) => b.x === 1 && b.y === 0)).toMatchObject({ w: 2, h: 1 });
  expect(screen.getAllByRole('button', { name: /^Empty wall at / })).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Remove this box' }));
  expect(latest.boxes).toHaveLength(3);
  expect(screen.getByText('Empty wall at B1')).toBeTruthy();
  expect(serverSays()).toBeNull();
});

test('the wall itself cannot shrink past a box', () => {
  render(<Harness start={newWall()} />);
  const [cols, rows] = [screen.getByLabelText('Wall width (cells)'), screen.getByLabelText('Wall height (cells)')];
  expect(cols.getAttribute('min')).toBe('2');
  expect(rows.getAttribute('min')).toBe('2');
  fireEvent.change(cols, { target: { value: '5' } });
  expect(latest.cols).toBe(5);
  expect(screen.getAllByRole('button', { name: /^Empty wall at / })).toHaveLength(6);
});

test('on a wall in use, a box with bottles in it keeps its content, cannot be removed, and cannot shrink under a bottle', () => {
  // A1 an X of six a triangle with bottles up to the fourth of a pile; B1 an empty rack.
  const rack = {
    type: 'wall', rows: 1, cols: 2,
    typeConfig: { boxes: [
      { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 },
      { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', x: 1, y: 0, w: 1, h: 1, kind: 'rack', rows: 3, cols: 4 },
    ] },
    slots: [{ position: 3 }, { position: 10 }],
  };
  render(<Harness start={wallFromRack(rack)} usage={usageByBox(rack)} />);

  fireEvent.click(box('A1'));
  expect(screen.getByText(/^This box has 2 bottle\(s\) in it\./)).toBeTruthy();
  expect(kind('X').disabled).toBe(false);
  for (const name of ['Diagonal /', 'Rack', 'Open bin', 'Closed']) expect(kind(name).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Remove this box' }).disabled).toBe(true);
  expect(screen.getByLabelText('Bottles per triangle').getAttribute('min')).toBe('4');

  // The empty box beside it is free.
  fireEvent.click(box('B1'));
  expect(screen.queryByText(/^This box has/)).toBeNull();
  expect(kind('Open bin').disabled).toBe(false);
  expect(screen.getByRole('button', { name: 'Remove this box' }).disabled).toBe(false);
});

test('a box can be chosen from the keyboard', () => {
  render(<Harness start={newWall()} />);
  const target = box('A2');
  expect(target.getAttribute('tabindex')).toBe('0');
  fireEvent.keyDown(target, { key: 'Enter' });
  expect(screen.getByText('Box A2')).toBeTruthy();
  expect(target.getAttribute('aria-pressed')).toBe('true');
});

// Adding or removing a box replaces the panel under the button that was
// pressed. Left alone, the keyboard's place falls back to the page (and, in
// the edit dialog, out of the dialog).
test('after adding or removing a box the keyboard is in the new panel, on the content chosen there', () => {
  render(<Harness start={setGrid(newWall(), 2, 3)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Empty wall at C1, add a box' }));
  fireEvent.click(kind('Shelves'));
  expect(screen.getByText('Box C1')).toBeTruthy();
  expect(document.activeElement).toBe(kind('Shelves'));
  expect(kind('Shelves').getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: 'Remove this box' }));
  expect(screen.getByText('Empty wall at C1')).toBeTruthy();
  expect(document.activeElement).toBe(kind('X'));
});

// The builder sits inside the rack form: Enter in a number field would create
// or save the rack in the middle of an edit.
test('Enter in a number field of the builder does not submit the form around it', () => {
  const onSubmit = vi.fn((e) => e.preventDefault());
  render(<form onSubmit={onSubmit}><Harness start={newWall()} /><button type="submit">Create</button></form>);
  fireEvent.click(box('A1'));
  const field = screen.getByLabelText('Bottles per triangle');
  const notStopped = fireEvent.keyDown(field, { key: 'Enter' });
  expect(notStopped).toBe(false);
  // A key on a box still chooses it.
  fireEvent.keyDown(box('B1'), { key: 'Enter' });
  expect(screen.getByText('Box B1')).toBeTruthy();
});

test('a wall as high as the server stores opens with a height it can keep', () => {
  const tall = { rows: 15, cols: 1, boxes: [{ _id: 'cccccccccccccccccccccccc', x: 0, y: 14, w: 1, h: 1, kind: 'bin', perSection: 4 }] };
  render(<Harness start={tall} />);
  const height = screen.getByLabelText('Wall height (cells)');
  expect(height.value).toBe('15');
  expect(Number(height.getAttribute('max'))).toBeGreaterThanOrEqual(15);
  expect(Number(height.getAttribute('min'))).toBe(15);
  // Widening the wall leaves its height alone.
  fireEvent.change(screen.getByLabelText('Wall width (cells)'), { target: { value: '2' } });
  expect(latest).toMatchObject({ rows: 15, cols: 2 });
  expect(serverSays()).toBeNull();
});

test('a wall past what a rack may hold is said at once, not at the save', () => {
  const full = { x: 0, y: 0, w: 1, h: 1, kind: 'rack', rows: 20, cols: 20 };
  const boxes = Array.from({ length: 26 }, (_, i) => ({ ...full, key: `k${i}`, x: i % 13, y: Math.floor(i / 13) }));
  render(<Harness start={{ rows: 2, cols: 13, boxes }} />);
  expect(screen.getByRole('alert').textContent).toBe('This wall would hold 10400 bottles. A rack can hold at most 10000: make a box smaller or take one away.');
  expect(serverSays()).toMatch(/at most 10000 slots/);
});
