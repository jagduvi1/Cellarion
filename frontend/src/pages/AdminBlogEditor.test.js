/**
 * The admin blog editor could not open ANY existing post (found 2026-09-15).
 *
 * loadPost was a useCallback listing `editor` as a dependency, and TipTap's
 * useEditor hands back a fresh reference on re-render — so every state update
 * the load caused produced a new callback, re-ran the effect and refetched, in
 * a tight loop (221 requests in 1.2 s here) until a call landed on a replaced
 * editor instance and threw. The user saw "Failed to load post." and a
 * spinner that never ended.
 *
 * These tests pin the contract: the post is fetched ONCE, its fields land in
 * the form, and nothing alerts.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import AdminBlogEditor from './AdminBlogEditor';

const POST = {
  _id: '6aa9257367c260237d47185d',
  title: 'Your wine fridge is not a grid',
  slug: 'wine-cabinets-in-cellarion',
  excerpt: 'A wine fridge is not a rectangle of slots.',
  coverImage: '',
  tags: ['racks', 'wine cabinet'],
  status: 'draft',
  metaTitle: 'Wine cabinets in Cellarion',
  metaDescription: 'Short description.',
  content: '<p><strong>In short:</strong> a cabinet.</p><h2>How it works</h2><ul><li>Shelves.</li></ul>',
  author: { username: 'jagduvi' },
};

const navigate = vi.fn();
// Stable, like the real AuthContext's apiFetch (useCallback with []).
const apiFetch = vi.fn();
const auth = { apiFetch };

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: POST._id }),
  useNavigate: () => navigate,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../utils/apiJson', () => ({ apiJson: vi.fn() }));

describe('AdminBlogEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ post: POST }) });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  test('opens an existing post: fetched once, fields populated, no alert', async () => {
    render(<AdminBlogEditor />);

    await waitFor(() => expect(screen.getByDisplayValue(POST.title)).toBeInTheDocument());
    expect(screen.getByDisplayValue(POST.excerpt)).toBeInTheDocument();
    expect(screen.getByDisplayValue('racks, wine cabinet')).toBeInTheDocument();
    expect(screen.getByDisplayValue(POST.metaTitle)).toBeInTheDocument();

    // The regression: one render pass, one request. Allow a little slack for
    // React's double-invoked effects in development mode, but nothing like a loop.
    await new Promise((r) => setTimeout(r, 300));
    expect(apiFetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(apiFetch).toHaveBeenCalledWith(`/api/blog/admin/posts/${POST._id}`);
    expect(window.alert).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  test('an error response alerts once and returns to the list, instead of looping', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'Post not found' }) });
    render(<AdminBlogEditor />);

    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 300));
    expect(apiFetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(window.alert.mock.calls.length).toBeLessThanOrEqual(2);
    expect(navigate).toHaveBeenCalledWith('/admin/blog');
  });
});
