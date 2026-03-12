# Cellarion

A self-hosted wine cellar management app built with the MERN stack. Track your bottles, organize them into cellars and racks, search a shared wine registry, get drink-window recommendations, and chat with an AI sommelier about your collection.

## Hosted Version

Cellarion is live and publicly available at:

👉 https://cellarion.app

Create an account and start using the full hosted service today.

## Features

- **Bottle tracking** — Log every bottle with vintage, producer, region, price, rating, and tasting notes
- **Cellar & rack management** — Organize bottles across multiple cellars with interactive 8×4 rack grids
- **Drink-window alerts** — Get notified when bottles are approaching peak, in window, or past it
- **Rich statistics** — Charts, maps (world choropleth), breakdowns by country, grape, value, and drink status
- **Smart search** — Meilisearch-powered fuzzy search with deduplication
- **AI cellar chat** — Ask questions about your collection — food pairings, occasion picks, cellar checks (powered by Claude + Voyage embeddings + Qdrant)
- **Label scanning** — Snap a photo of a wine label and let AI fill in the details (Anthropic Vision API)
- **Import & export** — Bring collections from Vivino, CellarTracker, or generic CSV; export as JSON/CSV
- **Cellar sharing** — Invite others to browse or co-manage a cellar with role-based access
- **Dark mode** — Full light/dark theme with system preference detection
- **Notifications** — In-app notification bell for wine requests, image approvals, shared cellars, and more
- **Subscription plans** — Free and Premium tiers with configurable feature limits
- **Support system** — In-app support tickets and wine quality reports
- **Internationalization** — i18n support via react-i18next
- **Sommelier tools** — Dedicated maturity phase and pricing interfaces for sommeliers
- **Super admin dashboard** — Platform-wide analytics, service health, rate limits, and embedding management

---

## Stack

- **MongoDB 7** — Database (Mongoose 8)
- **Express 4** — Backend API
- **React 19** — Frontend (React Router 6)
- **Node.js 20** — Runtime
- **Meilisearch** — Fuzzy search engine
- **Qdrant** — Vector database for AI cellar chat
- **Voyage AI** — Wine embedding generation
- **Anthropic Claude** — Label scanning + AI chat
- **nginx** — Serves the React SPA and proxies `/api/` to the backend (internal)
- **Traefik** — External reverse proxy (bring your own; not included in this Compose file)
- **Docker Compose** — Containerization
- **rembg** — Python/Flask background removal microservice

---

## Quick Start

### Prerequisites

- Docker + Docker Compose

### Run the app

```bash
git clone https://github.com/jagduvi1/Cellarion.git
cd Cellarion
cp .env.example .env
# Edit .env and set JWT_SECRET and MEILI_MASTER_KEY to strong random strings
docker-compose up --build
```

The app is routed through Traefik. Make sure the `web` Docker network exists before starting:

```bash
docker network create web
```

Then bring up the stack:

