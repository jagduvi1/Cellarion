import { render, screen, fireEvent } from '@testing-library/react';
import en from '../../locales/en/translation.json';

// What the import page says about a Ma Cave à Vins file: its card on the upload
// step, the consumed-count notice and the photo choice, each with English text
// behind its key.

vi.mock('react-i18next', () => {
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  return { useTranslation: () => ({ t }) };
});
const review = vi.hoisted(() => ({ on: true }));
vi.mock('../../utils/contributionReview', () => ({ useContributionReviewed: () => review.on }));

const ImportParseWarnings = (await import('./ImportParseWarnings')).default;
const ImportFormatCards = (await import('./ImportFormatCards')).default;

const enHas = (key) => key.split('.').reduce((node, part) => node?.[part], en) !== undefined;

test('the consumed-count notice names the count and the file\'s column', () => {
  render(<ImportParseWarnings
    importWarnings={[{ code: 'macave-consumed-not-imported', count: 2, column: 'Konsumiert' }]}
    parsedItems={[]}
  />);
  expect(screen.getByText('importBottles.warnings.maCaveConsumedNotImported:{"n":2,"column":"Konsumiert"}')).toBeInTheDocument();
  expect(enHas('importBottles.warnings.maCaveConsumedNotImported')).toBe(true);
});

test('the photo notice is a box the owner ticks to bring the photos in', () => {
  const notices = [{ code: 'vintage-missing', count: 1 }, { code: 'macave-photos', count: 3, include: false }];
  const setImportWarnings = vi.fn();
  render(<ImportParseWarnings importWarnings={notices} parsedItems={[]} setImportWarnings={setImportWarnings} />);

  const box = screen.getByRole('checkbox', { name: 'importBottles.warnings.maCavePhotos:{"n":3}' });
  expect(box).not.toBeChecked();
  fireEvent.click(box);
  // The choice is kept on the notice itself; the other notices stay as they are.
  const update = setImportWarnings.mock.calls[0][0];
  expect(update(notices)).toEqual([{ code: 'vintage-missing', count: 1 }, { code: 'macave-photos', count: 3, include: true }]);
  expect(enHas('importBottles.warnings.maCavePhotos')).toBe(true);
});

test('the photo box says where the photos go, in the words of this server', () => {
  const notices = [{ code: 'macave-photos', count: 3, include: false }];
  review.on = true;
  const { unmount } = render(<ImportParseWarnings importWarnings={notices} parsedItems={[]} setImportWarnings={vi.fn()} />);
  expect(screen.getByText(/^bottleDetail\.imageNotice:/)).toBeInTheDocument();
  unmount();
  review.on = false;
  render(<ImportParseWarnings importWarnings={notices} parsedItems={[]} setImportWarnings={vi.fn()} />);
  expect(screen.getByText(/^bottleDetail\.imageNoticeUnreviewed:/)).toBeInTheDocument();
  review.on = true;
});

test('a resumed draft says its photos need the file again; a wine with none left is said too', () => {
  render(<ImportParseWarnings
    importWarnings={[{ code: 'macave-photos-need-file', count: 3 }, { code: 'macave-none-left', count: 2 }]}
    parsedItems={[]}
  />);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByText('importBottles.warnings.maCavePhotosNeedFile:{"n":3}')).toBeInTheDocument();
  expect(screen.getByText('importBottles.warnings.maCaveNoneLeft:{"n":2}')).toBeInTheDocument();
  expect(enHas('importBottles.warnings.maCavePhotosNeedFile')).toBe(true);
  expect(enHas('importBottles.warnings.maCaveNoneLeft')).toBe(true);
});

test('the cellar activity page has words for an import and its photos', () => {
  expect(enHas('cellarAudit.actions.bottleImport')).toBe(true);
  expect(enHas('cellarAudit.actions.importPhotos')).toBe(true);
});

test('the upload step lists the app among the files it reads', () => {
  render(<ImportFormatCards />);
  expect(screen.getByText('importBottles.upload.maCaveTitle')).toBeInTheDocument();
  expect(screen.getByText('importBottles.upload.maCaveDesc')).toBeInTheDocument();
  for (const key of ['importBottles.upload.maCaveTitle', 'importBottles.upload.maCaveDesc', 'importBottles.formats.macave']) {
    expect(enHas(key)).toBe(true);
  }
});
