# Cellarion

**Cellarion is a hosted wine cellar app — a ready-to-use online service at [cellarion.app](https://cellarion.app).** Create a free account and start tracking your bottles, organizing them into cellars and racks, searching a shared wine registry, getting sommelier-curated drink-window recommendations, and chatting with an AI sommelier about your collection. No installation, no server, no setup — just sign up and go. **Every feature is free, forever.**

> **Just want to use Cellarion?** Go to **[cellarion.app](https://cellarion.app)** and sign up. You do **not** need to clone this repository, run Docker, or host anything yourself. There's also a public **[demo account](https://cellarion.app)** (Try the demo on the landing page) and an Android app on **[Google Play](https://play.google.com/store/apps/details?id=app.cellarion.twa)**.

Cellarion is *also* open-source (AGPL-3.0), so if you'd prefer to run your own private instance, you can self-host it. The rest of this README covers self-hosting — see [Quick Start](#self-hosting-quick-start). Most people should just use the hosted service at [cellarion.app](https://cellarion.app).

## Hosted Service (recommended)

Cellarion is live and publicly available at:

👉 **https://cellarion.app**

This is the primary way to use Cellarion. Create an account and start using the full service today — **every feature is free, forever.** No credit card, no trial clock, no paywalled features, nothing to install or maintain. If you want to chip in, optional [Supporter, Patron and Benefactor tiers](https://cellarion.app/supporter) (monthly or yearly) and [GitHub Sponsors](https://github.com/sponsors/jagduvi1) fund development — they unlock nothing extra, just our thanks.

## Features

**Your cellar**
- **Bottle tracking** — Log every bottle with vintage, producer, region, price, rating, and tasting notes; add more of a bottle you already own in one click
- **Cellar & rack management** — Multiple cellars with customizable rack grids (up to 20×20) and a 3D cellar room view for physical placement
- **Open-bottle tracking** — Open a bottle, pour glasses over days, close or finish it — with preservation-aware drink-soon nudges
- **Reserved bottles** — Mark bottles as "spoken for" (a birthday, a dinner) so suggestions and consume flows respect them
- **Drink-window alerts** — Sommelier-curated maturity windows per wine and vintage; alerts when bottles approach peak, are in window, or slipping past it
- **Rich statistics** — Charts, world choropleth map, breakdowns by country, grape, value, and drink status
- **Import & export** — Bring collections from Vivino (incl. drinking history), CellarTracker, Ploc, generic CSV, or Cellarion's own JSON; export everything as JSON or a ZIP with your images

**The shared registry**
- **Smart search** — Meilisearch-powered fuzzy search with aggressive deduplication and canonical-key matching
- **Label scanning** — Snap a photo of a wine label and let AI fill in the details
- **Regional grape names** — One canonical variety per grape, displayed the way the label writes it (a Douro Port shows *Tinta Roriz*, an Alentejo red *Aragonez* — both stored as Tempranillo)
- **Registry quality tooling** — Duplicate/fragmentation queues, cross-field domain checks, name checks, and a sommelier correction-proposal workflow keep the shared data clean

**AI**
- **AI cellar chat** — Ask questions about your collection — food pairings, occasion picks, cellar health (Claude + Voyage embeddings + Qdrant; only ever answers from wines you actually own)
- **Connect your own AI** — A built-in [MCP server](#connect-your-ai-mcp) lets Claude, and any MCP-capable client, read and manage your cellar conversationally
- **Bring your own models** — Self-hosters can point every AI feature at any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio) instead of Anthropic/Voyage

**Community & sharing**
- **Cellar sharing** — Invite others to browse or co-manage a cellar with role-based access
- **Wine lists, reviews & discussions** — Build shareable lists, review wines, discuss them, follow other users, and get restock alerts
- **Tasting journal & wishlist** — Keep private notes and a want-to-try list

**Platform**
- **Climate monitoring** — Connect cellar temperature/humidity sensors (Home Assistant-friendly ingest API) with per-cellar dashboards
- **Sign in with Google** — Optional Google SSO alongside email/password
- **Installable app** — PWA with push notifications, plus an Android app on [Google Play](https://play.google.com/store/apps/details?id=app.cellarion.twa)
- **Internationalization** — Community-translated via Weblate ([help translate](#translations))
- **Privacy & GDPR** — Full data export, account deletion with cooling-off, one-click email opt-out, optional self-hosted cookie-free analytics (Umami)
- **Everything free** — Optional Supporter/Patron/Benefactor tiers (Stripe, monthly or yearly) and GitHub Sponsors fund development; they unlock nothing extra
- **Sommelier & admin tools** — Maturity/pricing curation surfaces, wine requests, quality reports, registry health watchdog, audit log, super-admin dashboard

---

## Stack

- **MongoDB 7** — Database (Mongoose 8)
- **Express 4** — Backend API
- **React 19** — Frontend (React Router 6, built with **Vite 7**)
- **Node.js 24** — Runtime
- **Meilisearch** — Fuzzy search engine
- **Qdrant** — Vector database for AI cellar chat
- **Voyage AI** — Wine embedding generation (swappable for any OpenAI-compatible endpoint)
- **Anthropic Claude** — Label scanning + AI chat (swappable, same mechanism)
- **MCP** — Model Context Protocol server (`/api/mcp`) with OAuth, for AI assistants
- **Stripe** — Optional supporter payments (hosted Checkout + Portal)
- **nginx** — Serves the React SPA and proxies `/api/` to the backend (internal)
- **Traefik** — External reverse proxy (bring your own; not included in this Compose file)
- **Docker Compose** — Containerization
- **rembg** — Python/Flask background removal microservice
- **Umami** — Optional self-hosted, cookie-free analytics (compose `--profile analytics`)

---

## Self-Hosting (Quick Start)

> This section is only for people who want to run their own private instance. If you just want to use Cellarion, head to **[cellarion.app](https://cellarion.app)** instead — no setup required.

### Prerequisites

- Docker + Docker Compose

### Run the app

The app is routed through Traefik, so create the external `web` Docker network **before** the first `up` (compose declares it external — the first command fails otherwise):

```bash
git clone https://github.com/jagduvi1/Cellarion.git
cd Cellarion
cp .env.example .env
# Edit .env and set JWT_SECRET and MEILI_MASTER_KEY to strong random strings
docker network create web        # once; skip if it already exists
docker-compose up --build
```

| URL | Description |
|-----|-------------|
| http://localhost | Frontend (React SPA) — served via Traefik |
| http://localhost/api/health | Backend health check |

### Seed demo data

After the containers are running:

```bash
docker exec cellarion-backend node src/seed-demo.js
```

This creates demo accounts plus a starter taxonomy, wine registry entries, and a demo cellar with sample bottles:

| Account | Email | Password | Role |
|---------|-------|----------|------|
| Admin   | admin@cellarion.app | Admin1234!demo | admin |
| Demo user | user@cellarion.app | User1234!demo | user |

> These are local development credentials. Change them before deploying anywhere public.

### Stop

```bash
docker-compose down          # keep data
docker-compose down -v       # also remove all volumes (wipes database)
```

---

## Architecture

The tree below shows the shape of the codebase — the highlights, not every file. The backend has **57 Mongoose schemas** and **~65 route modules** (44 top-level + `admin/` + `somm/`), plus the MCP server.

```
Cellarion/
├── backend/
│   ├── server.js                   # Entry point
│   └── src/
│       ├── app.js                  # Express app setup, mounting, rate limiters
│       ├── config/                 # db, plans, upload, aiConfig (models, prompts, limits)
│       ├── middleware/
│       │   ├── auth.js             # JWT + role middleware (requireAuth, requireAdmin, requireSomm)
│       │   └── bottleAccess.js     # requireBottleAccess(minRole) factory
│       ├── models/                 # 57 Mongoose schemas — core: User, WineDefinition,
│       │                           #   Bottle, Cellar, Rack, WineVintageProfile/Price,
│       │                           #   WineRequest, WineCorrectionProposal, BottleImage,
│       │                           #   AuditLog, Country/Region/Appellation/Grape;
│       │                           #   community: Discussion*, Review, JournalEntry,
│       │                           #   WishlistItem, WineList, Follow, RestockAlert;
│       │                           #   infra: Notification, PushSubscription, SupportTicket,
│       │                           #   ImportSession, StripeWebhookEvent, WineEmbedding,
│       │                           #   ClimateDevice/Reading, OAuth*, McpActionLog, …
│       ├── routes/                 # ~44 top-level route modules: auth (incl. Google SSO),
│       │                           #   cellars, bottles, wines (public read), racks, chat,
│       │                           #   stats, import, export, wineRequests, wineReports,
│       │                           #   discussions, reviews, journal, wishlist, wineLists,
│       │                           #   follows, recommendations, restockAlerts, climate,
│       │                           #   notifications, support, stripe, blog, og, sitemap,
│       │                           #   users, settings, images, health, superadmin, …
│       │   ├── admin/              # /api/admin/* — registry curation, taxonomy, users,
│       │   │                       #   tickets, proposals, fragmentation/cross-field queues
│       │   └── somm/               # /api/somm/* — maturity windows, prices, wine profiles
│       ├── mcp/                    # MCP server: registry, tools (read/write/somm/admin),
│       │                           #   OAuth, action ledger with undo
│       ├── services/               # search (Meili), embedding (Voyage/OpenAI-compatible),
│       │                           #   aiChat (RAG), labelScan, enrichmentJob, audit,
│       │                           #   findOrCreateWine, imageProcessor, taxonomyMerge,
│       │                           #   registryHealthJob, crossFieldScan, statsService, …
│       ├── utils/                  # normalize (dedup), cellarAccess, drinkWindow,
│       │                           #   grapeDisplay (regional names), nameChecks,
│       │                           #   crossFieldChecks, ratingUtils, maturityUtils, …
│       ├── data/                   # Taxonomy reference JSON
│       └── seed-demo.js
├── frontend/
│   ├── src/
│   │   ├── api/                    # Typed API client modules (one per resource)
│   │   ├── components/             # Reusable UI (Layout, Modal, BottleCard, rack grids, …)
│   │   ├── pages/                  # App screens (cellars, bottles, stats, chat, admin, …)
│   │   ├── contexts/               # Auth, Theme, Notifications
│   │   ├── locales/                # i18n (Weblate-managed except en)
│   │   └── utils/
│   ├── nginx.conf                  # nginx config (SPA + /api/ proxy)
│   └── Dockerfile                  # Multi-stage: Node build → nginx-unprivileged
├── rembg/                          # Python background-removal service
└── docker-compose.yml
```

### Services

All external traffic enters through Traefik (runs on the shared `web` Docker network, external to this Compose file). All services inside this Compose file are internal only.

| Service      | Host port | Description                        |
|--------------|-----------|------------------------------------|
| Traefik      | **80**    | External reverse proxy (external)  |
| nginx        | internal  | Serves React SPA + proxies `/api/` |
| Backend      | internal  | Express REST API (port 5000)       |
| MongoDB      | internal  | Database (port 27017)              |
| Meilisearch  | internal  | Fuzzy search engine (port 7700)    |
| Qdrant       | internal  | Vector database (port 6333)        |
| rembg        | internal  | Background removal (port 5000)     |
| Umami (+db)  | internal  | Optional analytics — `--profile analytics` |

### Running behind Traefik

Cellarion is designed to sit behind a Traefik reverse proxy on a shared Docker network called `web`. Traefik handles incoming HTTP on port 80 (SSL termination is handled upstream by Cloudflare or similar).

**Requirements:**
- A running Traefik instance connected to an external Docker network named `web`
- The `web` network must exist before starting Cellarion: `docker network create web`

The frontend service declares the following Traefik labels in `docker-compose.yml`:

```yaml
traefik.enable: "true"
traefik.docker.network: "web"
traefik.http.routers.cellarion.rule: "Host(`cellarion.app`)"
traefik.http.routers.cellarion.entrypoints: "web"
traefik.http.services.cellarion.loadbalancer.server.port: "8080"
```

The upstream port is **8080** (not 80): the frontend image is built on
`nginxinc/nginx-unprivileged`, whose non-root nginx cannot bind ports below 1024.

Update the `Host(...)` rule to match your own domain.

---

## Connect your AI (MCP)

Cellarion ships a built-in **[Model Context Protocol](https://modelcontextprotocol.io)** server, so AI assistants can read and manage your cellar conversationally — "what should I open tonight?", "add these six bottles", "set the drink window for this vintage".

- **Personal server** — `https://cellarion.app/api/mcp` (OAuth; your own cellar, read/write/consume scopes, sommelier and admin tools for those roles, with an action ledger and `undo_last`)
- **Public registry server** — `https://cellarion.app/api/mcp/public` (no signup; read-only shared wine registry)
- **Setup guide** — **[cellarion.app/connect-ai](https://cellarion.app/connect-ai)** has copy-paste config for Claude (web/Desktop/Code) and other MCP clients
- Also published as [`cellarion-mcp`](https://www.npmjs.com/package/cellarion-mcp) on npm and in the [official MCP registry](https://registry.modelcontextprotocol.io) (`app.cellarion/cellarion`, `app.cellarion/wine-registry`)

Self-hosted instances serve the same endpoints from their own origin — the `/connect-ai` page renders instance-specific snippets automatically.

---

## Core Concepts

| Entity | Description |
|--------|-------------|
| **WineDefinition** | Vintage-neutral wine entry in the shared registry. Admin-managed; grows via user wine requests, imports, and sommelier correction proposals with one-click admin review. |
| **Bottle** | A user's bottle: references a WineDefinition and adds vintage, price, rating, notes, rack location, open/reserved state. |
| **Cellar** | Named container of Bottles, owned by a user. Can be shared with other users via role-based access. |
| **Rack** | Customizable grid (up to 20×20, default 8×4) within a Cellar for physical bottle placement, with a 3D room view. |
| **WineVintageProfile** | Sommelier-curated drink-window (maturity) data per wine + vintage — the source of drink alerts. |
| **WineRequest** | User-submitted wine suggestion. Admins review and fulfil by creating a WineDefinition. |
| **Taxonomy** | Admin-managed Countries, Regions, Appellations, and Grapes (with regional display names) to prevent free-text proliferation. |
| **Notification** | In-app + push notification for events like wine requests resolved, images approved, cellars shared, restocks. |
| **SupportTicket** | User support tickets with admin response tracking. |
| **WineReport** | User-submitted wine quality reports (wrong info, duplicates, inappropriate content). |

### User Roles

| Role | Description |
|------|-------------|
| **user** | Standard user — manages own cellars, bottles, and requests |
| **sommelier** | Curates maturity windows, pricing data, tasting profiles, and correction proposals for the shared registry |
| **admin** | Full access — wine library, taxonomy, user management, image review, registry quality queues, audit log |
| **super admin** | Platform-level access — system monitor, service health, rate limits, AI config, embedding management |

---

## API Summary

The backend exposes ~65 route modules; this is the core surface, not an exhaustive reference. Wine registry reads (`/api/wines`, public wine pages, OG images, sitemap) are public; everything personal requires a JWT (`Authorization: Bearer <token>`).

### Auth — `/api/auth`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/register` | Create account (sends verification email if Mailgun is configured) |
| POST | `/login` | Login, returns JWT (blocked until email is verified when Mailgun is configured) |
| GET | `/google` → `/google/callback` | Google SSO (when `GOOGLE_CLIENT_ID/SECRET` are set) |
| GET | `/verify-email?token=` | Verify email address, returns JWT on success |
| POST | `/resend-verification` | Resend verification email |
| POST | `/forgot-password` | Request password reset email |
| POST | `/reset-password` | Reset password with token |

### Cellars — `/api/cellars` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List user's cellars |
| POST | `/` | Create cellar |
| GET | `/:id` | Get cellar + bottles |
| PUT | `/:id` | Update cellar |
| DELETE | `/:id` | Delete cellar |
| GET | `/:id/statistics` | Aggregated stats |

### Bottles — `/api/bottles` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Add bottle to cellar |
| PUT | `/:id` | Update bottle |
| DELETE | `/:id` | Remove bottle |
| POST | `/:id/consume` · `/:id/open` · pour/close | Drink-tracking lifecycle |
| POST | `/import/validate` | Validate import data and match wines (registry-read-only) |
| POST | `/import/confirm` | Create bottles from validated import |

### Wine Registry — `/api/wines`

Public read. Regular-user searches are capped; admin/sommelier get full browse.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Search/filter wines. Params: `search`, `type`, `country`, `region`, `grapes`, `sort`, `limit`, `offset` |
| GET | `/:id` | Get a single wine definition (grapes carry `displayName` regional labels) |

### Chat — `/api/chat` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Send a question to the AI cellar chat (RAG pipeline) |

### MCP — `/api/mcp` and `/api/mcp/public`

See [Connect your AI](#connect-your-ai-mcp). OAuth 2.0 with dynamic client registration on the personal server; the public server needs no auth.

### Community *(auth required)*

`/api/discussions`, `/api/reviews`, `/api/journal`, `/api/wishlist`, `/api/wine-lists`, `/api/follows`, `/api/recommendations`, `/api/restock-alerts` — lists, reviews, discussions, journal, wishlist, follows, and restock alerts.

### Climate — `/api/climate` *(auth required)*

Register cellar sensors, ingest readings (Home Assistant-friendly token auth), per-cellar dashboards.

### Notifications / Stats / Support / Wine Reports / Wine Requests *(auth required)*

As before: `/api/notifications`, `/api/stats/overview`, `/api/support`, `/api/wine-reports`, `/api/wine-requests`.

### Sommelier — `/api/somm/*` *(somm or admin role)*

| Method | Path | Description |
|--------|------|-------------|
| GET/PUT | `/maturity` | Curate drink-window phases per wine + vintage |
| GET/POST | `/prices` | Curate pricing data |
| PUT | `/profile/:wineId` | Correct a wine's tasting profile, type, and grapes |

### Admin — `/api/admin/*` *(admin role required)*

Wine definitions + merges, wine requests, correction proposals, taxonomy (incl. grape regional names), registry quality queues (duplicates, fragmentation, name checks, cross-field checks), images, users, tickets, audit log.

### Super Admin — `/api/superadmin/*` *(super admin only)*

Platform analytics, rate limits, AI model/prompt config, announcement banner, embedding jobs.

---

## Environment Variables

Copy `.env.example` to `.env` — **it is fully commented and is the authoritative reference.** Core values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **Yes** | — | Long random string for signing JWTs |
| `MEILI_MASTER_KEY` | **Yes** | — | Long random string for Meilisearch auth |
| `MONGO_URI` | No | `mongodb://mongo:27017/winecellar` | MongoDB connection |
| `ACCESS_TOKEN_EXPIRES_IN` | No | `15m` | Access-token TTL (sessions refresh via a rotating 30-day cookie) |
| `PORT` | No | `5000` | Backend port |
| `FRONTEND_URL` | No | `http://localhost` | CORS origin — set to your domain in production |
| `MEILI_URL` | No | `http://meilisearch:7700` | Meilisearch URL |
| `REMBG_URL` | No | `http://rembg:5000` | Background removal service |
| `ANTHROPIC_API_KEY` | No | — | Enables label scanning and AI cellar chat ([get a key](https://console.anthropic.com/)) |
| `VOYAGE_API_KEY` | No | — | Required for AI cellar chat embeddings ([get a key](https://dash.voyageai.com/)) |
| `QDRANT_URL` | No | `http://qdrant:6333` | Vector database URL (auto-set in Docker Compose) |
| `SUPER_ADMIN_EMAIL` | No | — | Email of the super admin account |
| `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` | No | — | Enable email verification + transactional email |

**Optional integrations** (each fully documented in `.env.example`):

| Group | Variables | Enables |
|-------|-----------|---------|
| Self-hosted AI | `AI_PROVIDER`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `AI_MODEL`, `AI_VISION_MODEL`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION`, … | Any OpenAI-compatible endpoint instead of Anthropic/Voyage — see [Self-hosted AI](#self-hosted-ai-openai-compatible-endpoints) |
| Google SSO | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Sign in with Google |
| Supporter payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_{SUPPORTER,PATRON,BENEFACTOR}_PRICE_ID` + `_ANNUAL_` variants | Stripe Checkout for the optional tiers. Give each tier its own Stripe **Product** (one monthly + one yearly price), or the Customer Portal can't offer tier switching. Each price var takes a comma-separated list — current price first, then any retired prices that still have live subscribers |
| Push notifications | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL` | Web-push for drink alerts and events |
| Climate monitoring | `CLIMATE_RETENTION_DAYS`, `CLIMATE_MAX_DEVICES_PER_USER`, `CLIMATE_MAX_READINGS_PER_DAY`, … | Sensor ingest limits + GDPR retention |
| Analytics | `UMAMI_DB_PASSWORD`, `UMAMI_APP_SECRET`, `VITE_UMAMI_URL`, `VITE_UMAMI_WEBSITE_ID` | Self-hosted cookie-free Umami (`--profile analytics`; `VITE_*` are build-time) |
| Ops | `TRUST_PROXY_HOPS`, `COOKIE_SECURE`, `BACKEND_URL`, `MEILI_SEARCH_KEY`, `LOG_LEVEL`, `AUDIT_TTL_DAYS`, `VITE_SITE_URL`, `INDEXNOW_KEY`, `SUPER_ADMIN_IPS`, `QDRANT_API_KEY` | Proxy trust, cookies, logging, SEO, audit retention |

### AI Cellar Chat

The AI chat feature requires three services working together:

1. **Anthropic Claude** (`ANTHROPIC_API_KEY`) — generates conversational responses grounded in your cellar
2. **Voyage AI** (`VOYAGE_API_KEY`) — creates wine embeddings for semantic search
3. **Qdrant** (`QDRANT_URL`) — vector database for fast similarity search

When all three are configured, users can ask natural-language questions about their collection (food pairings, occasion picks, cellar insights). The system only surfaces wines the user actually owns — no hallucinated recommendations.

A single daily usage quota — the same for every user, regardless of supporter tier — is configurable by SuperAdmins (default 50 questions/day).

### Self-hosted AI (OpenAI-compatible endpoints)

Self-hosters who prefer not to use an Anthropic API key can point every LLM feature (cellar chat, label scan, import lookup, drink-window / price / profile suggestions) at any endpoint that speaks the OpenAI chat-completions API — Ollama, LM Studio, vLLM, LiteLLM, or OpenAI itself:

```bash
AI_PROVIDER=openai
OPENAI_BASE_URL=http://host.docker.internal:11434/v1   # your endpoint's /v1 root
AI_MODEL=llama3.1:70b                                   # any model your server hosts
AI_VISION_MODEL=qwen2.5-vl:32b                          # optional — used for label scanning
```

Wine **embeddings** (the semantic-search half of cellar chat) can independently be moved off Voyage AI the same way:

```bash
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=nomic-embed-text   # any embedding model your server hosts
EMBEDDING_DIMENSION=768            # MUST be that model's real vector size
# EMBEDDING_BASE_URL / EMBEDDING_API_KEY default to OPENAI_BASE_URL / OPENAI_API_KEY
```

Notes:

- Both switches are **opt-in**: without them, nothing changes — Anthropic + Voyage remain the defaults, and they can be switched independently (e.g. local LLM + Voyage embeddings).
- `host.docker.internal` resolves out of the box only on Docker Desktop (Windows/macOS). On a Linux server, either add `extra_hosts: ["host.docker.internal:host-gateway"]` to the backend service in your compose file, or point `OPENAI_BASE_URL` at the host's LAN IP or a service on the compose network.
- The AI usage budgets (per-user/global daily caps, import per-request cap, chat daily limit) were tuned to bound paid Anthropic spend. Against your own hardware they still apply — raise or disable them in SuperAdmin → Rate limits (`0`/`-1` = unlimited) if you don't want your local endpoint metered.
- The admin panel's Claude model settings are ignored in openai mode (the model comes from `AI_MODEL`); the configurable AI **prompts** still apply.
- Label scanning needs a vision-capable model. Extraction quality depends heavily on the model you host — smaller local models will misread more labels than Claude does.
- The Qdrant collection is sized to the embedding dimension. After changing `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, or `EMBEDDING_DIMENSION`, run a **full** embedding job (SuperAdmin → AI) — it drops and rebuilds the collection at the new size. Every returned vector is validated against `EMBEDDING_DIMENSION`, so a wrong value fails loudly instead of corrupting search.
- Qdrant itself is always required for cellar chat (it ships in docker-compose).
- **Privacy note for multi-user instances:** the bundled Privacy Policy names Anthropic and Voyage AI as the AI sub-processors. Pointing these vars at your own local endpoint (Ollama/vLLM on your hardware) removes third-party AI processing entirely — but if you point them at a remote third-party service (e.g. OpenAI or a hosted proxy), you are responsible for updating your instance's privacy policy and user consent accordingly.

### Email Verification

When both `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` are set, email verification is enabled:

- New users receive a verification link after registering and cannot log in until they click it.
- The link expires after **24 hours**. A resend option is available on the login page and the `/verify-email` page.
- If Mailgun is not configured, registration issues a token immediately — the same behaviour as before.

**Existing users:** After enabling verification on a running instance, existing accounts will have `emailVerified: false` and will be locked out. Run this once in the MongoDB shell to restore access:

```js
db.users.updateMany({ emailVerified: { $exists: false } }, { $set: { emailVerified: true } })
```

---

## Bottle Import

Users can import bottles from other wine cellar apps (Vivino — including drinking history, CellarTracker, Ploc — including slot positions and purchase history, or any generic CSV). The import flow:

1. **Upload** — Drop a CSV file; the system auto-detects the source format and maps it to a standard schema
2. **Validate** — Each item is matched against the wine library using fuzzy search (Meilisearch + MongoDB text search + normalized key lookup) and scored with combined similarity
3. **Review** — Users see match results: exact matches (auto-selected), fuzzy matches (pick from candidates), and unmatched items (search manually or skip)
4. **Import** — Confirmed items are created as bottles in the target cellar (nothing is written to the shared registry until you confirm)

Import sessions are persisted so users can resume later if interrupted. Access the import from any cellar's overflow menu (⋯ → Import Bottles). Requires editor or owner access.

### Master Import JSON Format

Bottles can also be imported as JSON. Each item supports:

```json
{
  "wineName": "Albe",
  "producer": "G.D. Vajra",
  "vintage": "2019",
  "country": "Italy",
  "region": "Piedmont",
  "appellation": "Barolo",
  "type": "red",
  "price": 299,
  "currency": "SEK",
  "bottleSize": "750ml",
  "quantity": 2,
  "purchaseDate": "2024-03-15",
  "purchaseLocation": "Systembolaget",
  "notes": "Beautiful nebbiolo",
  "rating": 4.2,
  "ratingScale": "5",
  "rackName": "Rack A",
  "rackPosition": 5,
  "addToHistory": false
}
```

To import directly into history (already consumed bottles), add:

```json
{
  "addToHistory": true,
  "consumedReason": "drank",
  "consumedAt": "2025-12-24",
  "consumedNote": "Opened for Christmas",
  "consumedRating": 4.5,
  "consumedRatingScale": "5",
  "dateAdded": "2024-06-01"
}
```

### Cellar Export

Cellar owners can export their data via a cellar's overflow menu (⋯ → Export) or Settings. Available as JSON, or as a ZIP that also includes your uploaded bottle images. The export covers bottles with rack placement (`rackName`, `rackPosition`), rack geometry, the 3D room layout, and your own reviews. The JSON format is directly re-importable. (A full account export — every category of your data — is available under Settings → Privacy, per GDPR.)

---

## Wine Deduplication

When a wine is created, the system checks for near-duplicates using:

1. **Levenshtein distance** (40%) — character-level similarity
2. **Trigram Jaccard** (30%) — overlapping 3-char sequences
3. **Token Jaccard** (30%) — word-level similarity after removing wine domain stop words

Score: `name × 0.45 + producer × 0.45 + appellation × 0.10`

Candidates above the threshold (default 0.75) appear as warnings with a "Use This" option. Behind that sit admin-side quality queues — duplicate groups, producer-fragmentation pairs, name checks, and cross-field domain checks (a producer that is actually an appellation, a region that is a country…) — re-tested against the live taxonomy on every scan.

---

## Testing

### Frontend

```bash
cd frontend && npm test
```

Runs **Vitest** (`vitest run` — a single non-watch pass) with React Testing Library. Do **not** append CRA-style flags like `--watchAll=false` — the frontend is built with Vite, not Create React App, and unknown flags error.

### Backend

```bash
cd backend && npm test
```

Uses Jest — ~124 suites covering auth middleware, cellar access control, wine normalisation/dedup, registry checks, rating conversion, drink windows, MCP tools, and more.

**Run both test suites before opening a pull request. PRs with failing tests will not be merged.**

---

## Contributing

Contributions are welcome — bug fixes, features, documentation, and translations. **[CONTRIBUTING.md](CONTRIBUTING.md)** has the full guide: how to set up, the branch and test workflow, the conventions the codebase follows, the personal-data checklist every feature must pass, and how to sign your commits (Cellarion uses the [Developer Certificate of Origin](https://developercertificate.org/), so commit with `git commit -s`). The short version:

1. Fork the repo and create a branch off `main` (`feat/`, `fix/`, `docs/`…)
2. Make your change, with tests
3. Run both suites: `cd frontend && npm test` and `cd backend && npm test`
4. Smoke-test in Docker: `docker compose up --build`, and use the thing you changed
5. Open a pull request against `main` — the template asks for a description and a checklist

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

### Translations

[![Translation status](https://hosted.weblate.org/widget/cellarion/frontend/svg-badge.svg)](https://hosted.weblate.org/engage/cellarion/)

Cellarion's interface is community-translated with **[Weblate](https://hosted.weblate.org/engage/cellarion/)** — a web editor, no Git and no coding required. English is maintained by the developers alongside the code; every other language comes from volunteers.

**What's useful differs by language:**

| Language | What it needs |
|---|---|
| **French, German** | **Reviewers, not translators.** Both were machine-drafted in bulk, so every field is already filled — the work is reading what's there and correcting it. The queue you want is `state:translated NOT state:approved`, not the untranslated one. |
| **Swedish** | A native reader. Effectively complete, barely reviewed. |
| **Estonian, or a language not listed** | Translators, from the top. Request the language in Weblate and start — it shows up in the app from roughly 10 % onwards, and `?lng=<code>` previews it before that. |

Guidelines, the wine-terminology glossary, and how a language graduates out of beta: **[TRANSLATING.md](TRANSLATING.md)**.

(Please don't open pull requests that edit `translation.json` files directly — `en` excepted. They conflict with Weblate's two-way sync.)

---

## Reporting a Vulnerability

Please do not open a public issue for a security problem. Use GitHub's [private vulnerability reporting](https://github.com/jagduvi1/Cellarion/security/advisories/new), or email **info@cellarion.app** with "SECURITY" in the subject. Response times, scope, and an honest account of the current security posture are in **[SECURITY.md](SECURITY.md)**.

---

## License

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)

You are free to use, modify, self-host, and even offer this software as a service. The one condition, and the reason Cellarion uses AGPL rather than MIT: if you run a modified version for other people, you must make your modified source available to them.

Contributions are accepted under the same license; see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Acknowledgements

This codebase was developed together with [Claude Code](https://claude.ai/claude-code) by Anthropic.
