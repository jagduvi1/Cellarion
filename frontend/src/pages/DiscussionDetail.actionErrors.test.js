/**
 * A forum action the server refuses (or that never reaches it) says so in its
 * own dialog, and the dialog stays open:
 *
 *   - the two delete confirms keep the dialog open with the reason
 *   - the edit, report and move dialogs show the reason above their fields
 *   - a move whose category step went through and whose language step did not
 *     shows the category the thread is now filed under
 */
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../api/discussions', () => ({
  getDiscussion: vi.fn(),
  deleteDiscussion: vi.fn(),
  getDiscussionReplies: vi.fn(),
  createReply: vi.fn(),
  updateReply: vi.fn(),
  deleteReply: vi.fn(),
  toggleReaction: vi.fn(),
  getReplyOriginal: vi.fn(),
  banUser: vi.fn(),
  pinDiscussion: vi.fn(),
  lockDiscussion: vi.fn(),
  moveDiscussion: vi.fn(),
  moveDiscussionLanguage: vi.fn(),
  getForumLanguages: vi.fn(),
  reportDiscussion: vi.fn(),
  reportReply: vi.fn(),
}));
const { authState } = vi.hoisted(() => ({
  authState: { apiFetch: () => {}, user: { id: 'me', roles: ['moderator'] } },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));
// Real English strings with {{interpolation}}, so the assertions read like the screen does
vi.mock('react-i18next', async () => {
  const en = (await import('../locales/en/translation.json')).default;
  // t(key, vars) and t(key, defaultValue, vars) both occur
  const t = (key, a, b) => {
    const vars = (typeof a === 'object' && a) || b || {};
    const raw = key.split('.').reduce((o, k) => (o == null ? o : o[k]), en) ?? (typeof a === 'string' ? a : key);
    return String(raw).replace(/{{(\w+)}}/g, (m, name) => (name in vars ? vars[name] : m));
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});
vi.mock('../utils/timeAgo', () => ({ default: () => '1 day ago' }));
vi.mock('../components/SEOHead', () => ({ default: () => null }));
vi.mock('../components/DiscussionComposer', () => ({
  default: ({ value, onChange }) => <textarea aria-label="composer" value={value} onChange={e => onChange(e.target.value)} />,
}));
vi.mock('../components/WatchThreadButton', () => ({ default: () => null }));
vi.mock('../components/ParticipantStack', () => ({ default: () => null }));
vi.mock('../components/JumpToReplyButton', () => ({ default: () => null }));
vi.mock('../components/CommunityCTA', () => ({ default: () => null }));
vi.mock('../components/WineSearchPicker', () => ({ default: () => null }));

const api = await import('../api/discussions');
const DiscussionDetail = (await import('./DiscussionDetail')).default;

const res = (body, ok = true, status = 200) => ({ ok, status, headers: { get: () => null }, json: async () => body });

const THREAD = {
  _id: 'd1', title: 'Barolo or Barbaresco?', body: '<p>Which first?</p>',
  category: 'general', language: 'en', replyCount: 2,
  author: { _id: 'other', username: 'other' },
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
};
const MINE = {
  _id: 'r1', body: '<p>My own reply</p>', author: { _id: 'me', username: 'me' },
  createdAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z',
};
const THEIRS = {
  _id: 'r2', body: '<p>Their reply</p>', author: { _id: 'other', username: 'other' },
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getDiscussion.mockResolvedValue(res({ discussion: THREAD }));
  api.getDiscussionReplies.mockResolvedValue(res({ replies: [MINE, THEIRS], pages: 1 }));
  api.getForumLanguages.mockResolvedValue(res({
    languages: [{ code: 'en', name: 'English' }, { code: 'sv', name: 'Swedish', nativeName: 'Svenska' }],
  }));
});

async function renderThread() {
  render(
    <MemoryRouter initialEntries={['/community/discussions/d1']}>
      <Routes>
        <Route path="/community/discussions/:idOrSlug" element={<DiscussionDetail />} />
        <Route path="/community/discussions" element={<p>All discussions</p>} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByText('Their reply');
}

const replyCard = (text) => screen.getByText(text).closest('.reply-card');
const dialog = () => screen.getByRole('dialog');

describe('DiscussionDetail — failed actions', () => {
  test('a refused reply delete keeps the confirm open with the reason and the reply on screen', async () => {
    api.deleteReply.mockResolvedValue(res({ error: 'Nope' }, false, 403));
    await renderThread();

    fireEvent.click(within(replyCard('Their reply')).getByRole('button', { name: 'Delete' }));
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' })); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Nope');
    expect(within(dialog()).getByText('Delete Reply')).toBeInTheDocument();
    expect(screen.getByText('Their reply')).toBeInTheDocument();
    expect(screen.queryByText('[This reply has been removed]')).not.toBeInTheDocument();
  });

  test('a reply delete that goes through closes the confirm and shows the reply as removed', async () => {
    api.deleteReply.mockResolvedValue(res({ message: 'Reply deleted', reply: { ...THEIRS } }));
    await renderThread();

    fireEvent.click(within(replyCard('Their reply')).getByRole('button', { name: 'Delete' }));
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' })); });

    expect(await screen.findByText('[This reply has been removed]')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('a refused thread delete keeps the confirm open with the reason; one that goes through leaves the thread', async () => {
    api.deleteDiscussion.mockResolvedValueOnce(res({}, false, 500));
    await renderThread();

    fireEvent.click(within(document.querySelector('.discussion-detail__actions')).getByRole('button', { name: 'Delete' }));
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' })); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Cellarion could not answer just now. Try again in a moment.');
    expect(within(dialog()).getByText('Delete Discussion')).toBeInTheDocument();

    api.deleteDiscussion.mockResolvedValueOnce(res({ message: 'Discussion deleted' }));
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' })); });

    expect(await screen.findByText('All discussions')).toBeInTheDocument();
  });

  test('a move whose language step is refused shows the new category and the reason', async () => {
    api.moveDiscussion.mockResolvedValue(res({ discussion: { ...THREAD, category: 'food-pairing' } }));
    api.moveDiscussionLanguage.mockResolvedValue(res({ error: 'That language section is not open' }, false, 400));
    await renderThread();

    await act(async () => {
      fireEvent.click(within(document.querySelector('.discussion-detail__actions')).getByRole('button', { name: 'Move' }));
    });
    const [category, language] = within(dialog()).getAllByRole('combobox');
    fireEvent.change(category, { target: { value: 'food-pairing' } });
    fireEvent.change(language, { target: { value: 'sv' } });
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Move' })); });

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('That language section is not open');
    const header = document.querySelector('.discussion-detail__meta');
    expect(within(header).getByText('Food Pairing')).toBeInTheDocument();
    expect(within(header).queryByText('General')).not.toBeInTheDocument();
  });

  test('a refused reply edit keeps the edit dialog open with the reason', async () => {
    api.updateReply.mockResolvedValue(res({ error: 'You can only edit your own replies' }, false, 403));
    await renderThread();

    fireEvent.click(within(replyCard('My own reply')).getByRole('button', { name: 'Edit' }));
    await within(dialog()).findByLabelText('composer');
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' })); });

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('You can only edit your own replies');
    expect(within(dialog()).getByText('Edit Reply')).toBeInTheDocument();
  });

  test('an edit that never reaches the server says so', async () => {
    api.updateReply.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderThread();

    fireEvent.click(within(replyCard('My own reply')).getByRole('button', { name: 'Edit' }));
    await within(dialog()).findByLabelText('composer');
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' })); });

    expect(await within(dialog()).findByRole('alert'))
      .toHaveTextContent('Cellarion could not be reached. Check your connection and try again.');
  });

  test('a refused report keeps the dialog open with the reason; reopened, it starts clean; a report that goes through closes it', async () => {
    api.reportDiscussion.mockResolvedValueOnce(res({ error: 'You have already reported this' }, false, 409));
    await renderThread();

    const openReport = () => fireEvent.click(
      within(document.querySelector('.discussion-detail__actions')).getByRole('button', { name: 'Report' })
    );
    openReport();
    fireEvent.change(within(dialog()).getByRole('combobox'), { target: { value: 'spam' } });
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Submit Report' })); });

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('You have already reported this');
    expect(within(dialog()).getByText('Report Discussion')).toBeInTheDocument();

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openReport();
    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument();

    api.reportDiscussion.mockResolvedValueOnce(res({ message: 'Report submitted' }, true, 201));
    fireEvent.change(within(dialog()).getByRole('combobox'), { target: { value: 'spam' } });
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Submit Report' })); });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
