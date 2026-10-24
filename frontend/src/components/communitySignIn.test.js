/**
 * The sign-in links an anonymous reader meets on community pages carry the
 * page they are on in router state — the one place Login reads a return path
 * from (state.from; a ?next= parameter is deliberately never read) — so
 * signing in brings them back to the thread or wine they were reading.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// Stable identities: apiFetch is an effect dependency in the wine panel.
const { i18n, auth } = vi.hoisted(() => ({
  i18n: { t: (key) => key },
  auth: { user: null, apiFetch: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./DiscussionCard', () => ({ default: () => null }));
vi.mock('../api/wines', () => ({
  getWineDiscussions: vi.fn(async () => ({ ok: true, json: async () => ({ discussions: [], total: 0 }) })),
}));

const CommunityCTA = (await import('./CommunityCTA')).default;
const WatchThreadButton = (await import('./WatchThreadButton')).default;
const WineDiscussionsPanel = (await import('./WineDiscussionsPanel')).default;

function LoginProbe() {
  const { search, state } = useLocation();
  return <div data-testid="login">{JSON.stringify({ search, from: state?.from ?? null })}</div>;
}

function renderAt(url, path, element) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={path} element={element} />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function landOnLogin(linkName) {
  fireEvent.click(await screen.findByRole('link', { name: linkName }));
  return JSON.parse(screen.getByTestId('login').textContent);
}

describe('sign-in links on community pages', () => {
  it('CommunityCTA returns to the current page, query included', async () => {
    renderAt('/community/discussions/x?y=1', '/community/discussions/:id', <CommunityCTA />);
    expect(await landOnLogin('discussions.signIn')).toEqual({
      search: '',
      from: '/community/discussions/x?y=1',
    });
  });

  it('WatchThreadButton returns to the thread', async () => {
    renderAt('/community/discussions/x?y=1', '/community/discussions/:id', <WatchThreadButton idOrSlug="x" />);
    expect(await landOnLogin(/discussions\.signInToFollow/)).toEqual({
      search: '',
      from: '/community/discussions/x?y=1',
    });
  });

  it('WineDiscussionsPanel returns to the wine page', async () => {
    renderAt('/wines/some-wine', '/wines/:id', <WineDiscussionsPanel wine={{ _id: 'w1', slug: 'some-wine' }} />);
    expect(await landOnLogin('wineDiscussions.signInToStart')).toEqual({
      search: '',
      from: '/wines/some-wine',
    });
  });
});
