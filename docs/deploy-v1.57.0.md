# Deploying v1.57.0 to the VM — step by step

This release has a **one-time extra step** (wiping the search + vector data) because Meilisearch and Qdrant were upgraded and the new versions can't read the old data format. Your real data (MongoDB + uploaded images) is **never touched** — only the two search/AI caches, which rebuild themselves from MongoDB.

> Do the steps **in order**. Each block is safe to copy-paste into the VM terminal. Lines starting with `#` are comments — you can paste them too, they do nothing.

---

## ⚠️ Before you start: take a backup
If you have the restic backup set up, run it now. If not, at minimum dump the database first:

```bash
cd /home/johan/apps/Cellarion
docker exec cellarion-mongo mongodump --db winecellar --archive --gzip > ~/winecellar-before-1.57.0.archive.gz
ls -lh ~/winecellar-before-1.57.0.archive.gz   # confirm the file exists and isn't 0 bytes
```

---

## Step 1 — Get the latest code
```bash
cd /home/johan/apps/Cellarion
git pull
```

## Step 2 — Update the Meilisearch & Qdrant versions in your prod file
Your VM uses `docker-compose.prod.yml`, which is **not** in git, so `git pull` does **not** change the Meili/Qdrant version numbers there. You must edit them once by hand.

Open the file in the nano editor:
```bash
nano docker-compose.prod.yml
```

Find these two lines (use **Ctrl+W** to search for `meilisearch`, then again for `qdrant`):
```
    image: getmeili/meilisearch:v1.6
```
change to:
```
    image: getmeili/meilisearch:v1.45.1
```

and:
```
    image: qdrant/qdrant:v1.9.0
```
change to:
```
    image: qdrant/qdrant:v1.18.1
```

Save and exit nano: **Ctrl+O**, then **Enter**, then **Ctrl+X**.

## Step 3 — Pull the new images
This pulls your new app images (backend/frontend built by the release) **and** the new Meili/Qdrant versions you just set.
```bash
docker compose -f docker-compose.prod.yml pull
```

## Step 4 — Stop the stack
```bash
docker compose -f docker-compose.prod.yml down
```

## Step 5 — ONE-TIME: wipe ONLY the search + vector data
These two caches can't be read by the new versions. They rebuild from MongoDB automatically. **This does NOT touch your wines, users, cellars, or images.**

First see the exact volume names:
```bash
docker volume ls | grep -E "meili|qdrant"
```
You'll see two names ending in `_meili-data` and `_qdrant-data` (with some prefix). Delete **only those two** — copy the exact names from the line above into this command:
```bash
docker volume rm <paste_the_meili-data_name> <paste_the_qdrant-data_name>
```

> ⚠️ Do **NOT** delete anything containing `mongo` or `image` — those hold your real data.

## Step 6 — Start everything
```bash
docker compose -f docker-compose.prod.yml up -d
```
Wait about a minute. The backend automatically rebuilds the Meilisearch search index from MongoDB on this first start (you'll have full search back within seconds-to-minutes).

## Step 7 — Check it's healthy
```bash
docker compose -f docker-compose.prod.yml ps
```
Every row should say `healthy` or `running` (give Meilisearch a minute if it says `starting`).

Then open **https://cellarion.app** in your browser and try a search — it should work.

## Step 8 — Rebuild the AI vector index (for AI chat / similar wines)
Qdrant came up empty, so AI features are blank until you rebuild the vectors. In your browser:

1. Log in as the super admin.
2. Go to **SuperAdmin → AI & Embeddings**.
3. Under **Embedding Job**, choose **Incremental**, click **Start**.
4. Wait for it to finish (watch the progress). AI chat / similar-wines work again once it's done.

---

## (Optional) Step 9 — Generate the new AI tasting profiles
This release adds AI tasting profiles on wine pages. They don't exist until you generate them (this costs Claude tokens, so test small first):

1. **SuperAdmin → AI & Embeddings → Wine Enrichment Job**.
2. Set **max** to `5`, click **Start** — this enriches just 5 wines so you can check the result + cost.
3. Happy with it? Run it again with **max** blank to do the whole catalog.
4. Then run an **Incremental Embedding Job** again (step 8) so the new taste data feeds search.

---

## If something looks wrong
- **Search returns nothing for a few minutes after Step 6** — normal, the index is still rebuilding. Wait and refresh.
- **A container says `unhealthy`** — give it 1–2 minutes (Meilisearch takes a moment on first boot). Re-run Step 7.
- **You need to roll back** — restore the dump from the top:
  ```bash
  docker exec -i cellarion-mongo mongorestore --db winecellar --archive --gzip --drop < ~/winecellar-before-1.57.0.archive.gz
  ```
- **Don't** repeatedly run `docker compose restart` — if something's off, use one clean `down` then `up -d`.

## Future deploys (after this one)
Normal releases without a search/vector upgrade are just:
```bash
cd /home/johan/apps/Cellarion
git pull
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```
The volume-wipe (Step 5) is **only** needed this once, for the v1.57.0 upgrade.
