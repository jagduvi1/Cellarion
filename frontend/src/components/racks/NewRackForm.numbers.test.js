import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => {
  const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});
vi.mock('../../utils/featureFlags', () => ({ useFeature: () => false }));
vi.mock('../BetaBadge', () => ({ default: () => null }));

const NewRackForm = (await import('./NewRackForm')).default;

// The racks page owns the rack being typed; the submit hands over what it holds.
function Page({ onSubmit }) {
  const [newRack, setNewRack] = useState({ name: 'Fridge', type: 'grid', rows: 4, cols: 8, typeConfig: {} });
  return (
    <NewRackForm
      newRack={newRack}
      setNewRack={setNewRack}
      onTypeChange={() => {}}
      onSubmit={(e) => { e.preventDefault(); onSubmit(newRack); }}
      saving={false}
    />
  );
}
const inputFor = (label) => screen.getByText(label).closest('.form-group').querySelector('input');

test('rows and columns of a new rack can be cleared and typed over, as on a phone keyboard', () => {
  const onSubmit = vi.fn();
  const { container } = render(<Page onSubmit={onSubmit} />);
  const rows = inputFor('racks.rowsLabel');
  const cols = inputFor('racks.colsLabel');

  fireEvent.change(rows, { target: { value: '' } });
  expect(rows).toHaveValue(null);
  fireEvent.change(rows, { target: { value: '6' } });
  fireEvent.blur(rows);
  fireEvent.change(cols, { target: { value: '' } });
  fireEvent.change(cols, { target: { value: '3' } });

  fireEvent.submit(container.querySelector('form'));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ rows: 6, cols: 3 }));
});
