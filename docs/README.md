# Cellarion — Architecture Docs

Deep-dive writeups of features that have non-obvious internals. Aimed at a developer who's reading the code and wants the *why* and the *shape* before drilling into specific files.

For top-level project orientation (setup, stack, ports, demo data, GDPR), see [`../CLAUDE.md`](../CLAUDE.md).

## Docs

- **[Cellar Chat Architecture](./cellar-chat-architecture.md)** — RAG pipeline (query expansion → embedding → Qdrant → cellar filter → enrichment → streaming Claude). Covers wine-context round-tripping, SSE event shapes, rate limiting, and session persistence.
- **[Admin Global Stats](./admin-global-stats-architecture.md)** — How `/admin/stats` builds 14 sections from ~20 Mongo aggregations. Covers the `excludeAdmins` filter chain, 5-minute in-memory caching, the maturity `$switch` pipeline, the `$bucket` empty-row trap, and privacy guards (redaction on small platforms, inline NoSQL-injection sanitisation).
- **[Data Quality Guards](./data-quality-guards.md)** — The two boundary defences against bad data entry: `parseLocaleNumber` (locale-aware replacement for `parseFloat`, fixes EU/Swedish CSV imports) and the four price-sanity rules (absolute cap, user-median outlier, market-median outlier, possibly-cents heuristic).

## Conventions

Every doc here follows the same shape:

- H1 with em-dash subtitle
- ASCII flow diagram where the pipeline has more than ~3 stages
- Tables for mappings (rule → action, code → file role, etc.)
- "Key Files" footer mapping the doc's concepts back to source paths

If you're adding a new doc, that pattern keeps the directory legible.
