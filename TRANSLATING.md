# Translating Cellarion

Cellarion's interface is community-translated. Thank you for helping!

## How it works

- UI strings live in `frontend/src/locales/<language>/translation.json` (one file per language, [i18next](https://www.i18next.com/) format).
- **English (`en`) is the source language** — it is maintained by the developers alongside the code. Every other language is a translation of it.
- Translations are contributed through **Weblate**, a web-based translation tool — no programming or Git knowledge needed:

  👉 **https://hosted.weblate.org/projects/cellarion/**

  Weblate shows each English string with context, suggests machine translations you can correct, tracks per-language completeness, and opens pull requests against this repo automatically.

**Please do not open pull requests that edit `translation.json` files directly** (except for `en`, which is developer-maintained). Direct edits conflict with Weblate's two-way sync and will be closed with a friendly pointer here.

## Translation guidelines

1. **Keep placeholders exactly as they are.** Anything in double curly braces is replaced with a value at runtime and must survive translation untouched:
   - `"{{count}} bottles in {{cellar}}"` → `"{{count}} flaskor i {{cellar}}"` ✔
   - Renaming or dropping a placeholder shows the raw `{{...}}` text to users.
   - Some placeholders carry a format, e.g. `{{count, number}}` — keep the `, number` part too.

2. **Plural forms.** Keys ending in `_one` / `_other` are plural variants selected by `count`. Translate each form for your language's grammar — the `_one` form may drop the number entirely if that reads better (e.g. `"one bottle"`). Languages with more plural categories (e.g. Polish, Arabic) get additional forms (`_few`, `_many`, …) in Weblate automatically.

3. **Wine terminology.** Check the project glossary in Weblate before inventing a translation for domain terms (drink window, maturity, appellation, rack, vintage…). Consistency matters more than any single "best" word.

4. **Tone.** Informal but precise — address the user directly (Swedish: du-form). Cellarion is a hobbyist's tool, not enterprise software.

5. **Don't translate:** product names (Cellarion, CellarTracker, Vivino), technical identifiers, or the demo email addresses.

## How a new language gets shipped

1. Request the language in Weblate (or open a GitHub discussion) and start translating.
2. When the language reaches **~90 % translated**, we enable it in the app (`frontend/src/i18n.js` — it is added to `supportedLngs` and the lazy-loading table) in the next release.
3. Untranslated strings fall back to English, so a shipped language degrades gracefully while you finish it.

## Notes for developers

- **Never delete "unused-looking" keys.** Many keys are referenced dynamically — e.g. `t(`support.status.${ticket.status}`)` resolves keys that no grep for the literal key will find. The locale test suite, not string search, is the authority.
- New user-facing strings go into `en/translation.json` in the same PR as the code. Don't machine-translate them into the other languages — leave that to Weblate, where translators see them as new work.
- Don't build sentences by concatenating strings or placing numbers next to `t()` calls — put the whole sentence in one key and interpolate (`{{count}}`, `{{name}}`). Word order differs across languages.
- Renaming a key discards its existing translations in every language. Reword the English value only when the *meaning* changes (Weblate then flags translations for review); avoid renaming keys casually.
- `frontend/src/locales/translation.test.js` enforces structural integrity (key parity across languages, placeholder consistency, no empty strings) and runs in CI on every PR.