```bash
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

This creates:

| Account | Email | Password | Role |
|---------|-------|----------|------|
| Admin   | admin@cellarion.app | Admin1234!demo | admin |
| Demo user | user@cellarion.app | User1234!demo | user |

…plus 2 countries, 2 regions, 5 grape varieties, 2 wine definitions, and a demo cellar with sample bottles.

> These are local development credentials. Change them before deploying anywhere public.

### Stop

```bash
docker-compose down          # keep data
docker-compose down -v       # also remove all volumes (wipes database)
```

---

## Architecture

```
Cellarion/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── aiConfig.js         # AI chat feature flags, model config, daily limits
│   │   │   ├── db.js               # MongoDB connection
│   │   │   ├── plans.js            # Subscription plan config
│   │   │   └── upload.js           # Multer config
│   │   ├── middleware/
│   │   │   ├── auth.js             # JWT + role middleware (requireAuth, requireAdmin, requireSomm)
│   │   │   └── bottleAccess.js     # requireBottleAccess(minRole) factory
│   │   ├── models/                 # 22 Mongoose schemas
│   │   │   ├── User.js
│   │   │   ├── WineDefinition.js   # Shared wine registry (vintage-neutral)
│   │   │   ├── Bottle.js           # User-owned bottle records
│   │   │   ├── Cellar.js
│   │   │   ├── Rack.js             # 8×4 grid rack layout
│   │   │   ├── AuditLog.js
│   │   │   ├── BottleImage.js      # Bottle photo metadata
│   │   │   ├── WineVintageProfile.js
│   │   │   ├── WineVintagePrice.js
│   │   │   ├── WineRequest.js
│   │   │   ├── WineReport.js       # User-submitted wine quality reports
│   │   │   ├── WineEmbedding.js    # Vector embedding tracking for RAG
│   │   │   ├── Country.js
│   │   │   ├── Region.js
│   │   │   ├── Appellation.js      # Wine appellations (e.g. Barolo, Châteauneuf-du-Pape)
│   │   │   ├── Grape.js
│   │   │   ├── ChatUsage.js        # Daily AI chat usage per user
│   │   │   ├── Notification.js     # In-app notifications
│   │   │   ├── SupportTicket.js    # User support tickets
│   │   │   ├── SiteConfig.js       # Global admin settings
│   │   │   ├── ImportSession.js    # Persisted bottle import state
│   │   │   └── ExchangeRateSnapshot.js # Cached currency exchange rates
│   │   ├── routes/
│   │   │   ├── auth.js             # /api/auth/*
│   │   │   ├── cellars.js          # /api/cellars/*
│   │   │   ├── bottles.js          # /api/bottles/*
│   │   │   ├── wines.js            # /api/wines/*
│   │   │   ├── racks.js            # /api/racks/*
│   │   │   ├── wineRequests.js     # /api/wine-requests/*
│   │   │   ├── wineReports.js      # /api/wine-reports/*
│   │   │   ├── import.js           # /api/bottles/import/*
│   │   │   ├── chat.js             # /api/chat (AI cellar chat)
│   │   │   ├── stats.js            # /api/stats/overview
│   │   │   ├── notifications.js    # /api/notifications
│   │   │   ├── support.js          # /api/support
│   │   │   ├── settings.js         # /api/settings
│   │   │   ├── images.js           # /api/images/*
│   │   │   ├── users.js            # /api/users/*
│   │   │   ├── health.js           # /api/health
│   │   │   ├── superadmin.js       # /api/superadmin/* (super admin only)
│   │   │   ├── admin/              # /api/admin/* (admin role)
│   │   │   └── somm/               # /api/somm/* (sommelier features)
│   │   ├── services/
│   │   │   ├── aiChat.js           # RAG pipeline: embed → Qdrant → Claude response
│   │   │   ├── audit.js            # Audit logging
│   │   │   ├── embedding.js        # Voyage AI embedding generation
│   │   │   ├── findOrCreateWine.js # Intelligent wine lookup/creation
│   │   │   ├── imageProcessor.js   # Background removal via rembg
│   │   │   ├── labelScan.js        # Anthropic Vision API for label scanning
│   │   │   ├── notifications.js    # Notification creation for key events
│   │   │   ├── search.js           # Meilisearch integration
│   │   │   ├── statsService.js     # Stats computation
│   │   │   └── vectorStore.js      # Qdrant REST client for vector search
│   │   ├── utils/
│   │   │   ├── cellarAccess.js     # Ownership verification
│   │   │   ├── drinkWindow.js      # classifyDrinkWindow() shared helper
│   │   │   ├── normalize.js        # Wine name dedup & fuzzy matching
│   │   │   └── ratingUtils.js      # Rating scale conversion + resolveRating()
│   │   ├── data/                   # Taxonomy reference JSON files
│   │   └── seed-demo.js            # Demo data seeder
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── api/                    # API client wrappers
│   │   │   ├── admin.js            # Admin endpoints (wine reports, rate limits, etc.)
│   │   │   ├── bottles.js          # getBottle, updateBottle, consumeBottle, import
│   │   │   ├── cellars.js          # getCellar, updateCellar, deleteCellar, …
│   │   │   ├── importSessions.js   # Import session management
│   │   │   ├── racks.js            # getRacks, deleteRack, updateSlot, clearSlot
│   │   │   ├── support.js          # Support tickets & wine reports
│   │   │   └── wines.js            # searchWines, getWine, scanLabel
│   │   ├── components/
│   │   │   ├── BottleCard.js       # Bottle row/card (list + grid view)
│   │   │   ├── CellarionLogo.js    # Brand SVG logo component
│   │   │   ├── Layout.js           # Persistent navbar + bottom nav + mobile menu
│   │   │   ├── Modal.js            # Shared modal overlay
│   │   │   ├── NotificationBell.js # Notification dropdown with unread badge
│   │   │   ├── ReportWineModal.js  # Wine quality report modal
│   │   │   ├── SupportModal.js     # Support ticket submission modal
│   │   │   ├── ProtectedRoute.js
│   │   │   └── ErrorBoundary.js
│   │   ├── contexts/
│   │   │   ├── AuthContext.js      # Global auth state
│   │   │   ├── ThemeContext.js     # Dark/light mode with system preference detection
│   │   │   └── NotificationContext.js # Notification polling & unread count
│   │   ├── pages/                  # App screens
│   │   │   ├── LandingPage.js      # Public landing page
│   │   │   ├── Login.js            # Auth (login/register)
│   │   │   ├── VerifyEmail.js      # Email verification
│   │   │   ├── ResetPassword.js    # Password reset flow
│   │   │   ├── CellarChat.js       # AI cellar chat interface
│   │   │   ├── Statistics.js       # Analytics dashboard with charts & world map
│   │   │   ├── DrinkAlerts.js      # Drink-window alerts by urgency
│   │   │   ├── Plans.js            # Subscription plan comparison
│   │   │   ├── Settings.js         # User preferences (currency, language, rating scale)
│   │   │   ├── SupportPage.js      # Support tickets & wine reports
│   │   │   ├── SommMaturity.js     # Sommelier maturity phase management
│   │   │   ├── SommPrices.js       # Sommelier pricing data management
│   │   │   ├── SuperAdmin.js       # Platform-wide admin dashboard
│   │   │   ├── AdminSupportTickets.js
│   │   │   ├── AdminWineReports.js
│   │   │   └── …                   # Cellar, bottle, rack, wine pages
│   │   ├── config/
│   │   │   ├── currencies.js
│   │   │   └── plans.js
│   │   ├── utils/                  # Frontend helpers
│   │   └── styles/common.css
│   ├── nginx.conf                  # nginx config (SPA + /api/ proxy)
│   └── Dockerfile                  # Multi-stage: Node build → nginx:alpine
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
traefik.http.services.cellarion.loadbalancer.server.port: "80"
```

Update the `Host(...)` rule to match your own domain.

---

## Core Concepts

| Entity | Description |
|--------|-------------|
| **WineDefinition** | Vintage-neutral wine entry in the shared registry. Admins create and manage these. |
| **Bottle** | A user's bottle: references a WineDefinition and adds vintage, price, rating, notes, rack location. |
| **Cellar** | Named container of Bottles, owned by a user. Can be shared with other users via role-based access. |
| **Rack** | 8×4 grid within a Cellar for physical bottle placement. |
| **WineRequest** | User-submitted wine suggestion. Admins review and fulfil by creating a WineDefinition. |
| **Taxonomy** | Admin-managed Countries, Regions, Appellations, and Grapes to prevent free-text proliferation. |
| **Notification** | In-app notification for events like wine requests resolved, images approved, cellars shared. |
| **SupportTicket** | User support tickets with admin response tracking. |
| **WineReport** | User-submitted wine quality reports (wrong info, duplicates, inappropriate content). |

### User Roles

| Role | Description |
|------|-------------|
| **user** | Standard user — manages own cellars, bottles, and requests |
| **sommelier** | Can manage maturity profiles and pricing data for wines |
| **admin** | Full access — wine library, taxonomy, user management, image review, audit log |
| **super admin** | Platform-level access — system monitor, service health, rate limits, embedding management |

---

## API Summary

### Auth — `/api/auth`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/register` | Create account (sends verification email if Mailgun is configured) |
| POST | `/login` | Login, returns JWT (blocked until email is verified when Mailgun is configured) |
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
| GET | `/:id/export` | Export all bottles as JSON (owner only) |

