# Vintage-availability data sources — global sweep 2026-07-02

Result of a 41-agent research sweep: every candidate below was **live-verified** on
2026-07-02 (actual HTTP fetches, real wine queries — Château Margaux / Sassicaia /
Tignanello — fields quoted from real responses). Verdicts: 23 strong, 7 possible,
2 reject. Context: personal-test polling (a handful of wines, daily, from a Node
script), free access required.

Prior settled verdicts still stand: Vinmonopolet ✅ (provider built), Alko (WAF,
needs headless), Wine-Searcher (paid + scraping banned), Vivino (ToS-hostile),
Liv-ex APIs (paid, business-only), LWIN (free, prediction-only), CellarTracker (no
availability).

---

## Tier 1 — best signals for the probe

### 1. Systembolaget daily mirror — `susbolaget.emrik.org` (C4illin/systembolaget-data) ⭐ biggest find
- **Sweden is back on the table.** Community-hosted daily mirror of the FULL
  Systembolaget catalog: one JSON array at `https://susbolaget.emrik.org/v1/products`
  (~100 MB raw / ~8 MB compressed transfer, 46k products, 13,619 with a populated
  `vintage` field). Refreshed nightly ~03:00 SE time (verified Last-Modified same day).
- No auth, CORS `*`, ETag + Last-Modified → conditional GETs. MIT-licensed repo
  (github.com/C4illin/systembolaget-data, actively maintained, 443 commits).
- Per row: `vintage`, producer, price, assortment tier, stock flags
  (`isTemporaryOutOfStock` / `isCompletelyOutOfStock` / `isDiscontinued`) and
  **`productLaunchDate` including FUTURE dates** (~2+ weeks ahead) → advance notice.
  Verified: Sassicaia 2021 = out of stock, 2022 = in stock, as separate rows.
- ⚠️ Caveats: single hobbyist host (SPOF); upstream is scraped from Systembolaget's
  internal API — Systembolaget killed Systembevakningsagenten via C&D in Dec 2022,
  so treat as personal-use only, never productize; Sweden coverage only.

### 2. Millésima (SE storefront) — sitemap diff + JSON-LD
- `https://www.millesima.com/se/sitemap/product_12003.xml` — 10,745 URLs, one per
  wine **per vintage** (vintage = last slug token). Robots-published (invited).
- Unreleased vintages **404**; released return 200 with schema.org JSON-LD:
  `productionDate` (vintage), `offers.availability` (InStock), SEK price.
  Verified: Margaux 2025 EP already listed; Cos d'Estournel 2026 → 404.
- Daily sitemap diff filtered to watched wines = clean "new vintage listed" event.
  Avoid query-param URLs (`*vintage=*` is robots-disallowed); canonical pages only.
- Independently found + verified by three separate agents. Fine wine, Bordeaux-heavy.

### 3. SAQ (Québec) — public Magento GraphQL
- `POST https://www.saq.com/graphql` — free, no key, no bot challenge (plain curl).
- Per-vintage SKUs (Sassicaia 2016/2017/2018 = separate SKUs each with own
  `stock_status`), `millesime_produit` attribute, availability start dates, and a
  queryable **new-arrivals category**. robots.txt does not disallow /graphql.
- Undocumented internal API → could change without notice.

### 4. LCBO (Ontario) — GraphQL + VINTAGES release calendar
- `POST https://www.lcbo.com/graphql` — free, unauthenticated. Vintage lives in the
  product **name** (regex it, like Vinmonopolet). Same-SKU vintage rollover proven
  (SKU 25727: "Musar Red 2017" → today "…2019").
- VINTAGES "New Release Collection" = category_id **2513**; dated biweekly release
  subcategories enumerable — the 2026-07-04 release (id 321781, 94 products) was
  queryable 2 days early. ToS bans automated extraction *for commercial purposes*
  only — personal use OK.
- Caveat: OUT_OF_STOCK never observed (search hides them) → availability =
  presence-in-results.

### 5. Justerini & Brooks — cleanest URL identity
- `https://www.justerinis.com/product/sitemap.xml` (10,676 URLs, path ends in
  vintage year). Guessed-URL probe cleanly discriminates: Margaux 2024/2025 → 200
  with JSON-LD offers + per-variant stock; 2026/1923 → 404. SSR, no WAF, permissive
  robots, ToS has zero scraping clauses.

### 6. Winefinder.se — Swedish-facing retail with Microdata
- Each vintage = own product page (year in slug, own SKU) with schema.org Microdata:
  `availability` InStock/OutOfStock, SEK price. Verified InStock/OutOfStock split
  on Solaia 2021 vs 2022. robots.txt allows /vin/ + producer pages.
