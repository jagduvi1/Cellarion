import { render, screen, fireEvent } from '@testing-library/react';
import PreservationPickerModal from './PreservationPickerModal';

// "Just a glass" from a rack slot: the dialog asks how the bottle is kept and
// whether it leaves its slot. The box follows the method (Coravin stays in
// the rack, the others come out) until the user ticks or unticks it.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

const box = () => screen.getByRole('checkbox', { name: /openBottle\.takeOut\b/ });
const pick = (id) => fireEvent.click(screen.getByRole('radio', { name: new RegExp(`openBottle\\.method\\.${id}\\b`) }));

test('the box follows the method until the user chooses; Open reports both', () => {
  const onConfirm = vi.fn();
  render(<PreservationPickerModal onConfirm={onConfirm} onClose={() => {}} busy={false} />);

  expect(box()).not.toBeChecked(); // Coravin, preselected: back into its slot
  pick('recorked');
  expect(box()).toBeChecked();
  pick('vacuum');
  expect(box()).toBeChecked();

  fireEvent.click(box()); // the user's own answer now holds
  expect(box()).not.toBeChecked();
  pick('inert-gas');
  expect(box()).not.toBeChecked();

  fireEvent.click(screen.getByRole('button', { name: 'openBottle.partialConfirmBtn' }));
  expect(onConfirm).toHaveBeenCalledWith('inert-gas', false);
});

test('Coravin left alone opens without taking the bottle out', () => {
  const onConfirm = vi.fn();
  render(<PreservationPickerModal onConfirm={onConfirm} onClose={() => {}} busy={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'openBottle.partialConfirmBtn' }));
  expect(onConfirm).toHaveBeenCalledWith('coravin', false);
});
