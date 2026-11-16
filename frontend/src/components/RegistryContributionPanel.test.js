import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RegistryContributionPanel from './RegistryContributionPanel';

// WHY THIS TEST EXISTS: the panel is the one place a self-hoster offers a wine
// made on their install to the shared registry. It must stay away where it has
// nothing to say (not connected, a registry copy, a member who cannot act),
// offer only for admins, say plainly what became of an offer, and never
// promise a member an action the server refuses.

vi.mock('react-i18next', () => {
  const t = (key, fallback, vars) => {
    if (typeof fallback !== 'string') return key;
    return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] !== undefined ? String(vars[k]) : ''));
  };
  return { useTranslation: () => ({ t }) };
});

const apiFetch = vi.fn();
const authState = { apiFetch, user: { roles: ['admin'] } };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));

const ok = (body, status = 200) => Promise.resolve({ ok: status < 400, status, headers: { get: () => null }, json: () => Promise.resolve(body) });
const WINE = 'b'.repeat(24);
const renderPanel = () => render(<MemoryRouter><RegistryContributionPanel wineId={WINE} /></MemoryRouter>);

beforeEach(() => { apiFetch.mockReset(); authState.user = { roles: ['admin'] }; });

describe('RegistryContributionPanel (wine page, self-hosted)', () => {
  test('nothing when the install is not connected, or the wine is a registry copy', async () => {
    apiFetch.mockImplementation(() => ok({ enabled: false }));
    const { container, unmount } = renderPanel();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    apiFetch.mockImplementation(() => ok({ enabled: true, linked: true, offerable: false, contribution: null }));
    const second = renderPanel();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });

  test('a member who is not an admin sees nothing for a wine nobody has offered', async () => {
    authState.user = { roles: ['user'] };
    apiFetch.mockImplementation(() => ok({ enabled: true, linked: false, offerable: true, contribution: null }));
    const { container } = renderPanel();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('an admin offers the wine; the page then shows it waiting for review', async () => {
    apiFetch
      .mockImplementationOnce(() => ok({ enabled: true, linked: false, offerable: true, contribution: null }))
      .mockImplementationOnce(() => ok({ queued: 1 }, 202))
      .mockImplementationOnce(() => ok({ enabled: true, linked: false, offerable: false, contribution: { status: 'sent' } }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Contribute to the shared registry' }));
    expect(await screen.findByText(/waiting for review/)).toBeInTheDocument();
    const [url, init] = apiFetch.mock.calls[1];
    expect(url).toBe('/api/bridge/contributions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ wineIds: [WINE] });
    // A sent offer is the registry's to answer: nothing to take back.
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a declined offer shows the reason to every member; an admin may offer it again or dismiss it', async () => {
    authState.user = { roles: ['user'] };
    apiFetch.mockImplementation(() => ok({ enabled: true, linked: false, offerable: true, contribution: { status: 'declined', notes: 'No trace of this cuvée.' } }));
    const { unmount } = renderPanel();
    expect(await screen.findByText('The shared registry declined this wine: No trace of this cuvée.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    authState.user = { roles: ['admin'] };
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Offer it again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  test('a duplicate links to the copy this install already has', async () => {
    apiFetch.mockImplementation(() => ok({ enabled: true, linked: false, offerable: false, contribution: { status: 'duplicate', duplicateOf: 'c'.repeat(24) } }));
    renderPanel();
    expect(await screen.findByRole('link', { name: "Open the registry's copy" })).toHaveAttribute('href', `/wines/${'c'.repeat(24)}`);
  });

  test('a refusal from the server is shown, and the panel stays as it was', async () => {
    apiFetch
      .mockImplementationOnce(() => ok({ enabled: true, linked: false, offerable: true, contribution: null }))
      .mockImplementationOnce(() => ok({ error: 'This install is not connected to the shared registry.', code: 'disabled' }, 404));
    const { container } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Contribute to the shared registry' }));
    await waitFor(() => expect(container.querySelector('.alert-error')).not.toBeNull());
    expect(screen.getByRole('button', { name: 'Contribute to the shared registry' })).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