### Bottles — `/api/bottles` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Add bottle to cellar |
| PUT | `/:id` | Update bottle |
| DELETE | `/:id` | Remove bottle |
| POST | `/import/validate` | Validate import data and match wines |
| POST | `/import/confirm` | Create bottles from validated import |

### Wine Registry — `/api/wines` *(auth required)*

All wine registry endpoints require a valid JWT. Behaviour differs by role:

- **Regular users** — `search` param is mandatory; results capped at 10.
- **Admin / Sommelier** — full browse without a search term; no result cap.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Search/filter wines. Params: `search`, `type`, `country`, `region`, `grapes`, `sort`, `limit`, `offset` |
| GET | `/:id` | Get a single wine definition by ID |

### Chat — `/api/chat` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Send a question to the AI cellar chat (RAG pipeline) |

### Notifications — `/api/notifications` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Get user's notifications |
| PUT | `/:id/read` | Mark notification as read |
| PUT | `/read-all` | Mark all notifications as read |

### Stats — `/api/stats` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/overview` | Collection analytics (all cellars) |

### Support — `/api/support` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tickets` | Get user's support tickets |
| POST | `/tickets` | Submit a support ticket |

### Wine Reports — `/api/wine-reports` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Get user's wine reports |
| POST | `/` | Report a wine issue (wrong info, duplicate, etc.) |

