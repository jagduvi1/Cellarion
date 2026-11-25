import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The wine record's Sweetness row after the page's own saves. The bottle read
// sends the category the wine reads as; the answer to a save sends the wine
// without it. The page replaces its bottle with that answer, so without care
// the row fell back to "not recorded" — and offered a style on a wine whose
// name already carries the word. A save changes nothing on the wine: its
// reading stays, while the answer is about the same wine.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars && vars.count !== undefined ? `${key}:${vars.count}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('../components/bottle/HeroImage', () => ({ default: () => null }));
vi.mock('../components/BottleJourney', () => ({ default: () => null }));
vi.mock('../components/bottle/OwnerInquiryCard', () => ({ default: () => null }));
vi.mock('../components/bottle/PersonalDataCard', () => ({ default: () => null }));
vi.mock('../components/bottle/LotHistory', () => ({ default: () => null }));
vi.mock('../components/bottle/TastingProfileCard', () => ({ default: () => null }));
vi.mock('../components/bottle/WineReviewsCard', () => ({ default: () => null }));
vi.mock('../components/ShareButton', () => ({ default: () => null }));
vi.mock('../components/CollapsibleBlock', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../utils/collapsedBlocks', () => ({
  useCollapsedBlocks: () => ({ isCollapsed: () => false, toggle: () => {}, expand: () => {} }),
}));
vi.mock('../utils/featureFlags', () => ({ useFeature: () => false }));
vi.mock('../utils/currency', () => ({ fetchRates: async () => null }));

// What a save answers with: set by each test, handed to the page by the
// stand-ins below exactly as the real form and card hand it over.
let saved;
vi.mock('../components/bottle/ViewDetails', () => ({
  default: ({ bottle, onEdit }) => (
    <div>
      <div data-testid="reading">{String(bottle.wineDefinition?.sweetnessCategory)}|{String(bottle.wineDefinition?.sweetnessCategoryBasis)}</div>
      <div data-testid="notes">{bottle.notes || ''}</div>
      <button type="button" onClick={() => onEdit()}>edit</button>
    </div>
  ),
}));
vi.mock('../components/bottle/EditForm', () => ({
  default: ({ onSaved }) => <button type="button" onClick={() => onSaved(saved)}>save</button>,
}));
vi.mock('../components/bottle/ConsumedDetails', () => ({
  default: ({ onUpdate }) => <button type="button" onClick={() => onUpdate(saved)}>save-rating</button>,
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const READ_WINE = { _id: 'w1', name: 'Cuvée Réserve Brut', type: 'sparkling', sweetnessCategory: 'dry', sweetnessCategoryBasis: 'name' };
// The same wine as a write answers it: no category keys.
const ANSWER_WINE = { _id: 'w1', name: 'Cuvée Réserve Brut', type: 'sparkling' };

const setup = (bottle) => {
  const api = vi.fn(async (url) => (url === '/api/bottles/b1' ? ok({ bottle, userRole: 'owner' }) : ok({})));
  auth = { apiFetch: api, user: { id: 'u1', isDemo: false, preferences: { ratingScale: '5', currency: 'EUR' } } };
};

const { default: BottleDetail } = await import('./BottleDetail');
const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/bottles/b1']}>
    <Routes><Route path="/cellars/:id/bottles/:bottleId" element={<BottleDetail />} /></Routes>
  </MemoryRouter>,
);
const reading = () => screen.getByTestId('reading').textContent;

test('saving the bottle keeps the wine\'s reading, and takes the bottle\'s new fields', async () => {
  setup({ _id: 'b1', cellar: 'c1', status: 'active', vintage: '2019', notes: '', wineDefinition: READ_WINE });
  saved = { _id: 'b1', cellar: 'c1', status: 'active', vintage: '2019', notes: 'For the summer', wineDefinition: ANSWER_WINE };
  renderPage();
  await waitFor(() => expect(reading()).toBe('dry|name'));

  fireEvent.click(screen.getByText('edit'));
  fireEvent.click(await screen.findByText('save'));
  await waitFor(() => expect(screen.getByTestId('notes')).toHaveTextContent('For the summer'));
  expect(reading()).toBe('dry|name');
});

test('saving a drunk bottle\'s rating keeps it too', async () => {
  const drunk = { _id: 'b1', cellar: 'c1', status: 'drank', consumedReason: 'drank', consumedAt: new Date().toISOString(), vintage: '2019', notes: '' };
  setup({ ...drunk, wineDefinition: READ_WINE });
  saved = { ...drunk, notes: 'Lovely', wineDefinition: ANSWER_WINE };
  renderPage();
  await waitFor(() => expect(reading()).toBe('dry|name'));

  fireEvent.click(screen.getByText('save-rating'));
  await waitFor(() => expect(screen.getByTestId('notes')).toHaveTextContent('Lovely'));
  expect(reading()).toBe('dry|name');
});

test('an answer about another wine carries nothing over', async () => {
  setup({ _id: 'b1', cellar: 'c1', status: 'active', vintage: '2019', notes: '', wineDefinition: READ_WINE });
  saved = { _id: 'b1', cellar: 'c1', status: 'active', vintage: '2019', notes: 'moved', wineDefinition: { _id: 'w2', name: 'Riesling Kabinett', type: 'white' } };
  renderPage();
  await waitFor(() => expect(reading()).toBe('dry|name'));

  fireEvent.click(screen.getByText('edit'));
  fireEvent.click(await screen.findByText('save'));
  await waitFor(() => expect(screen.getByTestId('notes')).toHaveTextContent('moved'));
  expect(reading()).toBe('undefined|undefined');
});
