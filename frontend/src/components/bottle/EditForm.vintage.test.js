import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The vintage field keeps its stored codes but accepts the words the UI shows
// for them (#1690): a Norwegian user typing "Uten årgang" saves 'NV'.

vi.mock('react-i18next', () => {
  const words = { 'common.nonVintage': 'Uten årgang', 'common.unknownVintage': 'Ukjent årgang' };
  return { useTranslation: () => ({ t: (key) => words[key] ?? key }) };
});
vi.mock('../../api/bottles', () => ({ updateBottle: vi.fn(), setBottleDefaultImage: vi.fn(), bulkUpdateBottles: vi.fn() }));
vi.mock('../ImageUpload', () => ({ default: () => null }));
vi.mock('../ImageGallery', () => ({ default: () => null }));
vi.mock('../RatingInput', () => ({ default: () => null }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: () => {}, user: { preferences: { currency: 'SEK' } } }),
}));

const { updateBottle } = await import('../../api/bottles');
const { default: EditForm } = await import('./EditForm');

const BOTTLE = { _id: 'b1', vintage: '2019', bottleSize: '750ml', notes: '', ratingScale: '5' };

beforeEach(() => {
  vi.clearAllMocks();
  updateBottle.mockResolvedValue({ ok: true, json: async () => ({ bottle: BOTTLE }) });
});

const saveWithVintage = async (typed) => {
  const { container } = render(<EditForm bottle={BOTTLE} onSaved={() => {}} onCancel={() => {}} />);
  const input = container.querySelector('input[value="2019"]');
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.click(screen.getByText('bottleDetail.saveChanges'));
  await waitFor(() => expect(updateBottle).toHaveBeenCalled());
  return { input, payload: updateBottle.mock.calls[0][2] };
};

describe('EditForm vintage field', () => {
  test('saves the translated non-vintage word as NV', async () => {
    const { payload } = await saveWithVintage('uten årgang');
    expect(payload.vintage).toBe('NV');
  });

  test('saves the translated unknown word as Unknown', async () => {
    const { payload } = await saveWithVintage('Ukjent årgang');
    expect(payload.vintage).toBe('Unknown');
  });

  test('the field lets the longer word through its pattern and length', async () => {
    const { input } = await saveWithVintage('Ukjent årgang');
    expect(Number(input.getAttribute('maxlength'))).toBeGreaterThanOrEqual('Ukjent årgang'.length);
    expect(new RegExp(input.getAttribute('pattern'), 'v').test('Ukjent årgang')).toBe(true);
  });

  test('a year is saved as typed', async () => {
    const { payload } = await saveWithVintage('2015');
    expect(payload.vintage).toBe('2015');
  });
});
