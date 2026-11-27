import { render, screen } from '@testing-library/react';

// The done screen's lines about wines a curator still looks at. The bottles
// are in the cellar either way, so each is one plain line, shown only when
// its count is above zero.

vi.mock('react-i18next', () => {
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  return { useTranslation: () => ({ t }) };
});

const ImportCurationNotes = (await import('./ImportCurationNotes')).default;

test('nothing to say: nothing rendered', () => {
  const { container } = render(<ImportCurationNotes result={{ created: 12, pendingIdentityCount: 0 }} />);
  expect(container).toBeEmptyDOMElement();
  expect(render(<ImportCurationNotes result={null} />).container).toBeEmptyDOMElement();
});

test('photos still being copied in get their line, on their own too', () => {
  render(<ImportCurationNotes result={{ photosQueued: 7 }} />);
  expect(screen.getByText('importBottles.done.photosQueuedNote:{"n":7}')).toBeInTheDocument();
  expect(screen.queryByText(/pendingIdentityNote|uncheckedNote/)).not.toBeInTheDocument();
});

test('wines that could not be identified get their line', () => {
  render(<ImportCurationNotes result={{ pendingIdentityCount: 3 }} />);
  expect(screen.getByText('importBottles.done.pendingIdentityNote:{"n":3}')).toBeInTheDocument();
  expect(screen.queryByText(/uncheckedNote/)).not.toBeInTheDocument();
});

test('new wines a curator checks first get theirs, beside the other when both apply', () => {
  render(<ImportCurationNotes result={{ pendingIdentityCount: 1, uncheckedCount: 40 }} />);
  expect(screen.getByText('importBottles.done.pendingIdentityNote:{"n":1}')).toBeInTheDocument();
  expect(screen.getByText('importBottles.done.uncheckedNote:{"n":40}')).toBeInTheDocument();
});
