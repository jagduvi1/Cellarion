/**
 * Forum language sections — the shared rules.
 *
 * POLICY UNDER TEST (Johan, 2026-08-31): English is the forum. It is the
 * default for reading and for writing, a member picks another language
 * deliberately, and a moderator moves anything mis-filed. These tests pin the
 * three asymmetries that make that work, because each one is easy to
 * "simplify" into a bug:
 *
 *  1. READ falls back to English for an unknown code (a stale bookmark shows
 *     the default section, it does not 400).
 *  2. WRITE refuses an unknown or closed code (silently filing a French thread
 *     in the English forum is the mis-file this feature exists to prevent).
 *  3. MOVE accepts a retired section as a target (consolidating a closed
 *     section's last threads is exactly what a move is for).
 */

jest.mock('../models/ForumLanguage', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  exists: jest.fn(),
}));

const ForumLanguage = require('../models/ForumLanguage');
const {
  DEFAULT_LANGUAGE, listActive, resolveWritableLanguage, resolveMoveTarget, resolveReadableLanguage,
} = require('./forumLanguages');

const lean = (value) => ({ select: () => ({ lean: async () => value }), lean: async () => value });

beforeEach(() => jest.clearAllMocks());

describe('listActive', () => {
  test('English leads, then the open sections by name', async () => {
    ForumLanguage.find.mockReturnValue({
      sort: () => ({ lean: async () => [
        { code: 'de', name: 'German', nativeName: 'Deutsch', status: 'active' },
        { code: 'fr', name: 'French', nativeName: 'Français', status: 'active' },
      ] }),
    });
    const list = await listActive();
    expect(list.map(l => l.code)).toEqual(['en', 'de', 'fr']);
    expect(list[0]).toMatchObject({ code: 'en', isDefault: true, status: 'active' });
    expect(list[1]).toMatchObject({ code: 'de', nativeName: 'Deutsch', isDefault: false });
  });

  test('English is never duplicated even if a row for it exists', async () => {
    ForumLanguage.find.mockReturnValue({
      sort: () => ({ lean: async () => [{ code: 'en', name: 'English', status: 'active' }] }),
    });
    const list = await listActive();
    expect(list.filter(l => l.code === 'en')).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
  });
});

describe('resolveReadableLanguage — a reader never gets an error', () => {
  test.each([[undefined], [null], [''], ['   '], [42], [{}]])('%p falls back to English', async (input) => {
    expect(await resolveReadableLanguage(input)).toBe(DEFAULT_LANGUAGE);
  });

  test('"all" means no filter — used by the blog-post and wine thread lists', async () => {
    expect(await resolveReadableLanguage('all')).toBeNull();
  });

  test('a known code filters by it, case and padding forgiven', async () => {
    ForumLanguage.exists.mockResolvedValue({ _id: 'x' });
    expect(await resolveReadableLanguage('  FR ')).toBe('fr');
  });

  test('an unknown code shows the default section rather than 400ing', async () => {
    ForumLanguage.exists.mockResolvedValue(null);
    expect(await resolveReadableLanguage('zz')).toBe(DEFAULT_LANGUAGE);
  });

  test('English never costs a lookup', async () => {
    expect(await resolveReadableLanguage('en')).toBe(DEFAULT_LANGUAGE);
    expect(ForumLanguage.exists).not.toHaveBeenCalled();
  });
});

describe('resolveWritableLanguage — a writer must mean it', () => {
  test('absent means English, so a client that sends no language still works', async () => {
    expect(await resolveWritableLanguage(undefined)).toEqual({ code: 'en' });
    expect(await resolveWritableLanguage('')).toEqual({ code: 'en' });
    expect(ForumLanguage.findOne).not.toHaveBeenCalled();
  });

  test('an open section is accepted', async () => {
    ForumLanguage.findOne.mockReturnValue(lean({ status: 'active', name: 'French' }));
    expect(await resolveWritableLanguage('fr')).toEqual({ code: 'fr' });
  });

  test('an unknown code is refused, NOT silently filed under English', async () => {
    ForumLanguage.findOne.mockReturnValue(lean(null));
    const res = await resolveWritableLanguage('zz');
    expect(res.error).toMatch(/No such forum language/);
    expect(res.code).toBeUndefined();
  });

  test('a requested-but-not-yet-open section takes no new threads', async () => {
    ForumLanguage.findOne.mockReturnValue(lean({ status: 'requested', name: 'Portuguese' }));
    expect((await resolveWritableLanguage('pt')).error).toMatch(/Portuguese section is not open/);
  });

  test('a retired section takes no new threads either', async () => {
    ForumLanguage.findOne.mockReturnValue(lean({ status: 'retired', name: 'German' }));
    expect((await resolveWritableLanguage('de')).error).toMatch(/German section is not open/);
  });

  test('a non-string is a clean error, not a crash', async () => {
    expect((await resolveWritableLanguage({ $ne: null })).error).toMatch(/must be a string/);
  });
});

describe('resolveMoveTarget — a moderator may tidy into a closed section', () => {
  test('a retired section IS a valid move target (unlike a new thread)', async () => {
    ForumLanguage.findOne.mockReturnValue(lean({ _id: 'x' }));
    expect(await resolveMoveTarget('de')).toEqual({ code: 'de' });
  });

  test('English needs no lookup', async () => {
    expect(await resolveMoveTarget('en')).toEqual({ code: 'en' });
    expect(ForumLanguage.findOne).not.toHaveBeenCalled();
  });

  test('a code nobody ever opened is refused', async () => {
    ForumLanguage.findOne.mockReturnValue(lean(null));
    expect((await resolveMoveTarget('zz')).error).toMatch(/No such forum language/);
  });

  test('an empty or non-string target is refused — a move must name a section', async () => {
    expect((await resolveMoveTarget('')).error).toMatch(/target language is required/);
    expect((await resolveMoveTarget(undefined)).error).toMatch(/target language is required/);
    expect((await resolveMoveTarget(7)).error).toMatch(/target language is required/);
  });
});
