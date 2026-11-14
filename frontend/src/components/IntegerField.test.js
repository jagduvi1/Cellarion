import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import IntegerField from './IntegerField';

// The owner keeps the committed number, as the rack and add-bottle forms do.
function Owner({ initial = 4, min = 1, max = 20, onCommit = () => {} }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <IntegerField aria-label="rows" min={min} max={max} value={value} onCommit={(n) => { onCommit(n); setValue(n); }} />
      <output data-testid="committed">{String(value)}</output>
    </>
  );
}
const field = () => screen.getByLabelText('rows');
const committed = () => screen.getByTestId('committed').textContent;

test('clearing the field and typing a new number keeps the typed number', () => {
  render(<Owner initial={4} />);
  fireEvent.change(field(), { target: { value: '' } });
  expect(field()).toHaveValue(null);
  expect(committed()).toBe('4');
  fireEvent.change(field(), { target: { value: '6' } });
  expect(field()).toHaveValue(6);
  expect(committed()).toBe('6');
  fireEvent.blur(field());
  expect(field()).toHaveValue(6);
  expect(committed()).toBe('6');
});

test('an empty field on blur restores the last valid value', () => {
  const onCommit = vi.fn();
  render(<Owner initial={8} onCommit={onCommit} />);
  fireEvent.change(field(), { target: { value: '' } });
  fireEvent.blur(field());
  expect(field()).toHaveValue(8);
  expect(committed()).toBe('8');
  expect(onCommit).not.toHaveBeenCalled();
});

test('a number below the minimum is not committed while typing and is raised to the minimum on blur', () => {
  render(<Owner initial={3} min={1} />);
  fireEvent.change(field(), { target: { value: '0' } });
  expect(committed()).toBe('3');
  fireEvent.blur(field());
  expect(field()).toHaveValue(1);
  expect(committed()).toBe('1');
});

test('a number past the maximum becomes the maximum at once, so a submit without blur stays in range', () => {
  render(<Owner initial={2} max={20} />);
  fireEvent.change(field(), { target: { value: '25' } });
  expect(field()).toHaveValue(20);
  expect(committed()).toBe('20');
});

test('a value set from outside replaces the text', () => {
  const { rerender } = render(<IntegerField aria-label="rows" min={1} max={20} value={4} onCommit={() => {}} />);
  rerender(<IntegerField aria-label="rows" min={1} max={20} value={5} onCommit={() => {}} />);
  expect(field()).toHaveValue(5);
});
