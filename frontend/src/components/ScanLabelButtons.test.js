import { render, screen, fireEvent } from '@testing-library/react';
import ScanLabelButtons from './ScanLabelButtons';

// A label can be scanned from a photo already on the phone (a gallery picture
// or a shop screenshot), not only with the camera. Both pages that scan labels
// (Add bottle, Add to wishlist) show these two buttons.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }));

test('the camera button opens the camera', () => {
  const onCamera = vi.fn();
  render(<ScanLabelButtons cameraLabel="Start Camera" onCamera={onCamera} onFile={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Start Camera' }));

  expect(onCamera).toHaveBeenCalledTimes(1);
});

test('"Choose a photo" opens the file picker for images only', () => {
  render(<ScanLabelButtons cameraLabel="Start Camera" onCamera={vi.fn()} onFile={vi.fn()} />);
  const input = screen.getByTestId('scan-label-file');
  const click = vi.spyOn(input, 'click');

  fireEvent.click(screen.getByRole('button', { name: 'camera.choosePhoto' }));

  expect(click).toHaveBeenCalledTimes(1);
  expect(input).toHaveAttribute('accept', 'image/*');
  // No `capture`: the phone offers its gallery, not only the camera.
  expect(input).not.toHaveAttribute('capture');
});

test('a chosen photo is handed on, and the same photo can be chosen again', () => {
  const onFile = vi.fn();
  render(<ScanLabelButtons cameraLabel="Start Camera" onCamera={vi.fn()} onFile={onFile} />);
  const input = screen.getByTestId('scan-label-file');
  const photo = new File(['x'], 'label.jpg', { type: 'image/jpeg' });

  fireEvent.change(input, { target: { files: [photo] } });

  expect(onFile).toHaveBeenCalledWith(photo);
  expect(input.value).toBe('');
});
