import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../api/ownerInquiries', () => ({
  getMyOwnerInquiries: vi.fn(),
  respondToOwnerInquiry: vi.fn(),
}));

// The card passes English fallbacks inline — return those so assertions read
// like the real UI (the ConnectAi test convention).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
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

const renderCard = () => render(<OwnerInquiryCard apiFetch={vi.fn()} wineId={WINE_ID} />);

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
