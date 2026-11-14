// The prose a profile card shows (utils/profileText): the translated copy the
// server sent while it is fresh — same generatedAt as the English — else the
// English, which is also what every wine without a copy shows.
import { profileText } from './profileText';

const AT = '2026-11-13T10:00:00.000Z';
const ENGLISH = {
  description: 'Firm and fragrant.', flavors: ['tar', 'rose'], foodPairings: ['braised beef'], generatedAt: AT,
};
const COPY = { lang: 'de', description: 'Fest und duftig.', flavors: ['Teer', 'Rose'], foodPairings: ['Schmorbraten'], generatedAt: AT };

test('no copy: the English, unchanged', () => {
  expect(profileText(ENGLISH)).toEqual({
    description: 'Firm and fragrant.', flavors: ['tar', 'rose'], foodPairings: ['braised beef'], lang: null,
  });
});

test('a fresh copy: the translated prose and its language', () => {
  expect(profileText({ ...ENGLISH, localized: COPY })).toEqual({
    description: 'Fest und duftig.', flavors: ['Teer', 'Rose'], foodPairings: ['Schmorbraten'], lang: 'de',
  });
});

test('a copy made of an older English text: the English', () => {
  const ap = { ...ENGLISH, generatedAt: '2026-11-14T08:00:00.000Z', localized: COPY };
  expect(profileText(ap)).toMatchObject({ description: 'Firm and fragrant.', lang: null });
});

test('the anonymous tier sends the description only: the lists stay the English ones', () => {
  const ap = { description: 'Firm and fragrant.', style: 'full-bodied', localized: { lang: 'de', description: 'Fest und duftig.' } };
  expect(profileText(ap)).toEqual({ description: 'Fest und duftig.', flavors: [], foodPairings: [], lang: 'de' });
});

test('no English description (held or never written): no prose, whatever is stored beside it', () => {
  expect(profileText({ description: null, localized: COPY })).toMatchObject({ description: null, lang: null });
  expect(profileText(null)).toEqual({ description: null, flavors: [], foodPairings: [], lang: null });
});

test('a copy without a description is no copy', () => {
  expect(profileText({ ...ENGLISH, localized: { ...COPY, description: '' } })).toMatchObject({ description: 'Firm and fragrant.', lang: null });
});
