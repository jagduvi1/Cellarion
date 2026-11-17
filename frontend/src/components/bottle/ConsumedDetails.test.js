import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// A drunk bottle's rating and note can become a review of the wine in one
// step ("Share as review"), linked to the bottle, so nobody copies and pastes
// a tasting note. Once that review exists the same button edits it instead of
// writing a second one. Only the owner of a bottle they drank sees it; a
// gifted or sold bottle, a bottle with neither rating nor note, a viewer who
// cannot edit and a demo account do not.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key }) }));
let api;
let user;
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: api, user }) }));
vi.mock('../BottleJourney', () => ({ CONSUMED_LABEL_KEYS: { drank: 'drank', gifted: 'gifted', sold: 'sold', other: 'other' } }));
vi.mock('../RatingDisplay', () => ({ default: ({ value }) => <span>rating:{value}</span> }));
vi.mock('../RatingInput', () => ({ default: () => null }));
let formProps;
vi.mock('../ReviewForm', () => ({
  default: (props) => {
    formProps = props;
    return <button type="button" onClick={() => { props.onSaved({ _id: 'rev-new', bottle: props.bottleId }); props.onClose(); }}>save-review</button>;
  },
}));

const { default: ConsumedDetails } = await import('./ConsumedDetails');

const WINE = { _id: 'w1', name: 'Barolo' };
const drunk = (over = {}) => ({
  _id: 'b1', status: 'drank', consumedReason: 'drank', consumedAt: '2026-11-10T00:00:00Z',
  consumedRating: 4.5, consumedRatingScale: '5', consumedNote: 'Cherry, tar, long finish.',
  vintage: '2016', wineDefinition: WINE, ...over,
});
const myReviews = (reviews) => { api = vi.fn(async () => ({ ok: true, json: async () => ({ reviews, total: reviews.length, pages: 1 }) })); };

beforeEach(() => {
  user = { preferences: { ratingScale: '5' } };
  formProps = null;
  myReviews([]);
});

test('"Share as review" opens a new review filled with the rating, the note and the vintage, linked to the bottle', async () => {
  const onReviewSaved = vi.fn();
  render(<ConsumedDetails bottle={drunk()} canEdit onUpdate={() => {}} onReviewSaved={onReviewSaved} />);

  fireEvent.click(await screen.findByText('reviews.shareAsReview'));
  await screen.findByText('save-review');
  expect(formProps.existingReview).toBeUndefined();
  expect(formProps.wineDefinition).toBe('w1');
  expect(formProps.bottleId).toBe('b1');
  expect(formProps.defaultVintage).toBe('2016');
  expect(formProps.prefill).toEqual({ rating: 4.5, ratingScale: '5', overall: 'Cherry, tar, long finish.' });

  // The viewer's own reviews of the wine were read to find one linked to this bottle.
  expect(api.mock.calls[0][0]).toMatch(/^\/api\/reviews\/wine\/w1\?/);
  expect(new URLSearchParams(api.mock.calls[0][0].split('?')[1]).get('audience')).toBe('mine');

  fireEvent.click(screen.getByText('save-review'));
  expect(onReviewSaved).toHaveBeenCalledTimes(1);
  // Saved: the same button now edits that review.
  expect(await screen.findByText('reviews.editSharedReview')).toBeInTheDocument();
});

test('a review already linked to this bottle is edited, not written again', async () => {
  const linked = { _id: 'rev-1', bottle: 'b1', rating: 4, tasting: { overall: 'Shared before' } };
  myReviews([{ _id: 'rev-other', bottle: 'b9' }, linked]);
  render(<ConsumedDetails bottle={drunk()} canEdit onUpdate={() => {}} />);

  fireEvent.click(await screen.findByText('reviews.editSharedReview'));
  await screen.findByText('save-review');
  expect(formProps.existingReview).toEqual(linked);
});

test('a review of the wine that is not linked to this bottle does not count', async () => {
  myReviews([{ _id: 'rev-other', bottle: 'b9' }, { _id: 'rev-unlinked', bottle: null }]);
  render(<ConsumedDetails bottle={drunk()} canEdit onUpdate={() => {}} />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(await screen.findByText('reviews.shareAsReview')).toBeInTheDocument();
});

test('a note alone is enough; NV starts with no vintage', async () => {
  render(<ConsumedDetails bottle={drunk({ consumedRating: null, vintage: 'NV' })} canEdit onUpdate={() => {}} />);
  fireEvent.click(await screen.findByText('reviews.shareAsReview'));
  await screen.findByText('save-review');
  expect(formProps.prefill.rating).toBeNull();
  expect(formProps.defaultVintage).toBe('');
});

test.each([
  ['a gifted bottle', drunk({ consumedReason: 'gifted', status: 'gifted' }), true],
  ['a bottle with neither rating nor note', drunk({ consumedRating: null, consumedNote: '' }), true],
  ['a viewer who cannot edit the bottle', drunk(), false],
])('no share button for %s', async (_label, bottle, canEdit) => {
  render(<ConsumedDetails bottle={bottle} canEdit={canEdit} onUpdate={() => {}} />);
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('reviews.shareAsReview')).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

test('no share button for a demo account (it cannot write reviews)', async () => {
  user = { isDemo: true, preferences: { ratingScale: '5' } };
  render(<ConsumedDetails bottle={drunk()} canEdit onUpdate={() => {}} />);
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('reviews.shareAsReview')).toBeNull();
});
