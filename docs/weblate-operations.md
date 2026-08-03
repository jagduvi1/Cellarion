# Running Weblate for Cellarion — maintainer's guide

[TRANSLATING.md](../TRANSLATING.md) is for translators. This is for whoever administers the Weblate project: what to click, what to never click, and why.

Project: **https://hosted.weblate.org/projects/cellarion/**

---

## 1. The mental model

Weblate is a two-way sync between a web editor and this Git repo. Nothing else about it makes sense until that's clear.

```
       en/translation.json                      other locales
    (you, in feature PRs)                  (Weblate, in bot PRs)
              │                                      ▲
              ▼                                      │
        main on GitHub ──── webhook ────►  Weblate pulls, shows new
              ▲                            strings as "untranslated"
              │                                      │
              └────── bot opens a PR ◄───────────────┘
                     (you review + squash-merge)
```

Three consequences worth internalising:

- **English is yours, everything else is Weblate's.** You add `en` strings in the same PR as the code. You never hand-edit `sv`/`fr`/`de` — that fights the sync. (The one sanctioned exception is bootstrapping a whole new language, which is what #867 did, and it comes with a `MACHINE_DRAFTED` entry.)
- **Weblate writes to the repo through pull requests**, because the component's VCS is "GitHub pull request" with an empty push URL. Its bot forks, commits, opens a PR. You are the merge gate.
- **Approval state never reaches the repo.** i18next JSON has no field for "reviewed", so approvals live only in Weblate's database. The Approved % climbing produces *no commits*. This is why graduating a language is a manual repo edit (§6).

---

## 2. Reading the Languages page

The column names are not obvious. On the project's **Languages** tab:

| Column | What it actually means |
|---|---|
| **Approved** | A reviewer has read it and ticked it. The only signal that a human checked the text. |
| **Translated** | A string exists. Says nothing about quality — machine output counts. |
| **Unreviewed** | Translated but not approved. **This is the review queue.** Click the number to open it. |
| **Unfinished** | Untranslated + needing-edit. What a translator filling blanks should work from. |
| **Untranslated** | Empty. |
| **Checks** | Weblate's automated warnings (placeholder mismatch, punctuation, etc.). Worth a periodic skim. |
| **Suggestions** | Proposals awaiting accept/reject. People often use these instead of editing directly. |

Weblate's percentages count **all** strings; ours exclude the admin back-office. That's why Weblate says Swedish is 95 % and the app says 98 %. Both correct — use ours to judge "ready for users", Weblate's to judge "work left".

---

## 3. Where everything lives

The project menu is `Languages · Components · Diagnostics · Overview · Search · Insights ▾ · Files ▾ · Operations ▾ · Community ▾`. There is no "Manage" menu; that's what trips people up.

| I want to… | Path |
|---|---|
| Invite a contributor, grant Review | **Operations → Users** |
| Add an automatic-suggestion engine | **Operations → Automatic suggestions** (a page of its own, *not* a Settings tab) |
| Fix JSON indentation on write | **Operations → Settings → Files → File format parameters** |
| Pull the repo after a release | **Operations → Update** (usually automatic via webhook) |
| See who contributed, with counts | **Insights → Credits** (pick a date range) |
| See who did what, when | **Insights → History** |
| Upload a translation as suggestions | **Files → Upload translation**, method *Add as suggestion* |
| Find the review queue | Click **Unreviewed** on the Languages page, or search `state:translated NOT state:approved` |

---

## 4. The review workflow

Reviews are **on**, which is what makes the Approved column exist.

- Because project access is **Public**, any signed-in user can already **edit** any unapproved string. Contributors need no permission from you to fix something wrong.
- **Approving requires the `Review` role.** Ordinary translators cannot approve, and they can no longer edit a string *once it is approved* — approval effectively locks it to reviewers.
- Grant it at **Operations → Users**: add an existing user by username (they confirm by invitation) or invite by e-mail (they register, then get access). Pick the **Review** team, not Administration — Administration also hands over settings, VCS and access control.
- **Scope the grant to one language**, so a French volunteer can't approve Swedish. Two ways, both fine:
  - Set a **Language limit** on the user directly in the *Add a user* form — the built-in project-wide `Review` team plus a limit is the fewest moving parts.
  - Or make `Reviewers (sv)` / `(fr)` / `(de)` teams under the **Teams** tab and add people to those. More typing, but the Teams table then shows at a glance who can approve what, which is worth having once there is more than one reviewer.
