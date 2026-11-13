import { render, screen } from '@testing-library/react';

// The tasting profile on the bottle and vintage pages. With a language set in
// SuperAdmin → AI the server sends the translated prose beside the English
// while it is fresh (backend utils/profileLanguage); the card shows it, marked
// with its language. A stale copy — made of an older English text — and a wine
// without one show the English, exactly as before.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d) => (typeof d === 'string' ? d : k) }) }));

const { default: TastingProfileCard } = await import('./TastingProfileCard');

const AT = '2026-11-13T10:00:00.000Z';
const ENGLISH = {
  body: 'full', tannin: 'high', acidity: 'high', sweetness: 'dry', source: 'ai',
  description: 'Firm and fragrant.', flavors: ['tar', 'rose'], foodPairings: ['braised beef'], generatedAt: AT,
};
const COPY = { lang: 'de', description: 'Fest und duftig.', flavors: ['Teer', 'Rose'], foodPairings: ['Schmorbraten', 'Trüffel'], generatedAt: AT };

test('a fresh copy: the translated note, flavours and pairings, marked with their language', () => {
  const { container } = render(<TastingProfileCard wine={{ aiProfile: { ...ENGLISH, localized: COPY } }} />);
  expect(screen.getByText('Fest und duftig.')).toBeInTheDocument();
  expect(screen.getByText('Teer')).toBeInTheDocument();
  expect(screen.getByText('Schmorbraten · Trüffel')).toHaveAttribute('lang', 'de');
  expect(container.querySelector('.bd-ai-prose')).toHaveAttribute('lang', 'de');
  expect(screen.getByText('Teer').parentElement).toHaveAttribute('lang', 'de');
  expect(screen.queryByText('Firm and fragrant.')).toBeNull();
  // The structure stays as it always was, and so does the provenance tag.
  expect(screen.getByText('full-bodied')).toBeInTheDocument();
  expect(screen.getByText('AI-generated')).toBeInTheDocument();
});

test('a stale copy (an older English text): the English', () => {
  const ap = { ...ENGLISH, generatedAt: '2026-11-14T08:00:00.000Z', localized: COPY };
  const { container } = render(<TastingProfileCard wine={{ aiProfile: ap }} />);
  expect(screen.getByText('Firm and fragrant.')).toBeInTheDocument();
  expect(screen.getByText('tar')).toBeInTheDocument();
  expect(screen.queryByText('Fest und duftig.')).toBeNull();
  expect(container.querySelector('.bd-ai-prose')).not.toHaveAttribute('lang');
});

test('no copy: the English card, with no language marks', () => {
  const { container } = render(<TastingProfileCard wine={{ aiProfile: ENGLISH }} />);
  expect(screen.getByText('Firm and fragrant.')).toBeInTheDocument();
  expect(container.querySelector('.bd-ai-pairings').textContent).toBe('Pairs with:braised beef');
  expect(container.querySelector('[lang]')).toBeNull();
});
