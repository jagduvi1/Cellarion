import { render, waitFor } from '@testing-library/react';
import DiscussionComposer from './DiscussionComposer';

// The composer's editor is TipTap's StarterKit, which brings Link and
// Underline itself. Adding the two again registered each twice: TipTap warns
// about it, and which of the two Link set-ups applies (the one that does not
// follow a click while editing, or the kit's default that does) was left to
// the order they happened to be registered in.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, dv) => (typeof dv === 'string' ? dv : key) }),
}));

let warn;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

const duplicateWarnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => /Duplicate extension names/.test(m));

test('every editor extension is registered once', async () => {
  const { container } = render(<DiscussionComposer value="<p>Barolo or Barbaresco?</p>" onChange={() => {}} />);
  await waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull());
  expect(duplicateWarnings()).toEqual([]);
});

test('a link keeps the composer\'s own set-up: a new tab, and no trust passed on', async () => {
  const { container } = render(<DiscussionComposer value={'<p>See <a href="https://example.com/barolo">this producer</a></p>'} onChange={() => {}} />);
  await waitFor(() => expect(container.querySelector('.ProseMirror a')).not.toBeNull());
  const link = container.querySelector('.ProseMirror a');
  expect(link).toHaveAttribute('href', 'https://example.com/barolo');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
});

test('underlined text is still underlined', async () => {
  const { container } = render(<DiscussionComposer value="<p>A <u>very</u> good year</p>" onChange={() => {}} />);
  await waitFor(() => expect(container.querySelector('.ProseMirror u')).not.toBeNull());
  expect(container.querySelector('.ProseMirror u').textContent).toBe('very');
});
