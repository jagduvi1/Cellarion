# Security Policy

Cellarion is a self-hosted wine cellar manager, published under AGPL-3.0. This
document says how to report a vulnerability, what happens next, and what our
security posture actually is — including where it falls short.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting, which is enabled on this
repository:

**https://github.com/jagduvi1/Cellarion/security/advisories/new**

If you cannot use GitHub, email **info@cellarion.app** with "SECURITY" in the
subject line.

Helpful to include, though none of it is required — a report you are unsure
about is still worth sending:

- what the issue is, and what an attacker gains from it
- the steps to reproduce it, or a proof of concept
- the version or commit you tested, and whether it was hosted or self-hosted
- anything you think we would get wrong about it

### What happens next

| | |
|---|---|
| Acknowledgement | within **3 working days** |
| Initial assessment | within **7 days** — whether we can reproduce it, and how serious we think it is |
| Fix for a confirmed serious issue | as fast as we can; you will get progress updates rather than silence |
| Credit | named in the advisory and release notes if you want it, anonymous if you prefer |

We will tell you plainly if we think a report is not a vulnerability, and why —
you are welcome to argue with the reasoning.

Cellarion is maintained by one person. That means reports are read by a human
who can act on them immediately, and it also means please allow for time zones
and sleep. If something is being actively exploited, say so prominently and it
will jump the queue.

### Scope

In scope: this repository, and the hosted service at **cellarion.app**.

Out of scope, unless you can show real impact: reports produced solely by an
automated scanner with no working proof of concept; missing headers or
best-practice warnings with no demonstrable exploit; denial of service by volume;
social engineering; vulnerabilities in third-party services we consume.

Please do not test against other people's data on the hosted service. Register
your own account, or run it locally with `docker-compose up` — the whole point of
this being open source is that you can.

### Safe harbour

If you make a good-faith effort to follow this policy, we will not pursue or
support legal action against you for your research. If you are unsure whether
something is acceptable, ask first.

## Our security posture

Stated plainly so you can judge it yourself rather than take our word for it —
and because the code is public, you can verify all of it.

**What we do**

- All traffic over HTTPS. No database or internal service is reachable from the
  internet; only the web front end is exposed.
- Passwords hashed with bcrypt, never stored recoverably.
- Short-lived JWT access tokens with rotating, httpOnly refresh cookies.
- Role-based access control on every cellar and bottle route.
- Extensive audit logging of significant mutations.
- Rate limiting on authentication, writes and public endpoints.
- Servers in the EU (Finland). Backups encrypted and stored off-site, with the
  restore path tested rather than assumed.
- Automatic security updates on the host; dependency alerts via Dependabot.
- Full data export and account deletion, for GDPR portability and erasure.

**What we do not do**

- **The database volume is not currently encrypted at rest.** Backups are; the
  live volume is not. We are changing this.
- **No multi-factor authentication.** Accounts using Google sign-in inherit that
  provider's MFA; there is no native second factor.
- **No third-party security audit, and no ISO 27001 or SOC 2 certification.** We
  run our own reviews regularly and fix what they find, but nobody independent
  has signed off on it. If you need certified assurance, we cannot give you that
  today.
- **The operator can read the database.** There is no screen in the product that
  lets an administrator browse someone's cellar, but whoever runs the server has
  database access. If that is unacceptable for your data, self-host it — that is
  what the licence is for.

## Supported versions

Security fixes are applied to the **latest release**, which is also what runs on
cellarion.app. There are no long-term support branches. If you self-host, staying
current is the way to stay patched.
