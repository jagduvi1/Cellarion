/**
 * Locale integrity.
 *
 * Component tests mock react-i18next with `t: (key, fallback) => fallback`, so
 * they assert the inline English fallbacks and never touch these files at all —
 * every `connectAi.*` key could be deleted from both locales and the whole UI
 * suite would still pass. This suite is the thing that actually reads them.
 *
 * Locales are Weblate-managed and may legitimately lag `en` — i18n.js sets
 * fallbackLng 'en', so untranslated keys degrade to English until a
 * translator catches up. What is never legitimate: keys `en` doesn't have
 * (stale leftovers, typo'd renames), empty strings, or placeholders the
 * English source lacks. That's what this suite polices; the connectAi block
 * below additionally pins full coverage for the one page where partial
 * translation would be load-bearing.
 */

import en from './en/translation.json';
import sv from './sv/translation.json';

// Picks up every locale automatically so community languages added via
// Weblate are covered without touching this file.
const bundles = Object.fromEntries(
  Object.entries(import.meta.glob('./*/translation.json', { eager: true }))
    .map(([path, mod]) => [path.split('/')[1], mod.default])
);
const otherLocales = Object.entries(bundles).filter(([code]) => code !== 'en');

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, key) : [key];
  });

const enKeys = flatten(en);

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// CLDR plural categories differ per language (Swedish has one/other, Polish
// adds few/many, …), so parity is compared on plural-suffix-stripped keys.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const normalize = (keys) => [...new Set(keys.map((k) => k.replace(PLURAL_SUFFIX, '')))];

// "{{count, number}}" → "count" — the format part is per-string, the
// variable name must survive translation exactly.
const placeholders = (str) =>
  [...str.matchAll(/\{\{\s*([^,}\s]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]);

describe('translation files', () => {
  // Missing keys are allowed (a Weblate-managed language mid-translation is
  // the normal state); orphaned keys are not.
  test.each(otherLocales)('%s has no keys that en lacks (ignoring plural suffixes)', (code, bundle) => {
    const keys = normalize(flatten(bundle));
    const base = normalize(enKeys);
    const orphaned = keys.filter((k) => !base.includes(k));
    expect(orphaned).toEqual([]);
  });

  test.each(Object.entries(bundles))('%s has no key resolving to an empty string', (code, bundle) => {
    const blank = flatten(bundle).filter((k) => {
      const v = get(bundle, k);
      return typeof v === 'string' && v.trim() === '';
    });
    expect(blank).toEqual([]);
  });

  test.each(Object.entries(bundles))('%s: every leaf is a string (a stray object or null breaks interpolation)', (code, bundle) => {
    const nonString = flatten(bundle).filter((k) => typeof get(bundle, k) !== 'string');
    expect(nonString).toEqual([]);
  });

  // A translated string may only use placeholders that exist in its English
  // source — a renamed or invented placeholder renders as literal "{{...}}".
  // Subset (not equality) because plural _one forms may legitimately drop
  // {{count}} ("one bottle").
  test.each(otherLocales)('%s uses no placeholder that en does not have', (code, bundle) => {
    const enAllowed = new Map();
    for (const k of enKeys) {
      const norm = k.replace(PLURAL_SUFFIX, '');
      const set = enAllowed.get(norm) || new Set();
      placeholders(get(en, k)).forEach((p) => set.add(p));
      enAllowed.set(norm, set);
    }
    const bad = flatten(bundle).flatMap((k) => {
      const v = get(bundle, k);
      if (typeof v !== 'string') return [];
      const allowed = enAllowed.get(k.replace(PLURAL_SUFFIX, ''));
      if (!allowed) return [];
      return placeholders(v)
        .filter((p) => !allowed.has(p))
        .map((p) => `${k}: {{${p}}}`);
    });
    expect(bad).toEqual([]);
  });

  // A key ending in _one/_other/… is a CLDR plural family to i18next AND to
  // Weblate — which scaffolds "missing" sibling forms as empty strings. Enum
  // lookups must therefore never use a plural suffix (nest them instead:
  // bottles.statusLabels.other), and real plural families in the source
  // language must be complete: English has exactly one + other.
  test('en plural families are complete and never collide with enum keys', () => {
    const forms = new Map();
    for (const k of enKeys) {
      const m = k.match(PLURAL_SUFFIX);
      if (!m) continue;
      const base = k.replace(PLURAL_SUFFIX, '');
      forms.set(base, [...(forms.get(base) || []), m[1]]);
    }
    const broken = [...forms.entries()]
      .filter(([base, f]) => !(f.includes('one') && f.includes('other')) || enKeys.includes(base))
      .map(([base, f]) => `${base} (forms: ${f.join(',')}${enKeys.includes(base) ? ' + bare base key' : ''})`);
    expect(broken).toEqual([]);
  });

  // The public MCP connect page is the one surface whose copy is load-bearing
  // for distribution — it is what a stranger reads before trusting us with
  // their cellar. Pin its shape so a partial merge cannot half-ship it.
  describe('connectAi (public MCP set-up page)', () => {
    const CLIENTS = ['claude', 'claudeDesktop', 'claudeCode', 'chatgpt', 'vscode', 'cursor', 'gemini', 'stdio'];

    test.each(['en', 'sv'])('%s has the full connectAi block', (locale) => {
      const bundle = locale === 'en' ? en : sv;
      const block = bundle.connectAi;
      expect(block).toBeDefined();

      for (const k of ['title', 'subtitle', 'beta', 'copy', 'copied', 'clientsTitle', 'publicTitle', 'publicBody', 'rawTitle', 'rawBody', 'selfHostNote', 'helpLink', 'privacyLink']) {
        expect(typeof block[k]).toBe('string');
      }
      for (const k of ['title', 'body', 'cta']) {
        expect(typeof block.oneClick[k]).toBe('string');
      }
      for (const k of ['title', 'body', 'readTitle', 'readBody', 'consumeTitle', 'consumeBody', 'writeTitle', 'writeBody', 'tokenNote']) {
        expect(typeof block.access[k]).toBe('string');
      }
      // Every client card the page maps over must have copy in both locales.
      expect(Object.keys(block.clients).sort()).toEqual([...CLIENTS].sort());
      for (const c of CLIENTS) {
        expect(typeof block.clients[c].title).toBe('string');
        expect(typeof block.clients[c].body).toBe('string');
      }
    });

    test('the token note does not claim URL-based configs need a token', () => {
      // The URL set-ups (VS Code, Cursor, Gemini CLI) authenticate over OAuth
      // and have no token field, so telling people to paste one there sends
      // them looking for a slot that does not exist.
      expect(en.connectAi.access.tokenNote).toMatch(/OAuth/);
      expect(en.connectAi.access.tokenNote).toMatch(/stdio/);
    });
  });

  test('the pages linking to /connect-ai have their link labels', () => {
    for (const bundle of [en, sv]) {
      expect(typeof bundle.landing.footerConnectAi).toBe('string');
      expect(typeof bundle.help.connectAiLink).toBe('string');
      expect(typeof bundle.settings.aiConnect.oneClickCta).toBe('string');
      expect(typeof bundle.settings.aiConnect.docsLink).toBe('string');
    }
  });
});