- The api.winefinder.se Swagger is an empty shell (no callable paths) — poll
  producer pages (e.g. `/vinbutik/producent/antinori`) + product-page Microdata.
  Sitemap is partial (current assortment ~335 products) — don't rely on it.

### 7. wein.cc — free Wine-Searcher substitute (EU)
- `https://wein.cc/wein/weinsuche.php?q=sassicaia+2023` — server-rendered offer
  aggregator across 300+ DE/AT/CH/FR/IT/ES merchants; vintage in every offer title,
  "wine + year" query isolates one vintage (Sassicaia 2023 → 14 offers).
- ToS **explicitly permits** crawlers that self-identify in the User-Agent and
  respect robots.txt — set a custom UA. First-offer-appears = market signal.
  Caveat: name-match filtering needed (second wines appear); stock often unknown.

### 8. Berry Bros & Rudd — vintage-encoded SKU sitemap
- `https://www.bbr.com/media/sitemap/sitemap-products-1.xml` — SKU = 4-digit vintage
  prepended to a stable per-wine base ID (Margaux base 8007951 → 19558007951 …
  20248007951). Diff filtered on base ID = reliable detector. `/new-fine-wine-releases`
  SSR page as secondary. Caveat: JSON-LD availability reflects duty-paid retail only
  (EP/in-bond shows offerCount 0).

## Tier 2 — strong, more specialized

- **Shopify `/products.json` (generic pattern)** — any Shopify wine shop exposes
  `https://<shop>/products.json?limit=250`: per-vintage products, `variants[].available`,
  price, `published_at` (first-listed timestamp!). Verified on winetales.se (SE),
  morenaturalwine.com, vervewine.com (Sassicaia 2006–2020 per-vintage). Shopify's own
  robots header says public product JSON is crawlable. Find one Shopify shop per
  watched wine → free per-store API.
- **Decántalo** — stable per-wine URL; JSON-LD ProductGroup→hasVariant lists every
  purchasable vintage with own InStock offer. Vintage rotation proven live (Viña
  Ardanza 2019 → 2020 on same URL). Ships to SE.
