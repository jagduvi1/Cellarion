# Archived one-shot migration scripts

Completed one-shot migrations and backfills, kept for reference. They have all
been run against production and are not expected to be needed again. They still
`require()` live models, so they remain runnable from this directory if a
restore-from-backup ever needs them replayed:

```bash
docker exec cellarion-backend node src/scripts/archive/<script>.js
```

Scripts that may still need a production run (e.g. `migrate-wine-list-entries.js`,
`strip-exif-images.js`, `backfill-nv-profiles.js`) and operational utilities
(cleanups, seeders, admin tools) stay in the parent `scripts/` directory.
