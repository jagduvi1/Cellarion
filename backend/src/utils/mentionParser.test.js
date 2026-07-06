// Mock the User model before requiring the parser. The parser hits User.find
// to resolve usernames to ObjectIds; in unit tests we substitute a Map-based
// fake so the tests don't need a Mongo connection.

jest.mock('../models/User', () => {
  const fakeUsersByLowerUsername = new Map();
  return {
    __setUsers: (list) => {
      fakeUsersByLowerUsername.clear();
      for (const u of list) fakeUsersByLowerUsername.set(u.username.toLowerCase(), u);
    },
    find: (filter) => {
      // The parser passes { username: { $in: ['name', ...] } } with plain
      // lowercased strings (the schema stores usernames lowercased), so we
      // look each one up in the fake map directly.
      const names = filter?.username?.$in || [];
      const matched = [];
      for (const name of names) {
        const hit = fakeUsersByLowerUsername.get(String(name).toLowerCase());
        if (hit) matched.push(hit);
      }
      return {
        select: () => ({
          lean: async () => matched
        })
      };
    }
  };
});

const User = require('../models/User');
const { extractMentions, MENTION_RE, MAX_MENTIONS_PER_POST } = require('./mentionParser');

describe('extractMentions', () => {
  beforeEach(() => {
    User.__setUsers([
      { _id: 'a', username: 'alice' },
      { _id: 'b', username: 'bob.smith' },
      { _id: 'c', username: 'carol-W' },
      { _id: 'd', username: 'Dave_99' },
    ]);
  });

  test('returns [] for empty/null/non-string input', async () => {
    expect(await extractMentions('')).toEqual([]);
    expect(await extractMentions(null)).toEqual([]);
    expect(await extractMentions(undefined)).toEqual([]);
    expect(await extractMentions(42)).toEqual([]);
  });

  test('returns [] when there are no @mentions', async () => {
    expect(await extractMentions('hey check out this wine')).toEqual([]);
  });

  test('resolves a single @mention to its user id', async () => {
    expect(await extractMentions('hi @alice')).toEqual(['a']);
  });

  test('is case-insensitive on usernames', async () => {
    expect(await extractMentions('hi @ALICE')).toEqual(['a']);
    expect(await extractMentions('hi @dave_99')).toEqual(['d']);
  });

  test('matches usernames with allowed punctuation (dot, hyphen, underscore)', async () => {
    expect(await extractMentions('@bob.smith and @carol-W')).toEqual(
      expect.arrayContaining(['b', 'c'])
    );
  });

  test('does NOT match the @ inside email addresses', async () => {
    // The negative-lookbehind on \w means alice@example.com should not match @example
    expect(await extractMentions('email me at alice@example.com')).toEqual([]);
  });

  test('drops usernames that do not exist', async () => {
    expect(await extractMentions('hi @alice and @nobody')).toEqual(['a']);
  });

  test('resolves a mention followed by sentence punctuation', async () => {
    // The regex captures "alice." — the trailing-punctuation-stripped variant
    // must also be tried so the intended user still resolves.
    expect(await extractMentions('thanks @alice.')).toEqual(['a']);
    expect(await extractMentions('was it @alice_ or someone else')).toEqual(['a']);
    expect(await extractMentions('ping @alice-')).toEqual(['a']);
  });

  test('still resolves usernames that legitimately end in punctuation chars', async () => {
    User.__setUsers([{ _id: 'p', username: 'trailing.' }]);
    expect(await extractMentions('hi @trailing.')).toEqual(['p']);
  });

  test('resolves dotted usernames without dropping their inner punctuation', async () => {
    // "@bob.smith." → capture "bob.smith." → stripped variant "bob.smith" matches
    expect(await extractMentions('cc @bob.smith.')).toEqual(['b']);
  });

  test('dedupes when the same user is mentioned multiple times', async () => {
    expect(await extractMentions('@alice @alice @ALICE')).toEqual(['a']);
  });

  test('excludes the author when excludeUserId is passed', async () => {
    expect(await extractMentions('@alice and @bob.smith', 'a')).toEqual(['b']);
    expect(await extractMentions('@alice', 'a')).toEqual([]);
  });

  test('caps the number of mentions per post', async () => {
    // Build a post with 15 valid mentions; expect only MAX_MENTIONS_PER_POST resolved
    const lots = Array.from({ length: 15 }, (_, i) => `@alice${i}`).join(' ');
    User.__setUsers(
      Array.from({ length: 15 }, (_, i) => ({ _id: `id${i}`, username: `alice${i}` }))
    );
    const result = await extractMentions(lots);
    expect(result.length).toBeLessThanOrEqual(MAX_MENTIONS_PER_POST);
  });

  test('does not match @ followed by fewer than 3 chars', async () => {
    expect(await extractMentions('@a @ab')).toEqual([]);
  });
});

describe('MENTION_RE', () => {
  test('exposes the regex for downstream use (e.g. composer highlighting)', () => {
    expect(MENTION_RE).toBeInstanceOf(RegExp);
    expect(MENTION_RE.flags).toContain('g');
  });
});
