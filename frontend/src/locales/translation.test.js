/**
 * Locale integrity.
 *
 * Component tests mock react-i18next with `t: (key, fallback) => fallback`, so
 * they assert the inline English fallbacks and never touch these files at all —
 * every `connectAi.*` key could be deleted from both locales and the whole UI
 * suite would still pass. This suite is the thing that actually reads them.
 *
 * `sv` mirrors `en` key-for-key by convention: i18n.js sets fallbackLng 'en',
 * so a missing Swedish key degrades silently to English rather than failing
 * loudly — which is exactly why it needs a test.
 */

import en from './en/translation.json';
import sv from './sv/translation.json';

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, key) : [key];
  });

const enKeys = flatten(en);
const svKeys = flatten(sv);

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

describe('translation files', () => {
  test('en and sv mirror each other key-for-key', () => {
    const missingInSv = enKeys.filter((k) => !svKeys.includes(k));
    const missingInEn = svKeys.filter((k) => !enKeys.includes(k));
    expect({ missingInSv, missingInEn }).toEqual({ missingInSv: [], missingInEn: [] });
  });

  test('no key resolves to an empty string in either locale', () => {
    const blank = (locale, keys, obj) =>
      keys.filter((k) => typeof get(obj, k) === 'string' && get(obj, k).trim() === '').map((k) => `${locale}:${k}`);
    expect([...blank('en', enKeys, en), ...blank('sv', svKeys, sv)]).toEqual([]);
  });

  test('every leaf is a string (a stray object or null breaks interpolation)', () => {
    const nonString = enKeys.filter((k) => typeof get(en, k) !== 'string');
    expect(nonString).toEqual([]);
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