- **Vinatis** — search + product pages embed server-rendered JSON: explicit vintage
  field, live stock count, orderability, **first-listing date**. Ships to SE.
  (Claimed Microdata doesn't exist — read the embedded JSON.)
- **Farr Vintners** — `/winelist.php?show=all` one HTML table (Region|Vintage|Wine|
  Qty|Price|Score) with "New" badges whose tooltips carry the exact date added.
  ⚠️ the better EP what's-new page (`/en_primeur/whatsnew.php?days=N`) is
  robots-disallowed — use winelist only if compliant.
- **iDealwine** — free per-vintage price-estimate (cote) pages + live fixed-price
  stock counts + EP offers, no login (Margaux 1900–2022 + 2025 EP visible).
- **Pennsylvania LCB** — official free XLSX (5,908 SKUs, ~weekly) with explicit
  **Vintage column** + a companion 12-week **Item Change** XLSX = ready-made diff.
  ~50% of rows vintage-neutral ("Available Vintage").
- **Vinbanken.se** (SE press) — structured article per Systembolaget temp-assortment
  release, wine + vintage + SB article number + price, published **~3 days before
  launch**. Discovery via `/sitemap/articles.xml`. Curated subset only.
- **Winetable.se** (SE press) — same pattern, predictable slugs
  (`tillfalligt-sortiment-systembolaget-<D>-<månad>-<YYYY>`), ~2 days before launch,
  ~75–80% of each release covered.
- **Bordoverview.com** — free HTML table of Bordeaux EP releases per campaign
  (2004–2025), price-appears = offer-live event, updated daily in season.
  robots Crawl-delay 10.
- **Lay & Wheeler EP release calendar** — forward-looking expected release dates per
  château; the site's open WordPress REST API (`/wp-json/wp/v2/`) returns the post
  as JSON with `modified` timestamp. Seasonal (Apr–Jun).

## Possible (usable with caveats)

- **Zachys (Shopify)** — technically perfect (per-vintage products, `available`
  boolean, pre-arrival visible) but **ToS explicitly bans scraping for any purpose**
  → skip; robots points to a sanctioned UCP/MCP catalog worth a look.
- **Wine.com sitemaps** — 268k per-vintage URLs regenerated daily, current releases
  present; but product pages/API DataDome-blocked → listing signal only, stale URLs
  linger; ToS bans automated extraction.
- **Bordeaux Index LiveTrade API** — documented free wine API with per-vintage
  offers + delta endpoint, but registration needs company details + manual approval.
- **wineapi.io** — real API, free tier (100 req/day, personal use), nullable
  `vintage` + per-wine live-offers endpoint; unverified behind signup (Turnstile).
- **WineStreet** — OpenAPI schema is exactly right (per-vintage offers by LWIN) but
  no self-serve access (email for trial).
- **ÁTVR Iceland (vinbudin.is DoSearch JSON)** — free live JSON but `ProductYear`
  blank for ~100% of wines, vintages rotate silently under one SKU → not usable.
- **The Wine Cellar Insider WP API** — free JSON press signal ("2023 Margaux Buying
  Guide" appears when vintage ships) — corroboration only.

## Rejected

- **Liv-ex blog RSS** — release-to-trade coverage moved behind membership (verified
  during the 2025 EP campaign: zero named releases in the free feed).
- **Apify Wine-Searcher actor** — 402 without paid plan + residential proxies, and
  Wine-Searcher ToS bans all robot access.

## Leads not fully explored (from completeness critic)

- **K&L Wine Merchants** new-arrival feed is bot-walled (403) — their **email alerts
  parsed via IMAP** are the compliant path; email-parsing works for any bot-walled
  merchant.
- **finewines.se forum** "Lanseringar från Systembolaget" (host 403'd at check time)
  and **Vinjournalen** `/systembolaget-lanseringar/` — more SE press signals.
- **changedetection.io** (self-hosted) as a generic page-watcher for merchants with
  no structured data; **Wayback CDX API** to retro-measure each source's lead time.
- Producer-direct release pages / La Place September campaign press for icon wines.
- ⚠️ Legal context for anything Systembolaget-derived: they forced
  Systembevakningsagenten to shut down (Dec 2022, C&D over scraping). The susbolaget
  mirror carries the same upstream exposure — fine for a personal probe, not for the
  hosted product.

## Compliance quick view (robots.txt + ToS as read on 2026-07-02)

Every verifier fetched robots.txt and skimmed the terms of its source. Grouping:

**🟢 Explicitly allowed / invited** — safe to poll politely:
- Millésima (robots *publishes* the product sitemap; canonical pages allowed — never the `*vintage=*` query URLs)
- Justerini & Brooks (sitemap advertised, permissive robots, ToS has zero scraping clauses)
- Berry Bros & Rudd (sitemap advertised in robots; product + new-releases pages allowed)
- wein.cc (ToS **explicitly permits** self-identifying, robots-respecting crawlers — set a custom User-Agent)
- Pennsylvania LCB (official files published expressly for download)
- Shopify `/products.json` (Shopify's own robots policy: public product JSON is crawlable)
- Winefinder (robots: `Allow: /` for /vin/ + producer pages; terms have no automation clause — avoid the disallowed `/ajax.aspx*`)
- Lay & Wheeler (open WP REST API, /magazine/ allowed)
- Bordoverview (robots allows table pages, honor `Crawl-delay: 10`)
- Vinbanken / Winetable (no scraping ban; robots allow articles + provide sitemaps)

**🟡 Not documented, but nothing prohibits personal use** — fine for a private test, re-check before productizing:
- SAQ GraphQL (robots doesn't disallow /graphql; terms have no scraping ban — undocumented internal API)
- LCBO GraphQL (ToS bans automated extraction **for commercial purposes** only — personal use is inside the line)
- Vinatis, Decántalo, iDealwine (no bans found; iDealwine has an EU database-right clause → extract only the few wines watched, never bulk)
- susbolaget.emrik.org (mirror itself: MIT, no restrictions; but upstream is scraped Systembolaget data — see legal note above; personal use only)
- Farr Vintners `/winelist.php` (allowed) — but `/en_primeur/whatsnew.php` is **robots-disallowed: do not use**

**🔴 Prohibited — do not poll, regardless of technical ease:**
- Zachys (ToS bans scraping "for any purpose")
- Wine.com (ToS bans automated extraction; pages DataDome-blocked anyway)
- Wine-Searcher in any form, incl. Apify actors (ToS bans all robot access)
- Vivino (settled earlier: ToS-hostile)
- Systembolaget.se directly (scraping disallowed — only the third-party mirror, personal use)

## Suggested provider set for this probe (union = "released anywhere")

| Provider | Role | Effort |
|----------|------|--------|
| `vinmonopolet.js` (built ✅) | NO monopoly, full catalog | done |
| `susbolaget.js` | SE full catalog + future launch dates | easy (1 JSON GET/day) |
| `millesima.js` | global fine wine, sitemap diff + 404-probe | easy |
| `saq.js` / `lcbo.js` | North America GraphQL + release calendar | easy |
| `justerinis.js` or `bbr.js` | UK fine wine, URL/SKU probe | easy |
| `weincc.js` | EU-wide offer aggregation (custom UA) | easy |
| `vinbanken.js` / `winetable.js` | SE pre-launch press (name match) | medium |
| `lwin.js` | expected-next-vintage prediction | planned |
