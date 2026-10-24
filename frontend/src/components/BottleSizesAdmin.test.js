import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import BottleSizesAdmin from './BottleSizesAdmin';

// The admin bottle-size tab: Apply sends the target the select shows (the
// row's suggestion until the admin picks another), and every failure — a
// refused remap, a failed load, a failed normalize-all — is shown as an error.

vi.mock('react-i18next', () => {
  // One stable t: the component's load callback depends on it.
  const t = (key, opts) => {
    if (typeof opts === 'string') return opts;
    const text = (opts && opts.defaultValue) || key;
    return opts && opts.count !== undefined ? text.replace('{{count}}', opts.count) : text;
  };
  return { useTranslation: () => ({ t }) };
});

const jsonRes = (body, ok = true, status = ok ? 200 : 400) => ({
  ok, status, headers: { get: () => null }, json: () => Promise.resolve(body),
});

const LIST = {
  sizes: [
    { value: '750ml', count: 10, canonical: true, suggested: '750ml' },
    { value: '75cl', count: 3, canonical: false, suggested: '750ml' },
  ],
  canonical: [{ code: '750ml' }, { code: '1.5L' }],
};

const remapCalls = (apiFetch) =>
  apiFetch.mock.calls.filter(([url]) => url === '/api/admin/taxonomy/bottle-sizes/remap');

test('Apply on an untouched row sends the suggestion the select shows', async () => {
  const apiFetch = vi.fn((url) => Promise.resolve(
    url.endsWith('/remap') ? jsonRes({ from: '75cl', to: '750ml', modified: 3 }) : jsonRes(LIST)
  ));
  render(<BottleSizesAdmin apiFetch={apiFetch} />);

  const select = await screen.findByRole('combobox');
  expect(select.value).toBe('750ml');
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(remapCalls(apiFetch)).toHaveLength(1));
  expect(JSON.parse(remapCalls(apiFetch)[0][1].body)).toEqual({ from: '75cl', to: '750ml' });
  await screen.findByText('3 bottle(s) remapped.');
});

test('Apply sends the target the admin picked over the suggestion', async () => {
  const apiFetch = vi.fn((url) => Promise.resolve(
    url.endsWith('/remap') ? jsonRes({ from: '75cl', to: '1.5L', modified: 3 }) : jsonRes(LIST)
  ));
  render(<BottleSizesAdmin apiFetch={apiFetch} />);

  fireEvent.change(await screen.findByRole('combobox'), { target: { value: '1.5L' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(remapCalls(apiFetch)).toHaveLength(1));
  expect(JSON.parse(remapCalls(apiFetch)[0][1].body)).toEqual({ from: '75cl', to: '1.5L' });
});

test('a refused remap shows its reason as an error, never as a success', async () => {
  const reason = '"to" must be a valid size (e.g. 750ml or 1.5L)';
  const apiFetch = vi.fn((url) => Promise.resolve(
    url.endsWith('/remap') ? jsonRes({ error: reason }, false, 400) : jsonRes(LIST)
  ));
  const { container } = render(<BottleSizesAdmin apiFetch={apiFetch} />);

  fireEvent.change(await screen.findByRole('combobox'), { target: { value: '1.5L' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  const alert = await screen.findByText(reason);
  expect(alert).toHaveClass('alert-error');
  expect(container.querySelector('.alert-success')).toBeNull();
});

test('a remap that never reaches the server shows an error', async () => {
  const apiFetch = vi.fn((url) => (
    url.endsWith('/remap') ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(jsonRes(LIST))
  ));
  const { container } = render(<BottleSizesAdmin apiFetch={apiFetch} />);

  fireEvent.change(await screen.findByRole('combobox'), { target: { value: '1.5L' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(container.querySelector('.alert-error')).not.toBeNull());
  expect(container.querySelector('.alert-error').textContent)
    .toBe('Cellarion could not be reached. Check your connection and try again.');
});

test('a failed load shows an error instead of an empty, healthy-looking table', async () => {
  const apiFetch = vi.fn(() => Promise.resolve(jsonRes({ error: 'Failed to list bottle sizes' }, false, 500)));
  const { container } = render(<BottleSizesAdmin apiFetch={apiFetch} />);

  await waitFor(() => expect(container.querySelector('.alert-error')).not.toBeNull());
  expect(container.querySelector('.alert-error').textContent)
    .toBe('Cellarion could not answer just now. Try again in a moment.');
  expect(screen.queryByText('0 non-standard value(s) in use.')).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});

test('a failed normalize-all shows an error', async () => {
  const apiFetch = vi.fn((url) => Promise.resolve(
    url.endsWith('/normalize-all') ? jsonRes({ error: 'Failed to normalize bottle sizes' }, false, 500) : jsonRes(LIST)
  ));
  const { container } = render(<BottleSizesAdmin apiFetch={apiFetch} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Normalize all' }));

  await waitFor(() => expect(container.querySelector('.alert-error')).not.toBeNull());
  expect(container.querySelector('.alert-error').textContent)
    .toBe('Cellarion could not answer just now. Try again in a moment.');
  expect(container.querySelector('.alert-success')).toBeNull();
});
