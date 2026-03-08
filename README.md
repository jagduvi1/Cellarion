# Cellarion

A self-hosted wine cellar management app built with the MERN stack. Track your bottles, organize them into cellars and racks, search a shared wine registry, and get drink-window recommendations.

## Hosted Version

Cellarion is now live and publicly available at:

👉 https://cellarion.app

You can create an account and start using the full hosted service today.

## Stack

- **MongoDB 7** — Database
- **Express 4** — Backend API
- **React 19** — Frontend
- **Node.js 20** — Runtime
- **Meilisearch** — Fuzzy search
- **nginx** — Serves the React SPA and proxies `/api/` to the backend (internal)
- **Traefik** — External reverse proxy (bring your own; not included in this Compose file)
- **Docker Compose** — Containerization

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
│   │   │   ├── db.js             # MongoDB connection
│   │   │   └── plans.js          # Subscription plan config
│   │   ├── middleware/
│   │   │   ├── auth.js           # JWT + role middleware
│   │   │   └── bottleAccess.js   # requireBottleAccess(minRole) factory
│   │   ├── models/               # Mongoose schemas
│   │   │   ├── User.js
│   │   │   ├── WineDefinition.js # Shared wine registry (vintage-neutral)
│   │   │   ├── Bottle.js         # User-owned bottle records
│   │   │   ├── Cellar.js
│   │   │   ├── Rack.js           # 8×4 grid rack layout
│   │   │   ├── AuditLog.js
│   │   │   ├── WineVintageProfile.js
│   │   │   ├── WineVintagePrice.js
│   │   │   ├── WineRequest.js
│   │   │   ├── Country.js
│   │   │   ├── Region.js
│   │   │   └── Grape.js
│   │   ├── routes/               # REST API routes
│   │   │   ├── auth.js           # /api/auth/*
│   │   │   ├── cellars.js        # /api/cellars/*
│   │   │   ├── bottles.js        # /api/bottles/*
│   │   │   ├── wines.js          # /api/wines/*
│   │   │   ├── racks.js          # /api/racks/*
│   │   │   ├── wineRequests.js   # /api/wine-requests/*
│   │   │   ├── import.js         # /api/bottles/import/* (bottle import)
│   │   │   ├── admin/            # /api/admin/* (admin role)
│   │   │   └── somm/             # /api/somm/* (sommelier features)
│   │   ├── services/
│   │   │   ├── audit.js          # Audit logging
│   │   │   ├── imageProcessor.js # Background removal integration
│   │   │   ├── labelScan.js      # Anthropic vision API for label scanning
│   │   │   ├── search.js         # Meilisearch integration
│   │   │   └── statsService.js   # Stats computation (extracted from route)
│   │   ├── utils/
│   │   │   ├── cellarAccess.js   # Ownership verification
│   │   │   ├── drinkWindow.js    # classifyDrinkWindow() shared helper
│   │   │   ├── normalize.js      # Wine name dedup & fuzzy matching
│   │   │   └── ratingUtils.js    # Rating scale conversion + resolveRating()
│   │   ├── data/                 # Taxonomy reference JSON files
│   │   └── seed-demo.js          # Demo data seeder
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── api/                  # Typed API client wrappers
│   │   │   ├── bottles.js        # getBottle, updateBottle, consumeBottle, validateImport, confirmImport
│   │   │   ├── cellars.js        # getCellar, updateCellar, deleteCellar, …
│   │   │   ├── racks.js          # getRacks, deleteRack, updateSlot, clearSlot
│   │   │   └── wines.js          # searchWines, getWine, scanLabel
│   │   ├── components/
│   │   │   ├── BottleCard.js     # Bottle row/card (shared by list + grid view)
│   │   │   ├── CellarionLogo.js  # Brand SVG logo
│   │   │   ├── Layout.js         # Persistent navbar
│   │   │   ├── Modal.js          # Shared modal overlay shell
│   │   │   ├── ProtectedRoute.js
│   │   │   └── ErrorBoundary.js
│   │   ├── contexts/AuthContext.js
│   │   ├── pages/                # App screens
│   │   └── styles/common.css
│   ├── nginx.conf                # nginx config (SPA + /api/ proxy)
│   └── Dockerfile                # Multi-stage: Node build → nginx:alpine
├── rembg/                        # Python background-removal service
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
| **Cellar** | Named container of Bottles, owned by a user. Can be shared with other users. |
| **Rack** | 8×4 grid within a Cellar for physical bottle placement. |
| **WineRequest** | User-submitted wine suggestion. Admins review and fulfil by creating a WineDefinition. |
| **Taxonomy** | Admin-managed Countries, Regions, and Grapes to prevent free-text proliferation. |

---

## API Summary

### Auth — `/api/auth`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/register` | Create account (sends verification email if Mailgun is configured) |
| POST | `/login` | Login, returns JWT (blocked until email is verified when Mailgun is configured) |
| GET | `/verify-email?token=` | Verify email address, returns JWT on success |
| POST | `/resend-verification` | Resend verification email |

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

### Admin — `/api/admin/*` *(admin role required)*

| Method | Path | Description |
|--------|------|-------------|
| POST/PUT/DELETE | `/wines` | Manage wine definitions |
| GET/PUT | `/wine-requests` | Review user wine requests |
| CRUD | `/taxonomy/*` | Manage countries, regions, grapes |
| GET/DELETE | `/images` | Manage bottle images |

---

## Environment Variables

Copy `.env.example` to `.env` in the project root and set the two required values:

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
| `MAILGUN_API_KEY` | No | — | Mailgun API key — enables email verification when set |
| `MAILGUN_DOMAIN` | No | — | Mailgun sending domain (e.g. `mg.yourdomain.com`) |
| `MAILGUN_FROM` | No | `Cellarion <no-reply@{DOMAIN}>` | Sender address shown in verification emails |
| `MAILGUN_API_URL` | No | `https://api.mailgun.net` | Use `https://api.eu.mailgun.net` for EU region |

### Email verification

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

Access the import from any cellar's overflow menu (⋯ → Import Bottles). Requires editor or owner access.

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
```

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

This codebase were developed together with [Claude Code](https://claude.ai/claude-code) by Anthropic.
