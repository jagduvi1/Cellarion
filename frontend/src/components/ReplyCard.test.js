import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The real i18n is not initialised in tests: echo the key and its values.
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key, a, b) => {
      const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
      return vars ? `${key}:${JSON.stringify(vars)}` : key;
    },
  }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: vi.fn(), user: { id: 'mod1', roles: ['moderator'] } }),
}));

vi.mock('../api/discussions', () => ({
  toggleReaction: vi.fn(),
  getReplyOriginal: vi.fn(),
  banUser: vi.fn(async () => ({ ok: true })),
}));

const { default: ReplyCard } = await import('./ReplyCard');

const reply = {
  _id: 'r1',
  body: 'Hello',
  createdAt: '2026-11-01T10:00:00.000Z',
  author: { _id: 'u2', username: 'kari', displayName: 'Kari', roles: ['user'] },
};

// #1798 item 13: the duration is part of a whole sentence per choice, since
// the preposition depends on it ("for 1 week", but "permanently").
describe('ReplyCard ban confirmation', () => {
  test.each(['1w', 'permanent'])('asks with the sentence for %s', (duration) => {
    render(<MemoryRouter><ReplyCard reply={reply} discussionId="d1" /></MemoryRouter>);
    fireEvent.click(screen.getByText('discussions.ban'));
    fireEvent.click(screen.getByText(`discussions.banDuration.${duration}`));
    expect(screen.getByText(new RegExp(`^discussions\\.confirmBanFor\\.${duration}:`))).toBeTruthy();
    expect(screen.queryByText(/discussions\.confirmBan:/)).toBeNull();
  });
});
