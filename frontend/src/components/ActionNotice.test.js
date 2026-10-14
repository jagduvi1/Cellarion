import { render, screen, fireEvent } from '@testing-library/react';
import ActionNotice from './ActionNotice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, fallback) => (typeof fallback === 'string' ? fallback : k) }),
}));

test('says the message as an alert and can be dismissed', () => {
  const onDismiss = vi.fn();
  render(<ActionNotice message="The bottle could not be placed." onDismiss={onDismiss} />);

  expect(screen.getByRole('alert')).toHaveTextContent('The bottle could not be placed.');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('renders nothing without a message', () => {
  const { container } = render(<ActionNotice message={null} onDismiss={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});
