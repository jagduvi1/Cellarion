import {
  isRatingField, ratingMeasureField, viewerRatingScale, ratingSuffix, formatRatingCell, ratingFieldLabel,
} from './analyticsRatings';

describe('analyticsRatings', () => {
  test('knows the two rating fields, also inside a measure label', () => {
    expect(isRatingField('rating.current')).toBe(true);
    expect(isRatingField('rating.consumed')).toBe(true);
    expect(isRatingField('purchase.price')).toBe(false);
    expect(ratingMeasureField('avg(rating.current)')).toBe('rating.current');
    expect(ratingMeasureField('max(rating.consumed)')).toBe('rating.consumed');
    expect(ratingMeasureField('sum(purchase.price)')).toBeNull();
    expect(ratingMeasureField('count')).toBeNull();
  });

  test('the viewer scale comes from Settings, stars when unset or unknown', () => {
    expect(viewerRatingScale({ preferences: { ratingScale: '100' } })).toBe('100');
    expect(viewerRatingScale({ preferences: { ratingScale: '20' } })).toBe('20');
    expect(viewerRatingScale({ preferences: {} })).toBe('5');
    expect(viewerRatingScale({ preferences: { ratingScale: '10' } })).toBe('5');
    expect(viewerRatingScale(null)).toBe('5');
  });

  test('a value shows with its scale; the label loses "(stars)"', () => {
    expect(formatRatingCell(92, '100')).toBe('92pts');
    expect(formatRatingCell(91.4, '100')).toBe('91pts');
    expect(formatRatingCell(17.5, '20')).toBe('17.5/20');
    expect(formatRatingCell(4.25, '5')).toMatch(/^4\.[23]★$/);
    expect(ratingSuffix('100')).toBe('pts');
    expect(ratingFieldLabel('My rating (stars)')).toBe('My rating');
    expect(ratingFieldLabel('Rating at consumption (stars)')).toBe('Rating at consumption');
  });
});
