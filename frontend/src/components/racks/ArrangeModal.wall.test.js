import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ArrangeModal from './ArrangeModal';

// "Organize this rack" on a wall. Bottles in a pile lie on one another, so the
// order in which a wall is filled is worked out by the server (the same for
// the web and for an assistant). The modal's part is to send the corner and no
// order of its own (an order by drawn height hangs bottles at the top of piles
// with nothing under them), and to name each move by box and spot, since a
// bare slot number says nothing in a wall.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, a, b) => {
      const text = typeof a === 'string' ? a : (a?.defaultValue ?? key);
      const vars = (a && typeof a === 'object' ? a : b) || {};
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => (name in vars ? String(vars[name]) : `{{${name}}}`));
    },
  }),
}));

// A1: an X of three a pile (1–12). B1: two shelves of three (13–18).
const WALL = {
  _id: 'w1', name: 'Cellar wall', type: 'wall', rows: 1, cols: 2,
  typeConfig: { boxes: [{ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 3 }, { x: 1, y: 0, w: 1, h: 1, kind: 'shelves', rows: 2, cols: 3 }] },
  slots: [{ position: 1, bottle: { _id: 'b1' } }, { position: 17, bottle: { _id: 'b2' } }],
};
const plan = (changes) => ({
  ok: true,
  data: { strategy: 'maturity', bottlesTotal: 2, changes, target: [{ position: 3, bottleId: 'b1' }], before: [{ position: 1, bottleId: 'b1' }] },
});

test('a wall: the corner goes to the server with no order, and each move is named by box and spot', async () => {
  const onPreview = vi.fn(async () => plan([
    { from: 1, to: 3, bottleId: 'b1', name: 'Barolo', vintage: '2015' },
    { from: 17, to: 2, bottleId: 'b2', name: 'Chablis', vintage: '2020' },
  ]));
  render(<ArrangeModal rack={WALL} onPreview={onPreview} onApply={vi.fn()} onClose={vi.fn()} />);

  await waitFor(() => expect(onPreview).toHaveBeenCalledWith('maturity', undefined, 'top-left'));
  expect(await screen.findByText('A1 top · 3')).toBeTruthy();
  expect(screen.getByText('A1 top · 1')).toBeTruthy();
  expect(screen.getByText('B1 · shelf 2, 2')).toBeTruthy();
  expect(screen.getByText('A wall is filled box after box from that corner. In a pile, the first bottle lies on top.')).toBeTruthy();

  // Another corner is another plan.
  fireEvent.click(screen.getByRole('button', { name: 'Bottom right' }));
  await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith('maturity', undefined, 'bottom-right'));
});

test('any other rack still sends the order it works out, and shows slot numbers', async () => {
  const grid = { _id: 'g1', name: 'Grid', type: 'grid', rows: 2, cols: 3, slots: [{ position: 5, bottle: { _id: 'b1' } }] };
  const onPreview = vi.fn(async () => plan([{ from: 5, to: 1, bottleId: 'b1', name: 'Barolo', vintage: '2015' }]));
  render(<ArrangeModal rack={grid} onPreview={onPreview} onApply={vi.fn()} onClose={vi.fn()} />);

  await waitFor(() => expect(onPreview).toHaveBeenCalledWith('maturity', [1, 2, 3, 4, 5, 6], 'top-left'));
  const row = (await screen.findByText(/Barolo/)).closest('tr');
  expect([...row.querySelectorAll('.arrange-pos')].map((td) => td.textContent)).toEqual(['1', '5']);
  expect(screen.queryByText(/A wall is filled/)).toBeNull();
});
