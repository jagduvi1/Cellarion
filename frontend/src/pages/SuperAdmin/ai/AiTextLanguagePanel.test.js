import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// SuperAdmin → AI: the language for the AI-written wine texts. Off (English)
// is the default; the select offers the codes the server lists and nothing
// else, and saving sends the chosen code — or '' for off — to
// PATCH /api/superadmin/ai/text-language.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d) => (typeof d === 'string' ? d : k) }) }));

const { default: AiTextLanguagePanel } = await import('./AiTextLanguagePanel');

const LANGUAGES = ['de', 'et', 'fr', 'nb', 'nl', 'sv'];
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('off by default: "Off (English)" is chosen and Save waits for a change', () => {
  render(<AiTextLanguagePanel current="" languages={LANGUAGES} apiFetch={vi.fn()} />);
  const select = screen.getByLabelText('Language');
  expect(select).toHaveValue('');
  expect(screen.getByRole('option', { name: 'Off (English)' })).toBeInTheDocument();
  expect([...select.options].map((o) => o.value)).toEqual(['', ...LANGUAGES]);
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByText(/keep their English text until their profile is written again/)).toBeInTheDocument();
});

test('the help says Registry Bridge copies and curator profiles stay in English', () => {
  // No local enrichment path writes either (registryId / source 'curator'), so a translation can never come.
  render(<AiTextLanguagePanel current="" languages={LANGUAGES} apiFetch={vi.fn()} />);
  expect(screen.getByText(/Registry Bridge and profiles written by a curator always stay in English/)).toBeInTheDocument();
});

test('choosing a language sends its code', async () => {
  const apiFetch = vi.fn(async () => okJson({ aiTextLanguage: 'de' }));
  render(<AiTextLanguagePanel current="" languages={LANGUAGES} apiFetch={apiFetch} />);
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'de' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Saved. New wine profiles are also written in this language.');
  expect(apiFetch).toHaveBeenCalledWith('/api/superadmin/ai/text-language', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ language: 'de' }) }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('turning it off sends an empty code', async () => {
  const apiFetch = vi.fn(async () => okJson({ aiTextLanguage: '' }));
  render(<AiTextLanguagePanel current="sv" languages={LANGUAGES} apiFetch={apiFetch} />);
  expect(screen.getByLabelText('Language')).toHaveValue('sv');
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Saved. New wine profiles are written in English only.');
  expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ language: '' });
});

test('a refusal shows the server\'s reason and keeps the choice', async () => {
  const apiFetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "language must be one of: '', 'de'" }) }));
  render(<AiTextLanguagePanel current="" languages={LANGUAGES} apiFetch={apiFetch} />);
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fr' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByText("language must be one of: '', 'de'")).toBeInTheDocument());
  expect(screen.getByLabelText('Language')).toHaveValue('fr');
});
