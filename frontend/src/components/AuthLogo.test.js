import { render, screen } from '@testing-library/react';
import AuthLogo from './AuthLogo';

// Verify email, reset password and the delete-account link page used an old
// drawn logo whose name was cut off on phones (":ELLARION"); every sign-in
// style card now shows the current logo, the one log in and register use.
test('shows the current Cellarion logo, WebP with a PNG fallback', () => {
  const { container } = render(<AuthLogo />);
  const img = screen.getByAltText('Cellarion');
  expect(img.getAttribute('src')).toBe('/cellarion-logo-light.png');
  expect(img).toHaveClass('login-logo');
  expect(container.querySelector('source').getAttribute('srcset')).toBe('/cellarion-logo-light.webp');
});
