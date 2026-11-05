# How I translated Cellarion into Norwegian Bokmål

This document describes how the Norwegian Bokmål (`nb`) translation was done, so other volunteer translators can reuse what worked and avoid what didn't. The Bokmål style rules and settled choices are in [nb.md](./nb.md), and the terms are in the Weblate glossary.

The Norwegian sources named here, Vinmonopolet and Språkrådet, are examples. For your own language, look for the equivalents: an authoritative wine vocabulary and the body that sets the spelling and grammar standards.

## Checklist for a new language

- [ ] Read [TRANSLATING.md](../../TRANSLATING.md)
- [ ] Check in Weblate whether anyone else is translating your language, and agree who does what
- [ ] Create one shared document: style guide, glossary with rejected alternatives, open issues, work plan
- [ ] Decide the 20 to 30 most frequent terms before translating anything
- [ ] Ground domain terms in an authoritative local source (for wine, the national retailer or a wine glossary; for Bokmål, Vinmonopolet)
- [ ] Find your language's official norms and plain-language advice (for Bokmål, Språkrådet) and use them as the basis for the language review
- [ ] Split the work into packages by feature, most visible first, admin last
- [ ] Always start from the latest Weblate download, never only from GitHub
- [ ] Per package: draft, reuse identical strings, run a language review, review as a table, then upload
- [ ] Read every string yourself before it goes into Weblate
- [ ] Check the package in the running app with the language preview
- [ ] Send source issues to the maintainer in small batches as you find them

## Summary

The short version: I did the translation on my own, with Claude as a drafting and consistency assistant. Before translating in volume, I fixed the key terms and the style in a shared glossary and style guide. I then worked through the app in 16 planned packages of roughly 100 to 360 strings, reviewed every draft by hand, and uploaded finished packages to Weblate as JSON. About 4,540 strings count towards 100%, plus around 900 admin and moderation strings that don't.

I read and own every string. Claude's suggestions were treated as machine drafts, and nothing went into Weblate without being read first.

## The process

1. **Write the glossary and style guide first.** One living document holds every decided term, the style rules, the list of open issues and the work plan. It is the single source of truth: if a term in a draft disagrees with the document, the document wins.
    - Style: informal and direct ("write like a wine friend who knows the app, not like an insurance company"), sentence case, imperative verbs on buttons, no "please", Norwegian number and date formats, «» quotation marks.
    - Terms: wine vocabulary grounded in established usage, for Bokmål mainly the glossary of Vinmonopolet, the state-owned retail monopoly for wine and spirits in Norway, whose product pages most Norwegian wine drinkers know, and app vocabulary chosen once and used everywhere. Each core term notes how many source strings it appears in, so I knew which choices mattered most (cellar: 414 strings, rack: 204).
    - A table of rejected alternatives, so settled questions don't get reopened by accident.
2. **Plan the work in packages.** I grouped the source file's sections into 16 packages by feature (wine page, pick lists, statistics, community, import and so on), ordered by how visible they are to users. Admin and moderation strings, which don't count towards the percentage, came last. The plan included milestones, for example "after package 7, Bokmål is at about 57%".
3. **Get the source strings straight from the repository.** The English source and the existing Bokmål were read from `frontend/src/locales` with a shallow git checkout. The latest JSON downloaded from Weblate was always the base, since it can contain edits made directly in Weblate.
4. **Draft a package with Claude.** For each package Claude:
    - reused existing Norwegian text for any string with exactly the same English source, so the app says the same thing everywhere;
    - applied the glossary and style guide;
    - read the app's source code when it was unclear where a string appears or what a placeholder becomes;
    - kept placeholders, plural keys (`_one`, `_other`, `_zero`) and product names intact.
5. **Run a separate language review.** A second pass checked every draft against the norms and plain-language advice of the language authority, for Bokmål Språkrådet (the Language Council of Norway, which sets the official spelling and grammar standards for Bokmål and Nynorsk), catching anglicisms in particular.
6. **Review as a table.** Each package was shown as a table with the English source and the Norwegian draft side by side, numbered as in Weblate's "All strings" view. New term choices and deliberate deviations from the English were listed under the table.
7. **Decide, then record.** New terms were proposed and only added to the glossary once I had decided. New rules went into a "rules from the translation" section.
8. **Merge into the JSON and upload.** Approved strings were merged into the Weblate JSON in source order, with checks that no keys disappeared and that placeholders matched the source. The file was uploaded to Weblate, and the work plan's "done" line was updated.
9. **Report source problems upstream.** Problems that can't be fixed in Weblate (hard-coded English, missing plural forms, number formatting tied to the browser locale) were collected in an "open issues" list for the maintainer.

## Examples

A few rows from the glossary, with the notes translated into English:

| English | Bokmål | Note |
| --- | --- | --- |
| cellar (414 strings) | kjeller | Short form in the interface. "Vinkjeller" in intros and help. |
| rack (204 strings) | reol | Covers all rack types, including wine cabinets. Not "hylle", which is a shelf. |
| journal | vindagbok | Chosen over "dagbok" and "vinjournal". |
| drink window | drikkevindu | Follows established Norwegian wine usage. |

