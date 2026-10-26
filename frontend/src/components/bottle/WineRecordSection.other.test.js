import { render, screen } from '@testing-library/react';

// The Other category: a drink that is not wine has no grapes, appellation or
// classification to record, so the record shows producer, name, type ("Other"),
// region and country only.

vi.mock('../../api/wineProposals', () => ({ createWineProposal: vi.fn(), getMyWineProposals: vi.fn() }));
vi.mock('../../api/taxonomy', () => ({ getGrapeNames: vi.fn() }));
vi.mock('../../api/registryData', () => ({ getWinePublicData: vi.fn(), suggestWineValue: vi.fn(), proposeRegistryKey: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));

const { getMyWineProposals } = await import('../../api/wineProposals');
const { getWinePublicData } = await import('../../api/registryData');
const { getGrapeNames } = await import('../../api/taxonomy');
const WineRecordSection = (await import('./WineRecordSection')).default;

const ok = (body) => ({ ok: true, json: async () => body });
const apiFetch = vi.fn();

const CIDER = {
  _id: 'w1',
  producer: 'Example Orchard',
  name: 'Vintage Cider',
  appellation: 'Somerset Cider',
  classification: null,
  type: null,
  nonWine: true,
  grapes: [],
  country: { name: 'England' },
  region: { name: 'Somerset' },
};

beforeEach(() => {
  vi.clearAllMocks();
  getMyWineProposals.mockResolvedValue(ok({ proposals: [] }));
  getWinePublicData.mockResolvedValue(ok({ fields: [] }));
  getGrapeNames.mockResolvedValue(ok({ grapes: [] }));
});

test('a drink in the Other category shows no grapes, appellation or classification rows', async () => {
  render(<WineRecordSection wine={CIDER} vintage="2019" canSuggest apiFetch={apiFetch} promptMissingGrapes={false} />);
  expect(await screen.findByText('Example Orchard')).toBeInTheDocument();
  expect(screen.getByText('Vintage Cider')).toBeInTheDocument();
  expect(screen.getByText('Other')).toBeInTheDocument();
  expect(screen.getByText('England')).toBeInTheDocument();
  expect(screen.getByText('Somerset')).toBeInTheDocument(); // the region row stays
  expect(screen.queryByText('Somerset Cider')).toBeNull(); // the appellation row is gone
  expect(screen.queryByText(/grapes/i)).toBeNull();
  expect(screen.queryByText(/classification/i)).toBeNull();
});

test('a wine keeps every row', async () => {
  render(<WineRecordSection wine={{ ...CIDER, nonWine: false, type: 'white', appellation: 'Marlborough' }} vintage="2019" canSuggest apiFetch={apiFetch} promptMissingGrapes={false} />);
  expect(await screen.findByText('Marlborough')).toBeInTheDocument();
  expect(screen.getByText(/classification/i)).toBeInTheDocument();
});