### Wine Requests — `/api/wine-requests` *(auth required)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Get user's wine requests |
| POST | `/` | Submit a new wine request |

### Sommelier — `/api/somm/*` *(somm or admin role)*

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/maturity` | Manage maturity phases for wine vintages |
| GET/POST | `/prices` | Manage pricing data for wine vintages |

### Admin — `/api/admin/*` *(admin role required)*

| Method | Path | Description |
|--------|------|-------------|
| POST/PUT/DELETE | `/wines` | Manage wine definitions |
| GET/PUT | `/wine-requests` | Review user wine requests |
| CRUD | `/taxonomy/*` | Manage countries, regions, appellations, grapes |
| GET/DELETE | `/images` | Manage bottle images |
| GET | `/audit` | View audit log |
| GET | `/users` | Manage users |
| GET/PUT | `/support-tickets` | Manage support tickets |
| GET/PUT | `/wine-reports` | Manage wine reports |

### Super Admin — `/api/superadmin/*` *(super admin only)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | Platform analytics (user counts, plan distribution) |
| GET/PUT | `/settings` | Rate limits, contact email, AI config |
| POST | `/embeddings` | Manage embedding jobs |

---

## Environment Variables

Copy `.env.example` to `.env` in the project root and set the required values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **Yes** | — | Long random string for signing JWTs |
| `MEILI_MASTER_KEY` | **Yes** | — | Long random string for Meilisearch auth |
| `MONGO_URI` | No | `mongodb://mongo:27017/winecellar` | MongoDB connection |
| `JWT_EXPIRES_IN` | No | `7d` | Token TTL |
| `PORT` | No | `5000` | Backend port |
| `FRONTEND_URL` | No | `http://localhost` | CORS origin — set to your domain in production |
| `MEILI_URL` | No | `http://meilisearch:7700` | Meilisearch URL |
| `REMBG_URL` | No | `http://rembg:5000` | Background removal service |
| `ANTHROPIC_API_KEY` | No | — | Enables label scanning and AI cellar chat ([get a key](https://console.anthropic.com/)) |
| `VOYAGE_API_KEY` | No | — | Required for AI cellar chat embeddings ([get a key](https://dash.voyageai.com/)) |
| `QDRANT_URL` | No | `http://qdrant:6333` | Vector database URL (auto-set in Docker Compose) |
| `SUPER_ADMIN_EMAIL` | No | — | Email of the super admin account |
| `SUPER_ADMIN_IPS` | No | — | Comma-separated IP allowlist for super admin access |
| `MAILGUN_API_KEY` | No | — | Mailgun API key — enables email verification when set |
| `MAILGUN_DOMAIN` | No | — | Mailgun sending domain (e.g. `mg.yourdomain.com`) |
| `MAILGUN_FROM` | No | `Cellarion <no-reply@{DOMAIN}>` | Sender address shown in verification emails |
| `MAILGUN_API_URL` | No | `https://api.mailgun.net` | Use `https://api.eu.mailgun.net` for EU region |

### AI Cellar Chat

The AI chat feature requires three services working together:

1. **Anthropic Claude** (`ANTHROPIC_API_KEY`) — generates conversational responses grounded in your cellar
2. **Voyage AI** (`VOYAGE_API_KEY`) — creates wine embeddings for semantic search
3. **Qdrant** (`QDRANT_URL`) — vector database for fast similarity search

When all three are configured, users can ask natural-language questions about their collection (food pairings, occasion picks, cellar insights). The system only surfaces wines the user actually owns — no hallucinated recommendations.

Daily usage quotas are configurable per subscription plan.

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

Users can import bottles from other wine cellar apps (Vivino, CellarTracker, or any generic CSV). The import flow:

1. **Upload** — Drop a CSV file; the system auto-detects the source format and maps it to a standard schema
2. **Validate** — Each item is matched against the wine library using fuzzy search (Meilisearch + MongoDB text search + normalized key lookup) and scored with combined similarity
3. **Review** — Users see match results: exact matches (auto-selected), fuzzy matches (pick from candidates), and unmatched items (search manually or skip)
4. **Import** — Confirmed items are created as bottles in the target cellar

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

### Bottle Export

Cellar owners can export all bottles via the overflow menu (⋯ → Export Bottles). Available in JSON and CSV. The export includes rack placement (`rackName`, `rackPosition`, `rackRow`, `rackCol`) but excludes images and staff-curated data (sommelier drink windows, pricing). The JSON format is directly re-importable.

---

## Wine Deduplication

When an admin creates a wine, the system checks for near-duplicates using:

1. **Levenshtein distance** (40%) — character-level similarity
2. **Trigram Jaccard** (30%) — overlapping 3-char sequences
3. **Token Jaccard** (30%) — word-level similarity after removing wine domain stop words

Score: `name × 0.45 + producer × 0.45 + appellation × 0.10`

Candidates above the threshold (default 0.75) appear as warnings with a "Use This" option.

---

## Testing

### Frontend

```bash
cd frontend && npm test -- --watchAll=false
```

Uses Jest + React Testing Library (bundled with Create React App). Covers drink-window logic, currency conversion, and the shared Modal component.

### Backend

```bash
cd backend && npm test
```

Uses Jest. Covers auth middleware, cellar access control, wine normalisation/similarity, rating scale conversion, and drink-window classification.

**Run both test suites before opening a pull request. PRs with failing tests will not be merged.**

---

## Contributing

1. Fork the repo and create a feature branch off `main`
2. Make your changes
3. Run the tests (`cd frontend && npm test -- --watchAll=false` and `cd backend && npm test`)
4. Smoke-test in Docker: `docker-compose up --build`
5. Submit a pull request with a clear description of your changes

---

## Reporting a Vulnerability

Please report security issues privately to:
github@cellarion.app

---

## License

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)

You are free to use, modify, and self-host this software. If you run a modified version as a network service, you must make your source code available to users of that service. Commercial hosting of this software as a managed service requires a separate agreement.

---

## Acknowledgements

This codebase was developed together with [Claude Code](https://claude.ai/claude-code) by Anthropic.
