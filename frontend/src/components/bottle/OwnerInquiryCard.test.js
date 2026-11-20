import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/ownerInquiries', () => ({
  getMyOwnerInquiries: vi.fn(),
  respondToOwnerInquiry: vi.fn(),
}));

// The card passes English fallbacks inline — return those, placeholders
// filled, so assertions read like the real UI (the ConnectAi test convention).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, opts) => (typeof fallback === 'string'
      ? fallback.replace(/{{(\w+)}}/g, (_, name) => String(opts?.[name] ?? ''))
      : key),
  }),
}));

const { getMyOwnerInquiries, respondToOwnerInquiry } = await import('../../api/ownerInquiries');
const OwnerInquiryCard = (await import('./OwnerInquiryCard')).default;

const WINE_ID = 'w1';
const INQUIRY = {
  _id: 'i1',
  status: 'open',
  question: 'What does the label say the producer is?',
  wine: { _id: WINE_ID, name: 'Barolo', producer: 'Pira' },
  bottle: 'b1',
  responded: false,
};

const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  getMyOwnerInquiries.mockResolvedValue(ok({ inquiries: [INQUIRY] }));
});

const renderCard = () => render(<MemoryRouter><OwnerInquiryCard apiFetch={vi.fn()} wineId={WINE_ID} /></MemoryRouter>);

test('renders the curator question fetched for this wine', async () => {
  renderCard();
  expect(await screen.findByText('What does the label say the producer is?')).toBeInTheDocument();
  expect(screen.getByText('A curator has a question about this wine')).toBeInTheDocument();
  expect(getMyOwnerInquiries).toHaveBeenCalledWith(expect.any(Function), WINE_ID);
});

test('renders NOTHING when there is no inquiry, or when the viewer already answered', async () => {
  getMyOwnerInquiries.mockResolvedValue(ok({ inquiries: [] }));
  const { container, unmount } = renderCard();
  await waitFor(() => expect(getMyOwnerInquiries).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
  unmount();

  // Answered but not yet replied to: nothing to show — the curator has not
  // come back yet, and "you answered this" is not news to the answerer.
  getMyOwnerInquiries.mockResolvedValue(ok({ inquiries: [{ ...INQUIRY, responded: true, myResponse: 'said it already' }] }));
  const { container: c2 } = renderCard();
  await waitFor(() => expect(getMyOwnerInquiries).toHaveBeenCalledTimes(2));
  expect(c2).toBeEmptyDOMElement();
});

// The reply half of the loop: an owner who reads a back label for us gets to
// see what it changed, instead of the card silently disappearing on resolve.
const REPLIED = {
  ...INQUIRY,
  status: 'resolved',
  responded: true,
  myResponse: 'Front label reads E. Pira e Figli.',
  curatorReply: 'Thank you — the producer is now recorded as E. Pira e Figli.',
  resolvedAt: '2026-08-12T00:00:00.000Z',
};

test('a resolved inquiry the viewer answered shows the question, their answer and the curator reply — read-only', async () => {
  getMyOwnerInquiries.mockResolvedValue(ok({ inquiries: [REPLIED] }));
  renderCard();

  expect(await screen.findByText('A curator replied about this wine')).toBeInTheDocument();
  expect(screen.getByText('What does the label say the producer is?')).toBeInTheDocument();
  expect(screen.getByText('Front label reads E. Pira e Figli.')).toBeInTheDocument();
  expect(screen.getByText('Thank you — the producer is now recorded as E. Pira e Figli.')).toBeInTheDocument();
  // Nothing to submit here — the answer was single-shot and is already in.
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByText('Send answer')).not.toBeInTheDocument();
});

test('an unanswered question outranks a reply — the one that still needs them wins the card', async () => {
  getMyOwnerInquiries.mockResolvedValue(ok({ inquiries: [REPLIED, INQUIRY] }));
  renderCard();

  expect(await screen.findByText('A curator has a question about this wine')).toBeInTheDocument();
  expect(screen.queryByText('A curator replied about this wine')).not.toBeInTheDocument();
});

test('submit interlock: empty answer disabled, in-flight shows Sending and blocks, then the thanks state replaces the form', async () => {
  let release;
  respondToOwnerInquiry.mockReturnValue(new Promise((resolve) => {
    release = () => resolve(ok({ message: 'ok', status: 'answered' }));
  }));
  renderCard();
  await screen.findByText('What does the label say the producer is?');

  // Nothing typed yet → the send button is disabled (no empty submits).
  const send = screen.getByText('Send answer');
  expect(send).toBeDisabled();

  fireEvent.change(screen.getByPlaceholderText(/The label says/), {
    target: { value: 'Front label reads E. Pira e Figli.' },
  });
  expect(send).not.toBeDisabled();
  fireEvent.click(send);

  // In flight: the button swaps to the pending label and stays disabled.
  expect(await screen.findByText('Sending…')).toBeDisabled();
  expect(respondToOwnerInquiry).toHaveBeenCalledWith(expect.any(Function), 'i1', 'Front label reads E. Pira e Figli.');

  release();
  expect(await screen.findByText(/Thank you — your answer was sent/)).toBeInTheDocument();
  // One-shot: the form is gone, no second submit is possible.
  expect(screen.queryByText('Send answer')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('a server refusal surfaces the error and keeps the form usable', async () => {
  respondToOwnerInquiry.mockResolvedValue({ ok: false, json: async () => ({ error: 'This inquiry is no longer open' }) });
  renderCard();
  await screen.findByText('What does the label say the producer is?');

  fireEvent.change(screen.getByPlaceholderText(/The label says/), { target: { value: 'An answer' } });
  fireEvent.click(screen.getByText('Send answer'));

  expect(await screen.findByText('This inquiry is no longer open')).toBeInTheDocument();
  expect(screen.getByText('Send answer')).toBeInTheDocument(); // still submittable
});

test('a terminal 409 (already answered / closed) hides the form — no retry that can only 409 again', async () => {
  respondToOwnerInquiry.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'You already answered this inquiry' }) });
  renderCard();
  await screen.findByText('What does the label say the producer is?');

  fireEvent.change(screen.getByPlaceholderText(/The label says/), { target: { value: 'An answer' } });
  fireEvent.click(screen.getByText('Send answer'));

  expect(await screen.findByText('You already answered this inquiry')).toBeInTheDocument();
  expect(screen.queryByText('Send answer')).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText(/The label says/)).not.toBeInTheDocument();
});

