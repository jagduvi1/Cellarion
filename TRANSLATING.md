# Translating Cellarion

Cellarion's interface is community-translated. Thank you for helping!

## How it works

- UI strings live in `frontend/src/locales/<language>/translation.json` (one file per language, [i18next](https://www.i18next.com/) format).
- **English (`en`) is the source language** — it is maintained by the developers alongside the code. Every other language is a translation of it.
- Translations are contributed through **Weblate**, a web-based translation tool — no programming or Git knowledge needed:

  👉 **https://hosted.weblate.org/projects/cellarion/**

  Weblate shows each English string with context, tracks per-language completeness, and opens pull requests against this repo automatically.

  Weblate can also offer machine/AI suggestions you correct rather than typing from scratch, but they are **not on by default**: an engine has to be added to the project first, under Operations → Settings → Automatic suggestions. The keyless engines (Weblate Translation Memory, Glosbe, MyMemory) need nothing; the AI ones (Anthropic, OpenAI, DeepL, Google) need an API key the project owner supplies. If the Automatic suggestions tab is empty when you translate, that is why — ask, don't assume it is broken.

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
2. **Your language appears in the app as soon as there is something to see** — Weblate opens a pull request, and once that is merged the language shows up in Settings → Language on the next release, from about 10 % onwards. Until it is complete it is labelled with how far along it is, e.g. `Français (beta · 62 %)`, and untranslated text stays in English.
   Before that 10 %, preview your work by adding `?lng=<code>` to any page — `https://cellarion.app/?lng=fr` switches that browser to French even while it is empty. It is the fastest way to catch the things a string list hides: clipped buttons, the wrong register, a word that was right in one context and wrong in another.
3. Anyone can select a beta language deliberately, but nobody is switched into one automatically: browser-language detection only ever selects a finished language, and only finished languages are declared to search engines.
4. At **90 % of user-facing strings** the label and the restrictions drop off by themselves — no code change, no waiting for someone to add your language to a list.

### Machine-drafted languages are a special case

French and German did not start from zero: their first pass was **drafted in bulk by the maintainers** so that reviewing beats typing. Those languages are listed in `MACHINE_DRAFTED` in [`frontend/src/locales/coverage.js`](frontend/src/locales/coverage.js) and **stay labelled beta at any percentage** — the percentage only knows that a string is *filled*, and a drafted locale is 100 % filled and 0 % read.

What that means if you translate French or German: everything is already there, so your work is **reviewing, not filling in blanks**. In Weblate the queue you want is *unreviewed* strings, not *untranslated* ones — read what is there, fix what is wrong, and approve what is right. The search query is:

```
state:translated NOT state:approved
```

When enough of a language has been read by an actual speaker, a maintainer removes it from `MACHINE_DRAFTED` and it graduates the normal way.

### "Unreviewed" is tracked separately from "beta"

A language can be complete and still unread, so those are two flags, not one:

| | label in Settings → Language | offered in the menu | auto-selected from the browser | declared via hreflang |
|---|---|---|---|---|
| `en` | English | yes | yes | yes |
| `sv` (98 %, 1 % approved) | `Svenska (unreviewed)` | yes | **yes** | **yes** |
| `fr` / `de` (drafted) | `Français (beta · unreviewed)` | yes | no | no |

`UNREVIEWED` in [`coverage.js`](frontend/src/locales/coverage.js) is **label-only**: it never changes whether a language ships. Swedish is honest about its review state without losing the auto-detection and search visibility it has had since v1.88.0 — telling Swedish users nothing is wrong, but handing them an English UI to make a point about process would be. Fitness to ship stays governed by `beta`.

Drafted languages deliberately show no percentage. `beta · 100 %` reads as a contradiction; what is missing is a reader, not a string.

### What counts toward the percentage

The admin back-office (`admin*`, `moderationReports` — roughly 14 % of all strings) is **excluded from the calculation**. Translate everything a normal user can reach and you are at 100 %, whether or not you ever touch the admin panels. Those strings are still translatable and welcome — they just don't gate your language.

Coverage is counted in *units*, the same way Weblate counts them: a plural family is one unit however many forms your language needs, so languages with richer plural rules aren't penalised. The maths lives in `frontend/src/locales/coverage.js`; the number the app shows is computed at build time from the locale files themselves, so it is never stale.

## Notes for developers

- **Never delete "unused-looking" keys.** Many keys are referenced dynamically — e.g. `t(`support.status.${ticket.status}`)` resolves keys that no grep for the literal key will find. The locale test suite, not string search, is the authority.
- New user-facing strings go into `en/translation.json` in the same PR as the code. Don't machine-translate them into the other languages — leave that to Weblate, where translators see them as new work. (Bootstrapping a whole *new* language in one deliberate pass is the one exception, and it comes with a `MACHINE_DRAFTED` entry so nothing ships as reviewed that nobody has read.)
- Don't build sentences by concatenating strings or placing numbers next to `t()` calls — put the whole sentence in one key and interpolate (`{{count}}`, `{{name}}`). Word order differs across languages.
- Renaming a key discards its existing translations in every language. Reword the English value only when the *meaning* changes (Weblate then flags translations for review); avoid renaming keys casually.
- **Never end a key in `_one`, `_other`, `_zero`, `_two`, `_few` or `_many` unless it is a real plural.** Those suffixes mark CLDR plural families for i18next *and* Weblate — an enum key like `status_other` ("other" status) gets mistaken for an incomplete plural and Weblate scaffolds empty sibling forms. Nest enums instead (`bottles.statusLabels.other`), and give every real plural family both `_one` and `_other` in English (no bare base key as the singular).
- **Nothing needs adding to a list when a language arrives.** `frontend/src/i18n.js` discovers locales from the directories themselves (`import.meta.glob`), and completeness comes from the `virtual:locale-coverage` module built by `frontend/vite-plugins/localeCoverage.js`. Dropping in `fr/translation.json` is the whole change.
- **The directory name is the language code**, and it is what the app addresses the locale by — `pt-BR` and `pt_BR` both work (exact match first, base subtag second), but prefer Weblate's BCP-47 hyphen style so `<html lang>` and `Intl.DisplayNames` get a valid tag without normalising.
- **When a language crosses 90 % it graduates automatically** — except for two hand-maintained gates: `MACHINE_DRAFTED` in `frontend/src/locales/coverage.js` (a bulk-drafted language stays beta until a human review pass clears it), and `CRAWLER_LANGUAGES` in `backend/src/config/languages.js`, which the crawler-rendered pages in `routes/og.js` use for `hreflang`. The backend image doesn't ship the locale files, so add the language there in the release that announces it.
- `frontend/src/locales/translation.test.js` enforces structural integrity (no keys en lacks, placeholder consistency, plural-family completeness, no empty strings — locales may lag en; untranslated keys fall back to English) and runs in CI on every PR.
