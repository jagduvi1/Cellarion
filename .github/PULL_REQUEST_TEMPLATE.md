## What this changes

<!-- One or two sentences. What was wrong or missing, and what this does about it. Link the issue or discussion if there is one. -->

## How I tested it

<!-- What you actually ran and looked at. For anything visual, a screenshot in both light and dark theme helps a lot. -->

## Checklist

- [ ] `cd frontend && npm test` passes
- [ ] `cd backend && npm test` passes
- [ ] Smoke-tested in Docker (`docker compose up --build`) and used the change in the app
- [ ] Commits are signed off (`git commit -s`, see CONTRIBUTING.md)
- [ ] No non-English `translation.json` files touched (those go through Weblate)
- [ ] If personal data is stored, processed or shared: export, deletion cascade, consent, audit log, minimisation and retention are covered (see CONTRIBUTING.md)
- [ ] If AI tools helped write this, that is mentioned above and I have run the result myself
- [ ] No support-ticket ids, user handles or user data in the diff, the commit messages or this description

## If this is a move, comment-only or behaviour-changing refactor

<!-- Delete the lines that do not apply. -->

- [ ] **Move:** one extraction, old file re-exports, no test edited, comments on the moved code updated, `node scripts/check-file-sizes.mjs --update` run (see CONTRIBUTING.md, "Moving code out of a long file")
- [ ] **Comment-only:** `node scripts/check-comment-only.mjs origin/main` passes (with `--test-titles` if test names changed)
- [ ] **Behaviour change inside a refactor:** named here, with the test that pins the new behaviour
