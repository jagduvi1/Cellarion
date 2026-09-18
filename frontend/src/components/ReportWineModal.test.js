import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../api/support', () => ({ submitWineReport: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
  Trans: ({ i18nKey }) => i18nKey,
}));

const ReportWineModal = (await import('./ReportWineModal')).default;

const WINE = { _id: 'w1', name: 'Barolo Albe', producer: 'G.D. Vajra' };

// Wrong DATA belongs in the wine record, where the corrected value travels
// with the suggestion (every field, grapes included) and a curator applies it
// in one click. The report dialog's own one-field form covers four fields and
// no grapes — so where the record is on the page, the dialog points at it.
test('on a page with the wine record, "wrong information" offers the record\'s fix flow instead of the one-field form', () => {
  const onSuggestFix = vi.fn();
  render(<ReportWineModal wine={WINE} onClose={() => {}} onSuggestFix={onSuggestFix} />);
  expect(screen.queryByText('reportWine.suggestFieldNone')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Suggest a fix instead'));
  expect(onSuggestFix).toHaveBeenCalledTimes(1);
  // A report in prose is still possible.
  expect(screen.getByText('reportWine.submit')).toBeInTheDocument();
});

test('the pointer is only for wrong information — a duplicate or a price is not a record fix', () => {
  render(<ReportWineModal wine={WINE} defaultReason="wrong_price" onClose={() => {}} onSuggestFix={() => {}} />);
  expect(screen.queryByText('Suggest a fix instead')).not.toBeInTheDocument();
});

test('a page without the record keeps the one-field suggestion', () => {
  render(<ReportWineModal wine={WINE} onClose={() => {}} />);
  expect(screen.queryByText('Suggest a fix instead')).not.toBeInTheDocument();
  expect(screen.getByText('reportWine.suggestFieldNone')).toBeInTheDocument();
});
