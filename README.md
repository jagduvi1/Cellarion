# Cellarion

A self-hosted wine cellar management app built with the MERN stack. Track your bottles, organize them into cellars and racks, search a shared wine registry, and get drink-window recommendations.

## Stack

- **MongoDB 7** — Database
- **Express 5** — Backend API
- **React 19** — Frontend
- **Node.js 20** — Runtime
- **Meilisearch** — Fuzzy search
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

| URL | Description |
|-----|-------------|
| http://localhost:3000 | Frontend (React) |
| http://localhost:5000/api/health | Backend health check |
| http://localhost:7700 | Meilisearch (search engine) |

### Seed demo data

After the containers are running:

```bash
docker exec cellarion-backend node src/seed-demo.js
```

This creates:

| Account | Email | Password | Role |
|---------|-------|----------|------|
| Admin   | admin@cellarion.app | Admin1234 | admin |
| Demo user | user@cellarion.app | User1234 | user |

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
│   │   ├── middleware/auth.js    # JWT + role middleware
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
│   │   │   ├── admin/            # /api/admin/* (admin role)
│   │   │   └── somm/             # /api/somm/* (sommelier features)
│   │   ├── services/
│   │   │   ├── audit.js          # Audit logging
│   │   │   ├── imageProcessor.js # Background removal integration
│   │   │   └── search.js         # Meilisearch integration
│   │   ├── utils/
│   │   │   ├── cellarAccess.js   # Ownership verification
│   │   │   └── normalize.js      # Wine name dedup & fuzzy matching
│   │   ├── data/                 # Taxonomy reference JSON files
│   │   └── seed-demo.js          # Demo data seeder
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── CellarionLogo.js  # Brand SVG logo
│   │   │   ├── Layout.js         # Persistent navbar
│   │   │   ├── ProtectedRoute.js
│   │   │   └── ErrorBoundary.js
│   │   ├── contexts/AuthContext.js
│   │   ├── pages/                # All app screens
│   │   └── styles/common.css
│   └── Dockerfile
├── rembg/                        # Python background-removal service
└── docker-compose.yml
```

### Services

| Service      | Port  | Description                     |
|--------------|-------|---------------------------------|
| MongoDB      | 27017 | Internal only                   |
| Meilisearch  | 7700  | Fuzzy search engine             |
| Backend      | 5000  | Express REST API                |
| Frontend     | 3000  | React dev server                |
| rembg        | 5001  | Background removal (optional)   |

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
| POST | `/register` | Create account |
| POST | `/login` | Login, returns JWT |

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
| DELETE | `/:id` | Remove bottle |

### Wine Registry — `/api/wines` *(public read)*

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Search/filter wines. Params: `search`, `type`, `country`, `region`, `sort`, `limit`, `offset` |

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
| `FRONTEND_URL` | No | `http://localhost:3000` | CORS origin |
| `MEILI_URL` | No | `http://meilisearch:7700` | Meilisearch URL |
| `REMBG_URL` | No | `http://rembg:5000` | Background removal service |

---

## Wine Deduplication

When an admin creates a wine, the system checks for near-duplicates using:

1. **Levenshtein distance** (40%) — character-level similarity
2. **Trigram Jaccard** (30%) — overlapping 3-char sequences
3. **Token Jaccard** (30%) — word-level similarity after removing wine domain stop words

Score: `name × 0.45 + producer × 0.45 + appellation × 0.10`

Candidates above the threshold (default 0.75) appear as warnings with a "Use This" option.

---

## Contributing

1. Fork the repo and create a feature branch
2. Run the app with `docker-compose up --build`
3. Seed demo data with `docker exec cellarion-backend node src/seed-demo.js`
4. Submit a pull request with a clear description of your changes

---

## License

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)

You are free to use, modify, and self-host this software. If you run a modified version as a network service, you must make your source code available to users of that service. Commercial hosting of this software as a managed service requires a separate agreement.
