import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The edit form opens at its drink-window years when the details' own window
// link asks for it, and at its top from the two Edit buttons (the header's
// and the phone bar's) — the form itself does the scrolling and focusing
// (EditForm.lot.test.js).

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key, i18n: { language: 'en-GB' } }) }));
vi.mock('../components/bottle/HeroImage', () => ({ default: () => null }));
vi.mock('../components/bottle/ViewDetails', () => ({
  default: ({ onEdit }) => (
    <div data-testid="details">
      <button type="button" onClick={() => onEdit({ focus: 'drinkWindow' })}>window-link</button>
      {/* The photo prompt hands its click event to onEdit. */}
      <button type="button" onClick={(e) => onEdit(e)}>photo-prompt</button>
    </div>
  ),
}));
vi.mock('../components/bottle/EditForm', () => ({
  default: ({ focus, onCancel }) => (
    <div data-testid="edit-form">
      focus:{String(focus)}
      <button type="button" onClick={onCancel}>cancel-edit</button>
    </div>
  ),
}));
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

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const BOTTLE = {
  _id: 'b1', cellar: 'c1', status: 'active', vintage: '2016',
  wineDefinition: { _id: 'w1', name: 'Barolo', producer: 'Borgogno', type: 'red' },
};

const { default: BottleDetail } = await import('./BottleDetail');

beforeEach(() => {
  const api = vi.fn(async (url) => (url === '/api/bottles/b1' ? ok({ bottle: BOTTLE, userRole: 'owner' }) : ok({})));
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5', currency: 'EUR' } } };
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/bottles/b1']}>
    <Routes>
      <Route path="/cellars/:id/bottles/:bottleId" element={<BottleDetail />} />
    </Routes>
  </MemoryRouter>,
);

test('the window link opens the form at the drink window; the Edit buttons and the photo prompt open it at its top', async () => {
  renderPage();
  fireEvent.click(await screen.findByText('window-link'));
  expect(screen.getByTestId('edit-form')).toHaveTextContent('focus:drinkWindow');
  fireEvent.click(screen.getByText('cancel-edit'));

  // The header's Edit, after a window-link visit: not at the window any more.
  fireEvent.click(screen.getByText('bottleDetail.editDetails'));
  expect(screen.getByTestId('edit-form')).toHaveTextContent('focus:null');
  fireEvent.click(screen.getByText('cancel-edit'));

  fireEvent.click(screen.getByText('window-link'));
  fireEvent.click(screen.getByText('cancel-edit'));
  // The phone bar's Edit.
  fireEvent.click(screen.getByText('bottleDetail.editDetailsShort'));
  expect(screen.getByTestId('edit-form')).toHaveTextContent('focus:null');
  fireEvent.click(screen.getByText('cancel-edit'));

  fireEvent.click(screen.getByText('photo-prompt'));
  expect(screen.getByTestId('edit-form')).toHaveTextContent('focus:null');
});
