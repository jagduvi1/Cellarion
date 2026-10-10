import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The reviews of a wine, shared by the bottle page and the vintage page: this
// vintage first, then all vintages on request; everyone / mine / following;
// "Write a Review" defaults to the vintage; after a review is saved the list
// reloads and the stored average is dropped rather than shown stale.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key }) }));
let api;
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: api, user: { preferences: { ratingScale: '5' } } }) }));
vi.mock('../ReviewCard', () => ({ default: ({ review }) => <div data-testid="review">{review._id}</div> }));
vi.mock('../ReviewForm', () => ({
  default: ({ defaultVintage, onSaved, onClose }) => (
    <button type="button" onClick={() => { onSaved(); onClose(); }}>review-form:{defaultVintage}</button>
  ),
}));

const { default: WineReviewsCard } = await import('./WineReviewsCard');

const WINE = { _id: 'w1', name: 'Barolo' };
const queryOf = (call) => new URLSearchParams(call[0].split('?')[1]);

beforeEach(() => {
  api = vi.fn(async () => ({ ok: true, json: async () => ({ reviews: [{ _id: 'r1' }], total: 1, pages: 1 }) }));
});

test('loads this vintage\'s reviews first, then all vintages or only mine on request', async () => {
  render(<WineReviewsCard wine={WINE} vintage="2015" communityRating={{ reviewCount: 4, averageNormalized: 80 }} />);
  expect(await screen.findByTestId('review')).toHaveTextContent('r1');
  let q = queryOf(api.mock.calls[0]);
  expect(api.mock.calls[0][0]).toMatch(/^\/api\/reviews\/wine\/w1\?/);
  expect(q.get('vintage')).toBe('2015');
  expect(q.get('audience')).toBe('all');
  expect(screen.getByText('(4)')).toBeInTheDocument();

  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'all' } });
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(queryOf(api.mock.calls[1]).get('vintage')).toBeNull();

  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'mine' } });
  await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
  q = queryOf(api.mock.calls[2]);
  expect(q.get('audience')).toBe('mine');
});

test('"Write a Review" defaults to the vintage; saving reloads the list and drops the stale average', async () => {
  render(<WineReviewsCard wine={WINE} vintage="2015" communityRating={{ reviewCount: 4, averageNormalized: 80 }} />);
  await screen.findByTestId('review');
  fireEvent.click(screen.getByText('reviews.writeReview'));
  fireEvent.click(await screen.findByText('review-form:2015'));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('(4)')).toBeNull();
});

test('an NV wine writes a review with no vintage preset', async () => {
  render(<WineReviewsCard wine={WINE} vintage="NV" />);
  await screen.findByTestId('review');
  fireEvent.click(screen.getByText('reviews.writeReview'));
  expect(await screen.findByText('review-form:')).toBeInTheDocument();
});