And a review table for a package. The rows are illustrative and the numbers are made up:

| No. | English | Norwegian |
| --- | --- | --- |
| 12 | Save | Lagre |
| 13 | Copied! | Kopiert |
| 14 | {{count}} bottle / {{count}} bottles | Én flaske / {{count}} flasker |
| 15 | Please fill in a name | Fyll ut navn |

Under the table: no. 13 drops the exclamation mark and no. 15 drops "please", both following the style guide. No. 14 spells out "én" in the singular, which reads better in Norwegian. In Weblate, no. 14 is two keys, `_one` and `_other`; the table shows them on one row to save space.

## What worked well

- **Conventions decided early.** The core terms and style rules were settled in one session before most of the volume was translated. That made every later package faster, because the hard choices were already made.
- **One place for all knowledge.** Glossary, style guide, rejected alternatives, open issues and work plan lived in the same document. Nothing depended on remembering an earlier chat, and Claude read the document before every package instead of relying on its own memory of a term.
- **Grounding terms in real usage.** Using Vinmonopolet's vocabulary for wine terms gave choices that Norwegian wine drinkers already recognise, and settled debates quickly.
- **Prioritising by frequency.** Counting how many strings each term appears in showed where consistency mattered most.
- **Claude as a consistency checker.** Reusing identical source strings, applying the glossary mechanically, and checking placeholders and plural keys are tedious for a person and easy for a model. This removed most of the inconsistency that usually creeps into large translations.
- **Reading the code.** When a string was ambiguous, checking the source code showed where it appears and what a placeholder turns into. This avoided many guesses and also surfaced real bugs.
- **Honest drafts.** Claude flagged what it hadn't checked, for example whether a label fits on a button. That told me where to look closer during review.
- **Turning the workflow into a reusable instruction set.** The steps above were written down as a Claude skill, so each new session followed the same routine without re-explaining it.
- **Admin strings last.** Leaving strings that don't count towards the percentage for the end got users a usable translation sooner.

## What I would do differently

- **Start the glossary before the first string, not after.** Part of the app (about 42%) was already translated when the work plan was made. Some early strings then had to be checked against terms decided later.
- **Report source issues as they are found.** The open issues list grew long (hard-coded English text, dates and numbers formatted by the browser language, untranslated dialogs, unused keys). Sending them in small batches as I went would have got fixes into the app sooner.
- **Check in the running app continuously.** Testing button lengths and strings built from several pieces was postponed to the end. A quick check after each package, using the `?lng=nb` preview, would have caught truncation and odd combinations earlier.
- **Agree the delivery format at the start.** The table format and columns changed along the way. Fixing it early (numbered like Weblate) avoids rework.
- **Keep the rules section tidy.** Rules learned during translation were appended one by one and became a long, mixed list. Grouping them by topic now and then makes the guide easier for newcomers.
- **Open product naming questions sooner.** The names of the supporter tiers needed the maintainer's input and were among the last strings to be settled. Raising such branding questions early keeps them from blocking the last strings.

## Keeping it up to date

The translation is never finished, because the app keeps getting new strings. They show up as untranslated in Weblate. The same routine works for them in smaller batches: check Weblate regularly, draft against the glossary, review, and add any new terms to the glossary before they are used.

## Setting this up with an AI assistant

You can give this document to Claude or another AI assistant and let it set up the same workflow for your language. In Claude that means a project and a skill. Other assistants have similar features, such as projects, custom instructions or custom GPTs. What matters is having standing instructions and one place where the glossary lives.

**You read and own every string.** An assistant's output is a machine draft. Read each string yourself before it goes into Weblate, and don't upload anything you haven't read. That is what separates this from the bulk drafts described in TRANSLATING.md: a language only counts as reviewed when a speaker has read it.

Paste this document into the assistant, followed by this prompt:

```
I am translating Cellarion into [language] in Weblate. Above is a description
of how the Norwegian Bokmål translation was done. Help me set up the same
workflow for my language.

Before you create anything, ask me:
- which language and variant I am translating into
- how far the translation has come in Weblate
- which terms and style choices are already decided
- whether there is an authority for spelling and terminology I should follow
- how I want each package delivered for review

Then create:
1. A template for a glossary and style guide, with sections for decided terms,
   rejected alternatives, rules learned along the way, open issues for the
   maintainer, and a work plan.
2. A work plan that groups the sections of the English source file into
   packages by feature, most visible first, admin and moderation last.
3. Standing instructions for translating one package: read the glossary first,
   reuse existing translations of identical source strings, keep placeholders
   and plural keys intact, run a separate language review, and show the
   package as a table numbered like Weblate before anything is uploaded.

Everything you write is a draft. I read every string myself before anything
goes into Weblate.
```

Treat what the assistant produces as a starting point. The terms and style choices are yours to make.
