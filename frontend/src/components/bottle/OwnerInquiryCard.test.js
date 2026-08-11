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

  // Respond-or-ignore: an answered inquiry never re-renders the card.
  getMyOwnerInquiries.mockResolvedValue(ok({ inquiries: [{ ...INQUIRY, responded: true, myResponse: 'said it already' }] }));
  const { container: c2 } = renderCard();
  await waitFor(() => expect(getMyOwnerInquiries).toHaveBeenCalledTimes(2));
  expect(c2).toBeEmptyDOMElement();
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