- ⚠️ **Whichever you choose, check the language you picked matches the locale directory.** See §7 — `Swedish (sv_SV)` is a plausible-looking wrong answer that grants nothing at all.
- Trust is earned in-band: let people translate, read their work under **Insights → Credits**/**History**, then promote the good ones. Don't wait for pre-trusted strangers.

A `Review` team covering **all languages** already exists — Weblate creates it when the review workflow is on, so there is nothing to build before you can approve. If you are in **Administration**, you have review rights through that alone. Confirm rather than assume: open an unreviewed string and look for the Approve control. If it isn't there, add yourself to a Review team.

---

## 5. Routine: when a Weblate PR appears

1. **Content-diff it against `main` first.** Never blind-merge. `git fetch origin pull/N/head && git checkout FETCH_HEAD` and compare the flattened JSON. This has caught resurrected deleted keys and blanked plurals before.
2. Check CI is green — [`translation.test.js`](../frontend/src/locales/translation.test.js) is the real gate (no keys `en` lacks, no empty strings, placeholder parity, complete plural families).
3. **Squash**-merge. The repo requires it.
4. Weblate pulls the squash automatically. If it later claims "needs merge" or shows an outgoing commit, a plain **Update** resolves it — its own commit is content-identical to the squash.

---

## 6. Routine: graduating a language

When a language has genuinely been read by a speaker:

1. Confirm the Approved % in Weblate reflects real review, not a bulk-approve.
2. Remove the code from `UNREVIEWED` — and from `MACHINE_DRAFTED` if it was drafted — in [`frontend/src/locales/coverage.js`](../frontend/src/locales/coverage.js).
3. If it crosses 90 % of user-facing units, it stops being beta automatically. Add it to `CRAWLER_LANGUAGES` in [`backend/src/config/languages.js`](../backend/src/config/languages.js) in the same release, or the crawler pages won't advertise it.
4. Ship it in a normal release and say so in the notes.

Nothing about this can be automated from Weblate's side — see §1.

---

## 7. Things that will bite you

Each of these has already happened once.

- **Never use "Reset and reapply"** on a rebase-conflict alert. It wrote 3,195 database units over newer `main`: resurrected deleted keys, blanked plurals, reverted fresh Swedish. The correct recovery is **"Reset and discard"** — upstream is the truth — then redo the handful of Weblate-side edits by hand.
- **Weblate scaffolds missing CLDR plural siblings as empty strings.** French has one/many/other, so an `_other` without a `_many` gets an empty `_many` on the next sync, which fails the no-empty-strings test. French locale files therefore carry an explicit `_many`.
- **Never end a key in `_one`/`_other`/`_few`/`_many`/`_zero`/`_two` unless it is a real plural.** Weblate treats the suffix as a plural family and scaffolds empty siblings around it. Nest enums instead (`bottles.statusLabels.other`).
- **Renaming a key discards its translations in every language.** Reword the English *value* when the meaning changes (Weblate then flags translations for review); don't rename keys casually.
- **Never delete "unused-looking" keys.** ~50 are resolved dynamically (`` t(`support.status.${s}`) ``) and no grep will find them. The locale test suite is the authority, not string search.
- **Set JSON indentation to 2** under Settings → Files → File format parameters. The default of 4 produced a 379 KB whole-file first diff. (The old "Customize JSON output" add-on was removed in Weblate 5.13.)
- **Stale keys**: when `en` drops a key, translations keep it and CI fails on the orphan. Fix with the **Cleanup translation files** add-on, or one-off via **Cleanup unused** under Repository maintenance. It only removes keys absent from the base file — it does not inject empty strings, and it does no code analysis, so dynamic keys are safe.
- **Do not poll `hosted.weblate.org`** with scripts or monitors. Their fail2ban banned the office IP for a day around a GitHub OAuth login. Use a browser; use mobile data if it looks unreachable. Anthropic's fetcher is blocked by their bot protection too, so an AI assistant cannot verify project pages for you.
- **Automatic suggestions are *already on*, and the page is not where you'd look.** It's **Operations → Automatic suggestions** — its own page, a sibling of Settings, not a tab inside it. (Settings has exactly five tabs: Basic, Access, Workflow, Commit messages, Components.) Hosted Weblate installs three engines **site wide** for every project: Weblate Translation Memory, LibreTranslate, and Apertium APy. The keyless ones worth adding on top are **MyMemory** (the best single addition for our languages) and **Glosbe**. **Anthropic sits third in the Available list — don't.** It, and OpenAI/DeepL/Google/Azure/Amazon, bill your own API key on every translator's click, and this project is public. If you ever want one, use a separate key with a hard spend cap.
- **Weblate Translation Memory is nearly empty until you tick "Use shared translation memory"** (Settings → **Workflow** tab). Without it the engine can only offer strings this project has already translated — near-useless on a young locale. Ticking it opens the cross-project pool, at the price of contributing ours back to it.
- **Scope a review team to the language the repo actually uses.** Weblate's language list contains near-miss entries: picking `Swedish (sv_SV)` for a `Reviewers (sv)` team looks right and silently grants nothing, because our locale directory — and therefore the project's language object — is plain `sv`. (`sv_SV` isn't even Sweden; that's `SE`.) The failure is invisible: members simply never see an Approve control, with nothing to explain why. Check the code on the team against the directory name under `frontend/src/locales/`.
- **Do not use Operations → Automatic translation** (the bulk one). It writes machine output in as real translations, which is how you end up with a "100 % translated" language nobody has read.

---

## 8. Billing and hosting

- **Libre was approved on 2026-08-03**, so the plan is settled and the trial clock is gone. Kept for whoever does this next: Libre is free for libre projects but requires **human approval**, the trial has a hard expiry date, and the **Contact** link is how you chase it if approval lags more than a week. Ours was granted partly on the strength of crediting Weblate in the README and on the site — that's a guideline, not a courtesy.
- Approval criteria are a checklist on that page: one project, a public URL, components under a libre licence. When they're all ticked, there is nothing left for you to do but wait.
- The **glossary** component (`local:` repository) permanently shows "outbound delivery is manual" and "updates are pulled manually" warnings. They are inapplicable — it has no VCS — and will never clear. Ignore them.

---

## 9. Glossary discipline

The project glossary is a component like any other (TermBase eXchange, local repo). Canonical Swedish, decided by the maintainer: **drickfönster · ställ · källare**. French and German equivalents are in TRANSLATING.md. Add a term whenever a reviewer asks "what do we call X" — that question will be asked again.

Brand names that must never be translated: Cellarion, CellarTracker, Vivino, and the AI client names.

---

## 10. A first-week checklist

- [x] ~~Chase Libre approval if the trial is close to expiring.~~ Approved 2026-08-03.
- [ ] Confirm you personally can approve a string; if not, add yourself to a Review team.
- [ ] Create `Reviewers (sv)` / `(fr)` / `(de)` teams, empty for now — checking each one's language against the locale directory name (§7).
- [ ] Skim **Insights → Credits** for the last month — those are your reviewer candidates.
- [ ] Work the Swedish `Unreviewed` queue yourself; you're the native speaker and it needs nobody else.
- [ ] Triage the pending **Suggestions** (accept, reject, or comment).
- [ ] Tick **Use shared translation memory** (Settings → Workflow), then install **MyMemory** and **Glosbe** (§7) — the three site-wide engines are already on, so this is topping up rather than starting from nothing.
- [ ] Set JSON indentation to 2 if it isn't already.

---

## Key files

| Path | Role |
|---|---|
| [`TRANSLATING.md`](../TRANSLATING.md) | The contributor-facing side: guidelines, glossary rules, how a language ships |
| [`frontend/src/locales/coverage.js`](../frontend/src/locales/coverage.js) | Coverage maths, `BETA_BELOW` / `LIST_ABOVE` floors, `MACHINE_DRAFTED`, `UNREVIEWED` |
| [`frontend/src/locales/translation.test.js`](../frontend/src/locales/translation.test.js) | The CI gate on every Weblate PR — orphan keys, empty strings, placeholders, plural families |
| [`frontend/vite-plugins/localeCoverage.js`](../frontend/vite-plugins/localeCoverage.js) | Builds `virtual:locale-coverage` at build time from the locale directories |
| [`frontend/src/i18n.js`](../frontend/src/i18n.js) | Locale discovery, `fallbackLng`, browser detection (skips beta languages) |
| [`frontend/src/components/LanguagePicker.js`](../frontend/src/components/LanguagePicker.js) | The menu labels, including `(beta · unreviewed)` |
| [`backend/src/config/languages.js`](../backend/src/config/languages.js) | `CRAWLER_LANGUAGES` — the hand-maintained hreflang mirror |
