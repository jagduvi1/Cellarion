import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditRackModal from './EditRackModal';
import backendWall from '../../../../backend/src/utils/wallGeometry.js';

// A wall is the one rack whose shape is edited after it was created: members
// add a box when the shelving grows. The dialog sends the whole wall with
// each stored box's id, because the server follows a box by that id to keep
// its bottles in it; a box sent without its id would read as a new one, and
// the bottles of the old one would have nowhere to go.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const text = typeof opts === 'string' ? opts : (opts?.defaultValue ?? key);
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => (opts && typeof opts === 'object' && name in opts ? String(opts[name]) : `{{${name}}}`));
    },
  }),
}));

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
// A1 an X of six a triangle with two bottles in it, B1 an empty open bin.
const WALL = {
  _id: 'w1', name: 'Bin wall', group: null, type: 'wall', rows: 1, cols: 2,
  typeConfig: { boxes: [
    { _id: A, x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 },
    { _id: B, x: 1, y: 0, w: 1, h: 1, kind: 'bin', perSection: 20 },
  ] },
  slots: [{ position: 2 }, { position: 8 }],
};
const save = () => fireEvent.click(screen.getByRole('button', { name: 'racks.saveRack' }));

test('the dialog of a wall shows the builder, and saving sends the wall with every stored box\'s id', async () => {
  const onSave = vi.fn(async () => ({ ok: true }));
  const onClose = vi.fn();
  render(<EditRackModal rack={WALL} onSave={onSave} onClose={onClose} />);
  expect(screen.getAllByRole('button', { name: /^Box / })).toHaveLength(2);

  // The wall gets a third cell with shelves in it, and the bin grows.
  fireEvent.change(screen.getByLabelText('Wall width (cells)'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Empty wall at C1, add a box' }));
  fireEvent.click(screen.getByRole('button', { name: 'Shelves' }));
  fireEvent.click(screen.getByRole('button', { name: /^Box B1,/ }));
  fireEvent.change(screen.getByLabelText('Bottles'), { target: { value: '30' } });
  save();

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  const sent = onSave.mock.calls[0][0];
  expect(sent).toMatchObject({ name: 'Bin wall', rows: 1, cols: 3 });
  expect(sent.typeConfig.boxes.map((b) => [b._id, b.kind])).toEqual([[A, 'x'], [B, 'bin'], [undefined, 'shelves']]);
  expect(sent.typeConfig.boxes[1].perSection).toBe(30);
  expect(backendWall.validateWallConfig(sent.typeConfig, 'wall', sent.rows, sent.cols, false)).toBeNull();
  // The server keeps both bottles in the X with this wall.
  const plan = backendWall.planWallEdit(
    { rows: WALL.rows, cols: WALL.cols, typeConfig: WALL.typeConfig },
    { rows: sent.rows, cols: sent.cols, typeConfig: sent.typeConfig },
    { bottles: WALL.slots.map((s) => s.position) },
  );
  expect(plan.error).toBeUndefined();
});

test('the box with bottles in it cannot be removed in the dialog, and the server\'s refusal of an edit is shown', async () => {
  const onSave = vi.fn(async () => ({ ok: false, error: 'Cannot change the wall: box A1 holds 2 bottle(s) and would be removed. Move those bottles out first.' }));
  render(<EditRackModal rack={WALL} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /^Box A1,/ }));
  expect(screen.getByRole('button', { name: 'Remove this box' }).disabled).toBe(true);
  save();
  expect(await screen.findByRole('alert')).toHaveTextContent('box A1 holds 2 bottle(s)');
});

test('a wall left with no box that holds bottles is not sent', () => {
  const onSave = vi.fn();
  render(<EditRackModal rack={{ ...WALL, slots: [] }} onSave={onSave} onClose={vi.fn()} />);
  for (const label of ['A1', 'B1']) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Box ${label},`) }));
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
  }
  save();
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('A wall needs at least one box that holds bottles.');
});

test('a rack that is no wall gets no builder and sends no shape', async () => {
  const onSave = vi.fn(async () => ({ ok: true }));
  render(<EditRackModal rack={{ _id: 'g', name: 'Grid', type: 'grid', rows: 2, cols: 3, slots: [] }} onSave={onSave} onClose={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /^Box / })).toBeNull();
  save();
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave.mock.calls[0][0]).toEqual({ name: 'Grid', group: '' });
});
