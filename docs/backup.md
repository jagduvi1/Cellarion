# Backups & disaster recovery

Cellarion keeps **two** stores of irreplaceable data, and a good backup must cover **both**:

| Store | Where | Backed up? |
|-------|-------|-----------|
| **MongoDB** (users, cellars, bottles, wines) | `mongo-data` volume | ✅ yes — `mongodump` |
| **Uploaded images** (bottle/label photos) | `image-data` volume → `/app/uploads` | ✅ yes — **these are on disk, NOT in Mongo** |
| Meilisearch index | `meili-data` | ❌ skipped — rebuilt from Mongo |
| Qdrant vectors (AI) | `qdrant-data` | ❌ skipped — rebuilt from Mongo |
| Umami analytics | `umami-db-data` | ❌ optional — analytics only |

The tooling (`scripts/backup/`) uses [**restic**](https://restic.net): **encrypted, deduplicated, incremental** snapshots with retention, pushed to a **Hetzner Storage Box** over SFTP (and, optionally, a second off-provider copy).

> **The golden rule:** the backup must live **off the VM**. A copy on the same server dies with it. The Storage Box is separate storage; an optional Backblaze B2 copy adds protection against a Hetzner-account-level loss (true 3-2-1).

---

## One-time setup (on the VM)

### 1. Install restic
```bash
sudo apt-get update && sudo apt-get install -y restic curl
restic self-update   # get the latest
```

### 2. Give the VM SSH access to the Storage Box
Storage Boxes speak SSH/SFTP on **port 23**. Create a key and register it:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/storagebox -N ''
# Upload the public key to the box (uXXXXXX = your Storage Box user):
cat ~/.ssh/storagebox.pub | ssh -p23 uXXXXXX@uXXXXXX.your-storagebox.de install-ssh-key
```
Add a host alias so restic doesn't need the port/key inline — `~/.ssh/config`:
```
Host storagebox
    HostName uXXXXXX.your-storagebox.de
    User uXXXXXX
    Port 23
    IdentityFile ~/.ssh/storagebox
```
Create the backup directory once:
```bash
ssh storagebox "mkdir -p backups/cellarion"
```

### 3. Configure the backup
```bash
cd scripts/backup
cp backup.env.example backup.env
chmod 600 backup.env
# Edit backup.env:
#   RESTIC_REPOSITORY="sftp:storagebox:/backups/cellarion"
#   RESTIC_PASSWORD=<a long random passphrase>
```
Generate the passphrase and **store a copy off the server** (a password manager):
```bash
openssl rand -base64 32      # paste into RESTIC_PASSWORD and save it elsewhere
```
> ⚠️ `RESTIC_PASSWORD` is the **only** key that decrypts your backups. If you lose it, the backups are gone. Keep it somewhere that survives the VM dying.

### 4. Initialise + first run
```bash
./backup.sh        # auto-inits the repo, dumps Mongo + images, uploads, prunes
restic -r "$RESTIC_REPOSITORY" snapshots   # verify a snapshot exists
```

---

## Schedule it (nightly)

**cron** (`crontab -e`) — every night at 03:30:
```
30 3 * * * /path/to/cellarion/scripts/backup/backup.sh >> /var/log/cellarion-backup.log 2>&1
```
Or a **systemd timer** if you prefer (see `man systemd.timer`).

### Get alerted on failure (do this)
A silently-broken backup is how people discover they had none. Create a free check at [healthchecks.io](https://healthchecks.io), set its ping URL as `HEALTHCHECK_URL` in `backup.env`, and it emails/Slacks you if a nightly run misses or fails.

---

## Restore (and drill it)

```bash
cd scripts/backup
./restore.sh latest        # or ./restore.sh <snapshotID>
docker compose restart backend   # so Meili/Qdrant re-index from the restored Mongo
```
`restore.sh` drops + reloads the database and copies the images back. **Run a real restore drill monthly** (ideally onto a throwaway VM) — an untested backup is not a backup.

List what's available:
```bash
restic -r "$RESTIC_REPOSITORY" snapshots
```

---

## Recommended extras

- **Weekly integrity check** (catches silent bit-rot): `restic -r "$RESTIC_REPOSITORY" check` — add a weekly cron line.
- **Off-provider 2nd copy** (true 3-2-1): set `B2_*` in `backup.env` (e.g. a Backblaze B2 bucket); `backup.sh` will `restic copy` each snapshot there so a Hetzner-account problem can't wipe everything.
- **Hetzner Cloud Backups** (the +20% VM-image feature) as a bonus "whole-machine undo" — convenient, but treat it as secondary: it's a crash-consistent disk image (riskier for a live DB) stored at the same provider, so it does **not** replace these logical backups.

## Notes & security
- `backup.env` holds secrets → it's gitignored, `chmod 600`, never committed.
- Backups contain **user PII** → encryption (restic) + a locked-down Storage Box are required for GDPR. Retention here is 7 daily / 4 weekly / 6 monthly.
- Retention is enforced by `restic forget --prune` inside `backup.sh`.
