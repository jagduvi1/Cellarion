import { render, screen } from '@testing-library/react';
import en from '../../locales/en/translation.json';

// What the import page says about a Ma Cave à Vins file: its card on the upload
// step and the consumed-count notice, each with English text behind its key.

vi.mock('react-i18next', () => {
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  return { useTranslation: () => ({ t }) };
});

const ImportParseWarnings = (await import('./ImportParseWarnings')).default;
const ImportFormatCards = (await import('./ImportFormatCards')).default;

const enHas = (key) => key.split('.').reduce((node, part) => node?.[part], en) !== undefined;

test('the consumed-count notice names the count and the file\'s column', () => {
  render(<ImportParseWarnings
    importWarnings={[{ code: 'macave-consumed-not-imported', count: 2, column: 'Konsumiert' }]}
    parsedItems={[]}
  />);
  expect(screen.getByText('importBottles.warnings.maCaveConsumedNotImported:{"count":2,"column":"Konsumiert"}')).toBeInTheDocument();
  expect(enHas('importBottles.warnings.maCaveConsumedNotImported_one')).toBe(true);
  expect(enHas('importBottles.warnings.maCaveConsumedNotImported_other')).toBe(true);
});

test('the upload step lists the app among the files it reads', () => {
  render(<ImportFormatCards />);
  expect(screen.getByText('importBottles.upload.maCaveTitle')).toBeInTheDocument();
  expect(screen.getByText('importBottles.upload.maCaveDesc')).toBeInTheDocument();
  for (const key of ['importBottles.upload.maCaveTitle', 'importBottles.upload.maCaveDesc', 'importBottles.formats.macave']) {
    expect(enHas(key)).toBe(true);
  }
});
