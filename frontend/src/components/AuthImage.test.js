import { render, waitFor } from '@testing-library/react';
import AuthImage from './AuthImage';

// Audit 2026-09 S7-1 / F06-1 / F01-1: a registry wine.image is user-influenced
// data. Only a same-origin /api/ path may ever be fetched with the bearer.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

beforeEach(() => {
  apiFetch.mockReset();
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:http://localhost:3000/mock'),
    revokeObjectURL: vi.fn(),
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderSrc = (src) => render(<AuthImage src={src} alt="x" />).container;

test('plain external https, inline image and blob sources render directly, no fetch', async () => {
  for (const src of ['https://cdn.example.com/a.png', 'data:image/png;base64,iVBORw0KGgo=', 'blob:http://localhost:3000/abc']) {
    const c = renderSrc(src);
    await waitFor(() => expect(c.querySelector('img')).toHaveAttribute('src', src));
  }
  expect(apiFetch).not.toHaveBeenCalled();
});

test('an upload path renders directly (browser-cacheable), no fetch', async () => {
  const c = renderSrc('/api/uploads/abc-123.png');
  await waitFor(() => expect(c.querySelector('img')).toHaveAttribute('src', '/api/uploads/abc-123.png'));
  expect(apiFetch).not.toHaveBeenCalled();
});

test('another same-origin API path is fetched with apiFetch and shown as a blob', async () => {
  apiFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
  const c = renderSrc('/api/images/123/file');
  await waitFor(() => expect(c.querySelector('img')).toHaveAttribute('src', 'blob:http://localhost:3000/mock'));
  expect(apiFetch).toHaveBeenCalledWith('/api/images/123/file');
});

test('shapes that would leave the origin render nothing and never reach apiFetch', async () => {
  for (const src of [
    '//attacker.example/pixel.png', ' //attacker.example/pixel.png', '/\\attacker.example/x',
    '\\\\attacker.example\\x', '/api/\\attacker.example', 'javascript:alert(1)',
    'data:text/html;base64,PA==', 'data:image/svg+xml;base64,PA==', 'ftp://x/y', 'label.png',
  ]) {
    const c = renderSrc(src);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.querySelector('img')).toBeNull();
  }
  expect(apiFetch).not.toHaveBeenCalled();
});