// On the bottle page the card is the one place the member meets a question,
// so it leads on to all of them — quietly, under the question or the reply.
test('a card that found its own question links to the list of every question', async () => {
  const { unmount } = renderCard();
  expect(await screen.findByRole('link', { name: 'All questions from the curators' })).toHaveAttribute('href', '/questions');
  unmount();

  getMyOwnerInquiries.mockResolvedValue(ok({ inquiries: [REPLIED] }));
  renderCard();
  await screen.findByText('A curator replied about this wine');
  expect(screen.getByRole('link', { name: 'All questions from the curators' })).toHaveAttribute('href', '/questions');
});

test('a card handed its question (the question page, the list) has no link of its own', () => {
  render(<MemoryRouter><OwnerInquiryCard apiFetch={vi.fn()} wineId={WINE_ID} inquiry={INQUIRY} /></MemoryRouter>);
  expect(screen.getByText(INQUIRY.question)).toBeInTheDocument();
  expect(screen.queryByRole('link')).toBeNull();
});

// The question page hands the card the question the
// notification was about, with its own intro when the member has no bottle left.
test('a given question is shown as is, with no lookup, and its own intro line', async () => {
  const apiFetch = vi.fn();
  render(<OwnerInquiryCard apiFetch={apiFetch} wineId={WINE_ID} inquiry={INQUIRY} intro="You have no bottle of this wine any more." />);
  expect(screen.getByText(INQUIRY.question)).toBeInTheDocument();
  expect(screen.getByText('You have no bottle of this wine any more.')).toBeInTheDocument();
  expect(getMyOwnerInquiries).not.toHaveBeenCalled();
});

// The list holds many cards under its own headings: each one's heading nests
// at the level the page gives, and each answer box says which wine it is for.
test('heading level: h2 by default (the bottle page), the level a page asks for otherwise', async () => {
  const { unmount } = renderCard();
  expect(await screen.findByRole('heading', { level: 2, name: 'A curator has a question about this wine' })).toBeInTheDocument();
  unmount();

  render(<MemoryRouter><OwnerInquiryCard apiFetch={vi.fn()} wineId={WINE_ID} inquiry={INQUIRY} headingLevel={4} /></MemoryRouter>);
  expect(screen.getByRole('heading', { level: 4, name: 'A curator has a question about this wine' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  cleanup();

  render(<MemoryRouter><OwnerInquiryCard apiFetch={vi.fn()} wineId={WINE_ID} inquiry={REPLIED} headingLevel={3} /></MemoryRouter>);
  expect(screen.getByRole('heading', { level: 3, name: 'A curator replied about this wine' })).toBeInTheDocument();
});

test('the answer box is named by more than its placeholder: with the wine when the card was handed a question', async () => {
  const { unmount } = renderCard();
  expect(await screen.findByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();
  unmount();

  render(<MemoryRouter><OwnerInquiryCard apiFetch={vi.fn()} wineId={WINE_ID} inquiry={INQUIRY} /></MemoryRouter>);
  expect(screen.getByRole('textbox', { name: 'Your answer about Pira — Barolo' })).toBeInTheDocument();
});

test('onAnswered fires once, with the answer sent, only when the server accepted it', async () => {
  const onAnswered = vi.fn();
  respondToOwnerInquiry.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'A response is required' }) });
  render(<MemoryRouter><OwnerInquiryCard apiFetch={vi.fn()} wineId={WINE_ID} inquiry={INQUIRY} onAnswered={onAnswered} /></MemoryRouter>);

  fireEvent.change(screen.getByRole('textbox'), { target: { value: ' Front label reads E. Pira. ' } });
  fireEvent.click(screen.getByText('Send answer'));
  expect(await screen.findByText('A response is required')).toBeInTheDocument();
  expect(onAnswered).not.toHaveBeenCalled();

  respondToOwnerInquiry.mockResolvedValueOnce(ok({ message: 'ok', status: 'answered' }));
  fireEvent.click(screen.getByText('Send answer'));
  expect(await screen.findByText(/Thank you — your answer was sent/)).toBeInTheDocument();
  expect(onAnswered).toHaveBeenCalledTimes(1);
  expect(onAnswered).toHaveBeenCalledWith('Front label reads E. Pira.');
});
