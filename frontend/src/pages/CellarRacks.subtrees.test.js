import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The racks page draws five parts of its own below the racks: the new-rack
// form (with the cabinet shape fields), the three slot popups and the NFC
// dialog. Each one's markup is pinned here as a snapshot, so that moving a
// part to a file of its own can be shown to change nothing: the snapshots
// must come out the same, without an update.
//
// What the parts DO is pinned elsewhere (the slot picker, taking a bottle
// out, moving one); this file is only about what they render.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('../components/CellarNav', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));
vi.mock('../utils/featureFlags', () => ({ useFeature: () => false }));
// The 3D preview loads three.js; the form only has to show where it goes.
vi.mock('../components/racks/ShelfView3D', () => ({ default: () => <div>shelf-view-3d</div> }));
// The type picker draws a small rack for every type: a component of its own,
// and far more markup than the form around it. Its place is kept by the type
// in use and one button to change it; what each type asks for stays real.
vi.mock('../components/racks/RackTypeSelector', async (importOriginal) => ({
  ...(await importOriginal()),
  default: ({ value, onChange }) => (
    <div data-rack-type={value}>
      <button type="button" onClick={() => onChange('cabinet')}>choose-cabinet</button>
    </div>
  ),
}));
// The drawn rack is beside the point: one button per position and one for the
// rack's NFC action, each wired to the page's own handler. The form's preview
// draws through the same component, so it shows up as the rack's dimensions.
vi.mock('../components/racks/RackRenderer', () => ({
  default: ({ rack, onSlotClick, onNfcLink }) => (
    <div data-rack={`${rack.type || 'grid'} ${rack.rows}x${rack.cols}`}>
      {onNfcLink && <button type="button" onClick={onNfcLink}>nfc-link</button>}
      {rack._id && Array.from({ length: rack.rows * rack.cols }, (_, i) => i + 1).map((p) => {
        const s = (rack.slots || []).find((x) => x.position === p);
        return (
          <button key={p} type="button" onClick={() => onSlotClick(p, s || null)}>
            {`slot-${p}`}
          </button>
        );
      })}
    </div>
  ),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bottle = (id, name) => ({
  _id: id, vintage: '2015', status: 'active',
  wineDefinition: { _id: `w-${id}`, name, producer: 'Domaine Exemple', type: 'red' },
});
// One rack of three positions: a bottle, a position marked unusable, a free one.
const rack = () => ({
  _id: 'r1', name: 'Left wall', type: 'grid', rows: 1, cols: 3, cellar: 'c1',
  slots: [{ position: 1, bottle: bottle('b9', 'Cuvée Exemple') }],
  zones: [], disabledPositions: [2],
});

beforeEach(() => {
  const api = vi.fn(async (url) => {
    if (url === '/api/cellars/c1') return ok({ cellar: { _id: 'c1', name: 'Home', userRole: 'owner' } });
    if (url === '/api/racks?cellar=c1') return ok({ racks: [rack()] });
    // The empty slot's picker: the cellar's unplaced bottles.
    if (url.startsWith('/api/cellars/c1?')) return ok({ bottles: { items: [bottle('b1', 'Château Exemple')] } });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5' } } };
});

const { default: CellarRacks } = await import('./CellarRacks');
const renderPage = async () => {
  const view = render(
    <MemoryRouter initialEntries={['/cellars/c1/racks']}>
      <Routes>
        <Route path="/cellars/:id/racks" element={<CellarRacks />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'slot-1' });
  return view;
};
const openSlot = (position) => {
  fireEvent.click(screen.getByRole('button', { name: `slot-${position}` }));
  return screen.getByRole('dialog');
};

describe('the new-rack form', () => {
  const openForm = async () => {
    const { container } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '+ racks.newRack' }));
    return container.querySelector('.new-rack-section');
  };

  test('for a grid, the type the form opens on', async () => {
    const form = await openForm();

    expect(form).toMatchSnapshot();
  });

  test('for a wine cabinet, with its shape fields', async () => {
    const form = await openForm();
    fireEvent.click(within(form).getByRole('button', { name: 'choose-cabinet' }));

    expect(form).toMatchSnapshot();
  });
});

describe('the slot popups', () => {
  test('a slot with a bottle', async () => {
    await renderPage();

    expect(openSlot(1)).toMatchSnapshot();
  });

  test('a position marked unusable', async () => {
    await renderPage();

    expect(openSlot(2)).toMatchSnapshot();
  });

  test('a free slot, once its picker has listed the unplaced bottles', async () => {
    await renderPage();
    const dialog = openSlot(3);
    await within(dialog).findByText(/Château Exemple/);

    expect(dialog).toMatchSnapshot();
  });
});

describe('the NFC dialog', () => {
  test('on a device that cannot write tags', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'nfc-link' }));

    expect(screen.getByRole('dialog')).toMatchSnapshot();
  });
});
