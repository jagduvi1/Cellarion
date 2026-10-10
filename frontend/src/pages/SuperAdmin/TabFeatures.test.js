import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// SuperAdmin → Feature flags: each flagged feature's state moves between off,
// beta and everyone without a deploy; the forum thread link is saved on its
// own; the notices the server sent are reported back.

const apiFetch = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));
const getFeatures = vi.fn();
const saveFeature = vi.fn();
vi.mock('../../api/admin', () => ({
  superadminGetFeatures: (...a) => getFeatures(...a),
  superadminSaveFeature: (...a) => saveFeature(...a),
}));

const { default: TabFeatures } = await import('./TabFeatures');

const json = (body, ok = true) => ({ ok, json: async () => body });
const FLAG = {
  key: 'vintagePage', title: 'One page per wine and vintage', state: 'beta',
  betaAt: '2026-10-10T08:00:00.000Z', releasedAt: null, forumPath: null, feedback: { total: 2, open: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  getFeatures.mockResolvedValue(json({ optedIn: 4, features: [FLAG] }));
});

const renderTab = () => render(<MemoryRouter><TabFeatures /></MemoryRouter>);

test('lists each flag with its state, its feedback and a link to that feedback in the queue', async () => {
  renderTab();
  expect(await screen.findByText('One page per wine and vintage')).toBeInTheDocument();
  expect(screen.getByText(/4 members try new features early/)).toBeInTheDocument();
  expect(screen.getByLabelText('State of One page per wine and vintage')).toHaveValue('beta');
  expect(screen.getByText(/2 tickets · 1 not closed/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'open in the support queue' })).toHaveAttribute('href', '/admin/support?category=beta&feature=vintagePage');
});

test('moving a flag saves its state and reports who was told', async () => {
  saveFeature.mockResolvedValue(json({ feature: { ...FLAG, state: 'everyone' }, notified: { announced: 0, thanked: 2 } }));
  renderTab();
  fireEvent.change(await screen.findByLabelText('State of One page per wine and vintage'), { target: { value: 'everyone' } });
  await waitFor(() => expect(saveFeature).toHaveBeenCalledWith(apiFetch, 'vintagePage', { state: 'everyone' }));
  expect(await screen.findByText(/thanked 2 feedback senders/)).toBeInTheDocument();
  expect(getFeatures).toHaveBeenCalledTimes(2); // reloaded after the save
});

test('the forum link is saved on its own; a refusal shows the server\'s reason', async () => {
  saveFeature.mockResolvedValue(json({ error: 'forumPath must point to a page on this site' }, false));
  renderTab();
  const input = await screen.findByLabelText('Forum thread for One page per wine and vintage');
  const save = screen.getByRole('button', { name: 'Save link' });
  expect(save).toBeDisabled();
  fireEvent.change(input, { target: { value: 'https://elsewhere.example.com/x' } });
  fireEvent.click(save);
  await waitFor(() => expect(saveFeature).toHaveBeenCalledWith(apiFetch, 'vintagePage', { forumPath: 'https://elsewhere.example.com/x' }));
  expect(await screen.findByText('forumPath must point to a page on this site')).toBeInTheDocument();
});
