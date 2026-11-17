import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// A new review can start from what the user already wrote (a drunk bottle's
// rating and note) and be linked to that bottle. An existing review always
// wins over the prefill, and an edit never sends a bottle.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: vi.fn(), user: { preferences: { ratingScale: '20' } } }) }));
vi.mock('./Modal', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('./RatingInput', () => ({ default: ({ value, scale }) => <span data-testid="rating">{String(value)}/{scale}</span> }));
const createReview = vi.fn();
const updateReview = vi.fn();
vi.mock('../api/reviews', () => ({
  createReview: (...a) => createReview(...a),
  updateReview: (...a) => updateReview(...a),
}));

const { default: ReviewForm } = await import('./ReviewForm');

const ok = (review) => ({ ok: true, json: async () => ({ review }) });

beforeEach(() => {
  createReview.mockReset().mockResolvedValue(ok({ _id: 'rev-new' }));
  updateReview.mockReset().mockResolvedValue(ok({ _id: 'rev-1' }));
});

test('a prefilled new review starts from the rating and note and is linked to the bottle', async () => {
  const onSaved = vi.fn();
  render(
    <ReviewForm wineDefinition="w1" wineName="Barolo" defaultVintage="2016"
      prefill={{ rating: 4.5, ratingScale: '5', overall: 'Cherry, tar.' }} bottleId="b1"
      onClose={() => {}} onSaved={onSaved} />
  );
  expect(screen.getByTestId('rating')).toHaveTextContent('4.5/5');
  expect(screen.getByLabelText('Overall Impression')).toHaveValue('Cherry, tar.');

  fireEvent.submit(screen.getByLabelText('Overall Impression').closest('form'));
  await waitFor(() => expect(createReview).toHaveBeenCalledTimes(1));
  const body = createReview.mock.calls[0][1];
  expect(body).toMatchObject({ wineDefinition: 'w1', bottle: 'b1', rating: 4.5, ratingScale: '5', vintage: '2016' });
  expect(body.tasting.overall).toBe('Cherry, tar.');
  expect(onSaved).toHaveBeenCalledWith({ _id: 'rev-new' });
});

test('without a prefill nothing changes: the user\'s scale, an empty note, no bottle link', async () => {
  render(<ReviewForm wineDefinition="w1" wineName="Barolo" onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByTestId('rating')).toHaveTextContent('null/20');
  expect(screen.getByLabelText('Overall Impression')).toHaveValue('');
});

test('an existing review wins over the prefill, and the edit sends no bottle', async () => {
  const existing = { _id: 'rev-1', rating: 17, ratingScale: '20', vintage: '2016', visibility: 'private', tasting: { overall: 'Shared before' } };
  render(
    <ReviewForm wineDefinition="w1" wineName="Barolo" existingReview={existing}
      prefill={{ rating: 4.5, ratingScale: '5', overall: 'New note' }} bottleId="b1"
      onClose={() => {}} onSaved={() => {}} />
  );
  expect(screen.getByTestId('rating')).toHaveTextContent('17/20');
  expect(screen.getByLabelText('Overall Impression')).toHaveValue('Shared before');

  fireEvent.submit(screen.getByLabelText('Overall Impression').closest('form'));
  await waitFor(() => expect(updateReview).toHaveBeenCalledTimes(1));
  expect(updateReview.mock.calls[0][2]).not.toHaveProperty('bottle');
  expect(createReview).not.toHaveBeenCalled();
});
