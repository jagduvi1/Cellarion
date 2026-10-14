/**
 * What a curator-question notification opens (support ticket 2026-10-14): on
 * to a bottle page the member can open now, or the question on its own page
 * when no bottle of the wine is left; a closed question says so.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { apiFetchMock, navigateMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn(), navigateMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: apiFetchMock }) }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'q1' }),
  useNavigate: () => navigateMock,
  Link: ({ children, to }) => <a href={to}>{children}</a>,
}));
vi.mock('../components/bottle/OwnerInquiryCard', () => ({ default: ({ wineId }) => <div data-testid="card">{wineId}</div> }));

const CuratorQuestion = (await import('./CuratorQuestion')).default;
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const INQUIRY = { _id: 'q1', status: 'open', question: 'What does the back label say?', wine: { _id: 'w1', name: 'Barolo', producer: 'Pira' }, responded: false, curatorReply: null };

beforeEach(() => vi.clearAllMocks());

test('a bottle they can open: straight on to it, replacing this page in history', async () => {
  apiFetchMock.mockResolvedValue(reply(200, { inquiry: { ...INQUIRY, link: '/cellars/c1/bottles/b1' } }));
  render(<CuratorQuestion />);
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/c1/bottles/b1', { replace: true }));
  expect(apiFetchMock).toHaveBeenCalledWith('/api/owner-inquiries/q1');
});

test('no bottle of the wine left: the question on its own page, still answerable', async () => {
  apiFetchMock.mockResolvedValue(reply(200, { inquiry: { ...INQUIRY, link: null } }));
  render(<CuratorQuestion />);
  expect(await screen.findByText('A curator’s question')).toBeInTheDocument();
  expect(screen.getByText('Pira — Barolo')).toBeInTheDocument();
  expect(screen.getByTestId('card')).toHaveTextContent('w1');
  expect(navigateMock).not.toHaveBeenCalled();
});

test('answered and waiting for the curators: a thank-you instead of silence', async () => {
  apiFetchMock.mockResolvedValue(reply(200, { inquiry: { ...INQUIRY, link: null, responded: true } }));
  render(<CuratorQuestion />);
  expect(await screen.findByText(/You answered this question/)).toBeInTheDocument();
});

test('closed, or not addressed to them: said plainly, with a way back', async () => {
  apiFetchMock.mockResolvedValue(reply(404, { error: 'Inquiry not found' }));
  render(<CuratorQuestion />);
  expect(await screen.findByText('This question is closed')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Go to your cellars' })).toHaveAttribute('href', '/cellars');
});

test('a network failure offers a retry that asks again', async () => {
  apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(reply(200, { inquiry: { ...INQUIRY, link: '/cellars/c1/bottles/b1' } }));
  render(<CuratorQuestion />);
  expect(await screen.findByText('Could not load the question.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/c1/bottles/b1', { replace: true }));
  expect(apiFetchMock).toHaveBeenCalledTimes(2);
});
