# Registry Bridge — enforcement playbook

What to do when a reader of the shared wine registry looks like a copier.
This is the operator's side of [registry-bridge.md](registry-bridge.md): the
signals the hosted instance raises, where to look, and the ladder of
responses. It is written for whoever runs an instance with the bridge
enabled; on cellarion.app that is the maintainers.

The principle behind every step: **adding a bottle must never get harder.**
The registry exists so that people do not have to type wines in. Every
measure below is aimed at the copy pattern, thousands of distinct wines per
day from one reader, and none of them touches what a member does with their
own cellar.

## 1. The signals

| Signal | Where it arrives | What it means |
|---|---|---|
| Daily readers report | Admin notification at 05:15 UTC, only when a reader passed an alert level the day before | One reader read more distinct wines in a UTC day than the level for its kind. Anonymous addresses were already refused in real time; members and keys were only counted. |
| Canary hit | Admin notification, immediately | A wine that does not exist was fetched through a bridge key. Search never returns a canary, so a fetch of one means the caller enumerated ids it did not get from search. |
| Quota refusals | `429` with `code: "quota"` to the caller; visible as spend on the admin page | The ACCOUNT hit its daily cap — quotas and the monthly import window count per owner, not per key, so minting more keys does not raise them. On its own this is not suspicious: a large import does it once. |
| Burst refusals | `429` with `code: "burst"` to the caller; `system.rate_limit_exceeded` in the audit log with `limiter: bridge_key` | More than the per-minute allowance from one key. A misconfigured client, or a script. |
| Edge rate rule | Your reverse proxy or CDN's own log | Requests refused before they reached the backend. Only the volume is known; no reader identity. |

The levels and caps are runtime settings, not code: **Super-admin → Settings
→ Shared registry and bridge**. Changing them takes effect on the next
request.

## 2. Where to look

**Admin → Registry Bridge** shows two tables for the last 7, 30 or 90 days. Spend
figures (searches, fetches, contributions) go back the full window; the distinct-wines
columns are drawn from the read counters, which are kept for 14 days, so a 30- or
90-day request answers with those 14 and the response says so (`readDays`).

- **Keys**: every active bridge key and those revoked in the last 90 days.
  Per key: the owner, the install's reported host, today's spend against the
  caps, the window's totals, the worst day's distinct wines, whether an
  import window is open, and for revoked keys who revoked it and why.
- **Readers**: the top readers of every kind, sorted by their worst day's
  distinct wines. Bridge keys, personal tokens and signed-in members are
  named; anonymous readers appear as the masked address the limiters key on.
  A row over its alert level is flagged.

Read the *distinct* column, not the *reads* column. A household adding a
case reads the same wine many times; a copier reads each wine once.

Things that look alarming and are not:

- A new key with a few hundred fetches on its first day and an open import
  window: someone importing their cellar. That is what the window is for.
- A member with high *reads* and low *distinct*: they are using the site.
- A single canary hit from a key whose other numbers are ordinary: ids leak
  through shared links and old exports. One hit is a question, not a verdict.

## 3. The ladder

Go one step at a time and record what you did. Every step below is
reversible except the last, and every one of them is audited.

### Step 1 — Look

Open the key or reader on the admin page. Check the import window, the
worst-day distinct figure over the last 14 days (the read counters' retention),
the contributions the key has made
(a real install files wine requests and corrections; a copier never does) and
whether the same owner has other keys. Check the audit log for
`bridge.key.used`, `bridge.canary_hit` and `system.rate_limit_exceeded`
against the key id.

### Step 2 — Ask

If the numbers are unusual but not conclusive, write to the owner. The
account's email is on the key row. Ask what they are building and point at
the [Registry Data Terms](https://cellarion.app/terms). Most people answer,
and most answers are an import script left running, a test loop, or a
misunderstanding of what the bridge is for. Give them a few days.

### Step 3 — Tighten

Three levers, all in Super-admin → Settings, all instance-wide:

- **Bridge enabled** — `0` closes `/api/bridge/v1` entirely with a `503`, for an
  incident where revoking one key at a time is not fast enough. Key management and
  the self-hosted Settings card stay up.

- **Anonymous daily distinct cap** — how many distinct wines an address may
  read in a UTC day before the public endpoints refuse it.
- **Bridge quotas** — searches, fetches, change checks and contributions per
  key per day, and the per-minute burst.

Lowering them slows every reader, so prefer the per-key step below when one
key is the problem. Raise them again when the episode is over.

### Step 4 — Revoke the key, with a reason

Admin → Registry Bridge → *Revoke*. The reason is mandatory and the owner
sees it in their own Settings for 30 days, next to the empty key list. The
install loses registry access on its next request; wines it already copied
stay, and nothing else about the account changes. The action is logged as
`bridge.key.revoked_by_admin` with the reason.

The owner can create a new key. If they do and the pattern returns, that is
no longer a misunderstanding.

### Step 5 — The account

Repeated abuse after a revocation with a clear reason is handled the way any
abuse of the terms is: the ordinary admin user tools (suspend, then delete
under the account policy). Keep the evidence from steps 1 to 4. Do not read
the account's cellar; nothing in it is relevant to a registry-copy decision.

### Anonymous readers

There is no owner to write to. The daily cap already refuses them; the edge
rate rule already slows them. If one address keeps coming back day after
day at the cap, block it at your reverse proxy or CDN. Do not lower the
anonymous cap for everyone because of one address.

## 4. What not to do

- **Do not name people or installs publicly.** Not in an issue, a discussion,
  a blog post or a commit message. The audit log and the admin page are the
  record.
- **Do not publish which wines are canaries**, or how many there are. A
  canary that is known is no longer one.
- **Do not revoke without a reason.** The field is mandatory for a purpose:
  an owner who cannot learn why will file a ticket, and rightly.
- **Do not touch the caps to "send a message".** They are safety margins for
  everyone, not a per-person sanction.
- **Do not skip step 2** for a member with a history of contributions. The
  people who file corrections are the registry's best readers.

## 5. The record

Every action on the ladder leaves a trail in the audit log:

| Action | Audit action |
|---|---|
| A key was used (at most once an hour per key) | `bridge.key.used` |
| A canary was fetched through a key | `bridge.canary_hit` |
| Burst or address limit refused a request | `system.rate_limit_exceeded` (`limiter: bridge_key` / `bridge_ip`) |
| An anonymous address passed the daily cap | `system.registry_read_cap` |
| The owner revoked their key | `bridge.key.revoked` |
| An admin revoked a key | `bridge.key.revoked_by_admin` (with the reason) |
| The caps were changed | `admin.settings.rate_limits.update` (from and to) |

Read counters (`RegistryReadDay`) are kept for 14 days and quota counters
(`BridgeUsageDay`) for 90; both are deleted with the account and summarised
in the owner's data export. Decisions that need to outlive them belong in
the audit log entry's reason, or in a support ticket on the account.

## 6. If you run your own instance

Everything above applies to an instance that issues bridge keys, hosted or
not: the counters, the report, the page and the settings are part of the
code. The canaries are not: seed your own if you want the enumeration
signal, and keep the list out of the repository.
