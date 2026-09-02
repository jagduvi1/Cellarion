# Contributing to Cellarion

Thanks for considering it. Cellarion is a wine-cellar manager that people run two ways: on the hosted service at [cellarion.app](https://cellarion.app), and self-hosted from this repository. Both are first-class, and a contribution is welcome for either.

This document covers code and documentation. **Translations go through Weblate, not pull requests** — see [TRANSLATING.md](TRANSLATING.md). **Security problems go through [SECURITY.md](SECURITY.md), never a public issue.**

## Before you start

- **Small fix or obvious bug:** just open the pull request.
- **New feature or a change in behaviour:** open an issue or a [Discussion](https://github.com/jagduvi1/Cellarion/discussions) first and say what you have in mind. Cellarion has a fairly clear idea of what it is — a better wine registry and a great add-a-bottle experience come before almost everything else — and a ten-minute conversation beats a week of work that does not land.
- Have a look at the open issues; some are labelled `good first issue`.

## Setting up

You need Docker and Node 20.

```bash
git clone https://github.com/<you>/Cellarion.git && cd Cellarion
cp .env.example .env            # set JWT_SECRET and MEILI_MASTER_KEY at minimum
docker compose up --build        # full stack on http://localhost
docker exec cellarion-backend node src/seed-demo.js   # demo data + demo accounts
```

For a tighter loop outside Docker: `cd backend && npm run dev` and `cd frontend && npm start` (frontend installs need `--legacy-peer-deps`). The README has the full picture, including the optional AI and analytics services.

## The workflow

1. Fork, then branch off `main`. Prefix the branch with what it is: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`.
2. Keep the change focused. One concern per pull request merges faster and is easier to revert if it has to be.
3. Write or update tests next to the code they cover. Backend tests are Jest files beside their source; frontend tests are Vitest.
4. **Run both suites** — pull requests with failing tests are not merged:
   ```bash
   cd frontend && npm test
   cd backend && npm test
   ```
5. **Smoke-test in Docker** (`docker compose up --build`) and actually use the thing you changed. If it is visual, look at it in both the light and dark theme.
6. Sign your commits (next section), push, and open the pull request against `main`. The template asks for a short description and a checklist; fill it in honestly.

Pull requests are squash-merged, so a tidy history on your branch is nice but not required. Commit messages follow the `type(scope): what changed` shape you will see in the log, for example `fix(cellars): transfer notification now delivers`.

## Sign your commits (DCO)

Cellarion uses the [Developer Certificate of Origin](https://developercertificate.org/). It is not a contract and there is nothing to register: a `Signed-off-by` line on each commit certifies that you wrote the change, or otherwise have the right to submit it, under the project's license.

```bash
git commit -s -m "fix(racks): keep slot labels visible on narrow screens"
```

To add it to existing commits: `git commit --amend -s` for the last one, or `git rebase --signoff main` for a branch. A check on pull requests from forks verifies the line is present.

## Conventions worth knowing

The codebase is consistent about a few things, and a contribution that follows them needs far less back and forth.

- **Frontend API calls live in `frontend/src/api/`**, one module per resource, each taking `apiFetch` from `useAuth()`. Pages import from there rather than writing URL strings.
- **Shared UI comes from shared components** — `Modal` for overlays, `BottleCard` for bottles in list and card view. Look before you build.
- **The bottle page has two action surfaces** — the desktop header and the mobile action bar. A new action goes in both.
- **Backend access checks are middleware**: `requireBottleAccess(minRole)` loads bottle, cellar and role in one step; `utils/cellarAccess.js` guards cellar mutations. Do not re-implement ownership checks inline.
- **Significant mutations are audit-logged** through `services/audit.js`.
- **Dependencies:** reach for a package when the problem is genuinely complex and well served by a mature library; skip it when a few lines of native code or a browser API do the job.
- **Strings:** add English text to the `en` locale only. Every other language is maintained in Weblate, and a pull request touching non-English `translation.json` files will conflict with its sync.

## Personal data

Cellarion stores people's cellars, notes and photos, and it takes GDPR seriously. If your change stores, processes or shares anything personal, it must also cover:

1. **Export** — include the data in `GET /api/users/me/export`.
2. **Deletion** — add the model to the account-deletion cascade.
3. **Consent** — a new category of processing, or a new third party, needs explicit consent before it happens.
4. **Audit log** — log the mutation.
5. **Minimisation** — store what the feature needs, not what might be useful one day.
6. **Retention** — if the data has a natural expiry, enforce it.

Never skip a feature because of this; implement it properly instead. Ask in the pull request if you are unsure which of these apply.

## AI-assisted contributions

Welcome, and please say so in the pull request. Two conditions: you must have run the change and looked at the result yourself, not only read the diff, and you take responsibility for it as you would for code you typed. A pull request whose description admits it was never run in the app will be sent back for that alone.

## What to expect

Cellarion is maintained by one person. Expect a first response within about a week, sometimes much faster, sometimes slower if life intervenes. Review may ask for changes; that is normal and not a judgement. Occasionally a change is declined because it pulls the product somewhere it is not going, and you will get the reason in plain words. Small, well-described pull requests with passing tests move fastest.

## License

Cellarion is licensed under the [GNU Affero General Public License v3.0](LICENSE). By contributing, you agree that your contribution is licensed under the same terms. Your DCO sign-off is the record of that.
