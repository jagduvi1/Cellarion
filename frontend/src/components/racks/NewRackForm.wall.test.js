import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import backendWall from '../../../../backend/src/utils/wallGeometry.js';

// The wall is a rack type in early access: the new-rack form offers it only
// while its flag is on for this user, and what the form then sends must be a
// wall the server stores. The server itself takes a wall from anyone; the
// flag decides the screen, never the data.

vi.mock('react-i18next', () => {
  const t = (key, opts) => {
    const text = typeof opts === 'string' ? opts : (opts?.defaultValue ?? key);
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => (opts && typeof opts === 'object' && name in opts ? String(opts[name]) : `{{${name}}}`));
  };
  return { useTranslation: () => ({ t }) };
});
let wallOn = false;
vi.mock('../../utils/featureFlags', () => ({ useFeature: (key) => key === 'wallRack' && wallOn }));
vi.mock('../BetaBadge', () => ({ default: ({ feature }) => <div data-testid="beta-badge">{feature}</div> }));

const NewRackForm = (await import('./NewRackForm')).default;
const { TYPE_DIMENSIONS } = await import('./RackTypeSelector');
const { defaultTypeConfig, createRackTypeConfig } = await import('../../utils/rackTypeConfig');

// The racks page's part of the form (pages/CellarRacks): the rack being
// typed, the reset when another type is picked, and the request on submit.
function Page({ onCreate }) {
  const [newRack, setNewRack] = useState({ name: 'Cellar wall', type: 'grid', rows: 4, cols: 8, typeConfig: {} });
  return (
    <NewRackForm
      newRack={newRack}
      setNewRack={setNewRack}
      onTypeChange={(type) => setNewRack((prev) => ({
        ...prev, type, rows: TYPE_DIMENSIONS[type].defaultRows, cols: TYPE_DIMENSIONS[type].defaultCols, typeConfig: defaultTypeConfig(type),
      }))}
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ name: newRack.name, type: newRack.type, rows: newRack.rows, cols: newRack.cols, typeConfig: createRackTypeConfig(newRack) });
      }}
      saving={false}
    />
  );
}
const typeButton = (name) => screen.queryByRole('button', { name });

// The types a cellar is put together from stand first: the grid, the wine
// cabinet and the wall, before the single shapes.
test('the wine cabinet and the wall come right after the grid; without the flag the cabinet does', () => {
  const names = (container) => [...container.querySelectorAll('.rack-type-option .rack-type-name')].map((el) => el.textContent.replace('racks.type_', ''));
  wallOn = true;
  const on = render(<Page onCreate={vi.fn()} />);
  expect(names(on.container)).toEqual(['grid', 'cabinet', 'wall', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf']);
  on.unmount();
  wallOn = false;
  const off = render(<Page onCreate={vi.fn()} />);
  expect(names(off.container)).toEqual(['grid', 'cabinet', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf']);
});

test('without the flag the form offers no wall', () => {
  wallOn = false;
  render(<Page onCreate={vi.fn()} />);
  expect(typeButton('racks.type_grid')).not.toBeNull();
  expect(typeButton('racks.type_wall')).toBeNull();
});

test('with the flag on, the wall is a type like the others, and what the form sends is a wall the server stores', () => {
  wallOn = true;
  const onCreate = vi.fn();
  const { container } = render(<Page onCreate={onCreate} />);
  fireEvent.click(typeButton('racks.type_wall'));

  // The builder replaces the rows and columns inputs, and the type carries its beta strip.
  expect(screen.getAllByRole('button', { name: /^Box / })).toHaveLength(4);
  expect(screen.queryByText('racks.rowsLabel')).toBeNull();
  expect(screen.getByTestId('beta-badge').textContent).toBe('wallRack');
  expect(container.querySelector('.new-rack-preview-hint').textContent).toContain('96');

  // One box becomes a cupboard, then the wall is created.
  fireEvent.click(screen.getByRole('button', { name: /^Box B2,/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
  fireEvent.submit(container.querySelector('form'));

  const sent = onCreate.mock.calls[0][0];
  expect(sent).toMatchObject({ type: 'wall', rows: 2, cols: 2 });
  expect(sent.typeConfig.boxes.map((b) => b.kind)).toEqual(['x', 'x', 'x', 'closed']);
  expect(sent.typeConfig.boxes[0]).toEqual({ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 });
  expect(backendWall.validateWallConfig(sent.typeConfig, sent.type, sent.rows, sent.cols, false)).toBeNull();
});

test('a wall that holds no bottles cannot be created, and the form says why', () => {
  wallOn = true;
  const { container } = render(<Page onCreate={vi.fn()} />);
  fireEvent.click(typeButton('racks.type_wall'));
  for (const label of ['A1', 'B1', 'A2', 'B2']) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Box ${label},`) }));
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
  }
  expect(container.querySelector('button[type="submit"]').disabled).toBe(true);
  expect(screen.getByText(/Add a box that holds bottles/)).toBeTruthy();
});
