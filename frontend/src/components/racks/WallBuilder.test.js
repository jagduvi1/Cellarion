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
  expect(screen.getByText('Holds 24 bottles')).toBeTruthy();
  expect(kind('X').getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(kind('Diagonal /'));
  expect(latest.boxes.find((b) => b.x === 1 && b.y === 0)).toMatchObject({ kind: 'slash', perSection: 14 });
  expect(screen.getByText('Holds 28 bottles')).toBeTruthy();
  expect(screen.getByLabelText('Bottles per half').value).toBe('14');
  expect(serverSays()).toBeNull();
});

test('what a box holds is typed in, and a closed box asks for nothing', () => {
  render(<Harness start={newWall()} />);
  fireEvent.click(box('A1'));
  fireEvent.change(screen.getByLabelText('Bottles per triangle'), { target: { value: '9' } });
  expect(latest.boxes[0].perSection).toBe(9);
  expect(screen.getByText('Holds 36 bottles')).toBeTruthy();

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
  expect(screen.getByText(/^2 bottles lie in this box\./)).toBeTruthy();
  expect(kind('X').disabled).toBe(false);
  for (const name of ['Diagonal /', 'Rack', 'Open bin', 'Closed']) expect(kind(name).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Remove this box' }).disabled).toBe(true);
  expect(screen.getByLabelText('Bottles per triangle').getAttribute('min')).toBe('4');

  // The empty box beside it is free.
  fireEvent.click(box('B1'));
  expect(screen.queryByText(/lie in this box/)).toBeNull();
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
