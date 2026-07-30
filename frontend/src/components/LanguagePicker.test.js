import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('virtual:locale-coverage', () => ({
  BETA_BELOW: 0.9,
  LIST_ABOVE: 0.1,
  LOCALES: [
    { code: 'en', translated: 100, total: 100, ratio: 1, beta: false, unreviewed: false },
    { code: 'sv', translated: 99, total: 100, ratio: 0.99, beta: false, unreviewed: true },
    { code: 'fr', translated: 629, total: 1000, ratio: 0.629, beta: true, unreviewed: false },
    // Bulk-drafted: full, but nobody has read it.
    { code: 'de', translated: 1000, total: 1000, ratio: 1, beta: true, unreviewed: true },
  ],
  LOCALE_CODES: ['de', 'en', 'fr', 'sv'],
  SHIPPED_CODES: ['en', 'sv'],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Components pass English fallbacks inline. Unlike the usual mock this one
    // also interpolates, because the beta label's whole job is to carry a
    // language name and a number into one sentence.
    t: (key, fallback, options = {}) => {
      const template = typeof fallback === 'string' ? fallback : key;
      return template.replace(/\{\{\s*(\w+)[^}]*\}\}/g, (_, name) =>
        (options[name] === undefined ? `{{${name}}}` : String(options[name]))
      );
    },
  }),
}));

const LanguagePicker = (await import('./LanguagePicker')).default;

const options = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('LanguagePicker', () => {
  test('offers every language, the reviewed source language under its own name', () => {
    render(<LanguagePicker value="en" onChange={() => {}} />);
    expect(options()).toContain('English');
  });

  test('a complete language nobody has reviewed says so, without a percentage', () => {
    // Swedish is 99% here: the number is not what a reader needs to know, the
    // fact that no speaker has checked it is.
    render(<LanguagePicker value="en" onChange={() => {}} />);
    expect(options().find((o) => o.startsWith('Svenska'))).toBe('Svenska (unreviewed)');
  });

  test('a bulk-drafted language reads beta · unreviewed, never beta · 100%', () => {
    // The wart this label exists to avoid: 100% filled, 0% read.
    render(<LanguagePicker value="en" onChange={() => {}} />);
    expect(options().find((o) => o.startsWith('Deutsch'))).toBe('Deutsch (beta · unreviewed)');
  });

  test('explains what unreviewed means', () => {
    render(<LanguagePicker value="en" onChange={() => {}} />);
    expect(screen.getByText(/no native speaker has checked it yet/i)).toBeInTheDocument();
  });

  test('marks an unfinished language with how far along it is', () => {
    render(<LanguagePicker value="en" onChange={() => {}} />);
    // The point of the label: a reader picking this knows what they are getting
    // before they get it, rather than discovering half an English UI.
    expect(options()).toContain('Français (beta · 62%)');
  });

  test('an unfinished language is selectable, not disabled', () => {
    const onChange = vi.fn();
    render(<LanguagePicker value="en" onChange={onChange} />);
    const french = screen.getByRole('option', { name: 'Français (beta · 62%)' });
    expect(french).not.toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fr' } });
    expect(onChange).toHaveBeenCalledWith('fr');
  });

  test('explains the beta label and points at where to help', () => {
    render(<LanguagePicker value="en" onChange={() => {}} />);
    expect(screen.getByText(/stays in English/i)).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://hosted.weblate.org/projects/cellarion/');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  test('reflects the current value', () => {
    render(<LanguagePicker value="sv" onChange={() => {}} />);
    expect(screen.getByRole('combobox')).toHaveValue('sv');
  });
});

describe('LanguagePicker with no unfinished languages', () => {
  test('says nothing about beta at all', async () => {
    vi.resetModules();
    vi.doMock('virtual:locale-coverage', () => ({
      BETA_BELOW: 0.9,
      LOCALES: [{ code: 'en', translated: 100, total: 100, ratio: 1, beta: false }],
      LOCALE_CODES: ['en'],
      SHIPPED_CODES: ['en'],
    }));
    const Fresh = (await import('./LanguagePicker')).default;
    render(<Fresh value="en" onChange={() => {}} />);
    expect(screen.queryByText(/stays in English/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
