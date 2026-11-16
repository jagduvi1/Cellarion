import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RegistryContributionsBlock from './RegistryContributionsBlock';

// WHY THIS TEST EXISTS: "Contribute all" sends every wine made on the install
// to cellarion.app under the key owner's account, so it takes a second,
// explicit step that says so; and the block must tell the admin what became of
// earlier offers, with the registry's reason for each one that needs a person.

vi.mock('react-i18next', () => {
  const t = (key, fallback, vars) => {
    if (typeof fallback !== 'string') return key;
    return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] !== undefined ? String(vars[k]) : ''));
  };
  return { useTranslation: () => ({ t }) };
});

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch, user: { roles: ['admin'] } }) }));

const ok = (body, status = 200) => Promise.resolve({ ok: status < 400, status, headers: { get: () => null }, json: () => Promise.resolve(body) });
const renderBlock = () => render(<MemoryRouter><RegistryContributionsBlock /></MemoryRouter>);
const empty = { queued: 0, sent: 0, declined: 0, duplicate: 0, failed: 0 };

beforeEach(() => apiFetch.mockReset());

describe('RegistryContributionsBlock (Settings, self-hosted admins)', () => {
  test('nothing to say: not connected, or nothing made here and nothing offered', async () => {
    apiFetch.mockImplementation(() => ok({ enabled: true, offerable: 0, counts: empty, attention: [] }));
    const { container } = renderBlock();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('"Contribute all" asks once more, says under whose account, then queues and reports', async () => {
    apiFetch
      .mockImplementationOnce(() => ok({ enabled: true, offerable: 60, counts: empty, attention: [] }))
      .mockImplementationOnce(() => ok({ queued: 60 }, 202))
      .mockImplementationOnce(() => ok({ enabled: true, offerable: 0, counts: { ...empty, queued: 50, sent: 10 }, attention: [] }));
    renderBlock();
    fireEvent.click(await screen.findByRole('button', { name: 'Contribute all 60' }));
    expect(screen.getByText(/under the cellarion\.app account that owns this install's key/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Offer them' }));
    expect(await screen.findByText(/60 wines offered/)).toBeInTheDocument();
    const [url, init] = apiFetch.mock.calls[1];
    expect(url).toBe('/api/bridge/contributions');
    expect(JSON.parse(init.body)).toEqual({ all: true });
    expect(screen.getByText('50 waiting to be sent · 10 waiting for review on cellarion.app')).toBeInTheDocument();
  });

  test('cancel leaves everything as it was', async () => {
    apiFetch.mockImplementation(() => ok({ enabled: true, offerable: 3, counts: empty, attention: [] }));
    renderBlock();
    fireEvent.click(await screen.findByRole('button', { name: 'Contribute all 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Contribute all 3' })).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  test('offers that need a person are listed with the registry\'s reason and a link to the wine', async () => {
    apiFetch.mockImplementation(() => ok({
      enabled: true, offerable: 0, counts: { ...empty, declined: 1, duplicate: 1 },
      attention: [
        { id: 'a'.repeat(24), name: 'Clos Example', producer: 'Domaine Example', slug: 'clos-example', status: 'declined', notes: 'No trace of this cuvée.' },
        { id: 'b'.repeat(24), name: 'Les Champs', producer: 'Domaine Example', slug: null, status: 'duplicate', duplicateOf: 'c'.repeat(24) },
      ],
    }));
    renderBlock();
    expect(await screen.findByText(/declined: No trace of this cuvée\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clos Example' })).toHaveAttribute('href', '/wines/clos-example');
    expect(screen.getByRole('link', { name: 'Les Champs' })).toHaveAttribute('href', `/wines/${'b'.repeat(24)}`);
    expect(screen.getByText(/already has its copy/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
