# Cellar Chat — How It Works

Cellar Chat is a conversational AI sommelier that knows the user's cellar. It uses a RAG (Retrieval-Augmented Generation) pipeline to recommend wines the user actually owns, with multi-turn conversation support and real-time streaming responses.

---

## High-Level Flow

```
User message
    │
    ▼
┌──────────────────────┐
│   Query Expansion    │  Claude Haiku rewrites the message into wine
│   (+ intent class.)  │  terminology. For follow-ups, also classifies:
│                      │  "does this need a NEW search or REUSE context?"
└──────────┬───────────┘
           │
     ┌─────┴─────┐
     │ SEARCH:yes │  SEARCH:no ──► skip to step 5
     └─────┬─────┘               (reuse previousWines)
           │
           ▼
┌──────────────────────┐
│   Embed with Voyage  │  Convert expanded query to vector
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Qdrant Search      │  Top-K similar wine vectors
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Filter to User's   │  Cross-reference with user's active bottles
│   Cellar             │  in MongoDB — only keep wines they own
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Enrich             │  Batch-fetch in parallel:
│                      │  · Maturity status (WineVintageProfile)
│                      │  · Bottle count per wine/vintage
│                      │  · Market prices (WineVintagePrice)
│                      │  · User ratings + purchase prices
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Claude (streaming) │  System prompt + conversation history
│                      │  + enriched wine list → streamed response
└──────────────────────┘
```

---

## Query Expansion & Intent Classification

The query expansion step serves two purposes, handled in a single Claude Haiku call (zero extra API calls for classification):

### First message (no history)

The user's message is rewritten into wine-search terminology. For example:

> **User:** "I'm making lamb with rosemary tonight"
> **Expanded:** "full-bodied red wine, Cabernet Sauvignon, Syrah, Grenache, Southern Rhône, Bordeaux, structured tannins, herbal notes, food pairing with roasted lamb, rosemary"

This dramatically improves Qdrant embedding matches for vague or food-focused questions compared to embedding the raw user message.

### Follow-up messages (with history)

The same Haiku call also classifies whether a new vector search is needed:

| Follow-up type | Classification | Action |
|---|---|---|
| "Make it cheaper" | `SEARCH: no` | Reuse existing wine context |
| "Tell me more about the second one" | `SEARCH: no` | Reuse existing wine context |
| "What about a white wine instead?" | `SEARCH: yes` | New embedding + Qdrant search |
| "Actually, we're having fish" | `SEARCH: yes` | New embedding + Qdrant search |

**Why this matters:** Embedding + Qdrant search is the most expensive part of the pipeline. For refinement follow-ups ("cheaper", "for more people", "tell me more"), we skip it entirely and let Claude work with the same wine list — saving cost and latency.

### Edge cases

- **"Hi, I like wine!"** → `SEARCH: yes`, but no wine-related terms to match → Qdrant returns low-relevance results → Claude responds conversationally without inventing wines
- **No previous context but classified as REUSE** → Forced to `SEARCH: yes` (safety fallback)
- **Expansion fails** (API error) → Falls back to original message, always searches

---

## Wine Context Round-Tripping

The backend returns an opaque `wineContext` string — the full formatted wine list with all enrichment data. The frontend:

1. Caches `wineContext` in React state (and sessionStorage)
2. Sends it back as `previousWines` on the next request
3. When `SEARCH: no`, the backend skips embedding/Qdrant entirely and uses `previousWines` as the wine section in the Claude prompt

This means Claude always has the full wine context even on follow-ups, without any extra database or API calls.

---

## Streaming (SSE)

The response is streamed via Server-Sent Events for real-time text display.

### Event types

| Event | Payload | When |
|---|---|---|
| `usage` | `{ used, limit }` | Immediately (before any processing) |
| `meta` | `{ wines, expandedQuery, searchPerformed, wineContext }` | After search/enrichment, before Claude streams |
| `delta` | `{ text }` | Each token from Claude |
| `done` | `{ usage: { inputTokens, outputTokens } }` | Stream complete |
| `error` | `{ error }` | On failure |

### Frontend handling

- `fetch()` + `response.body.getReader()` reads the SSE stream
- `meta` event populates wine cards and metadata immediately
- `delta` events are batched with `requestAnimationFrame` to prevent excessive React re-renders
- A final text sync after the stream ensures nothing is lost if rAF hasn't fired

### Backend implementation

- `_prepareChatContext()` — shared pipeline for both `chat()` (non-streaming) and `chatStream()`
- `chatStream()` uses Anthropic SDK's `client.messages.stream()` which emits `text` and `finalMessage` events
- If the client disconnects mid-stream, the Claude stream is aborted to save tokens
- Fallback model is attempted only if the primary fails before any tokens are emitted

---

## Enriched Wine Context

Each wine in the prompt includes:

| Field | Source | Example |
|---|---|---|
| Name, vintage, producer | WineDefinition + Bottle | "Château Margaux 2015 — Château Margaux" |
| Region, grapes, style | WineDefinition | "Region: Margaux · Grapes: Cabernet Sauvignon, Merlot" |
| Maturity status | WineVintageProfile | "At peak — drink now through 2030" |
| Bottle count | Bottle aggregation | "Bottles: 3" |
| Purchase price | Bottle | "Your price: EUR 180" |
| Market value | WineVintagePrice | "Market value: USD 450" |
| User rating | Bottle | "Your rating: 4.5/5" |
| User notes | Bottle | "Notes: \"Incredible nose, decant 2h\"" |
| Relevance score | Qdrant | "(relevance: 87%)" |

This enables Claude to make nuanced recommendations: prioritizing peak-maturity wines, suggesting everyday bottles vs. special occasions based on price, and referencing the user's own tasting notes.

---

## Rate Limiting

- Daily per-user limits configured by plan tier (default: free=4, basic=20, premium=50)
- Pre-debit: count is incremented before processing to block concurrent requests
- On failure: count is decremented (refunded)
- Token usage (input + output) is tracked per day for monitoring

---

## Session Persistence

Conversations persist across page refreshes via `sessionStorage`:

- `cellarChat.messages` — full message array (excluding thinking indicators)
- `cellarChat.wineContext` — the opaque wine context string

Cleared on tab close (sessionStorage behavior) or when the user clicks "New chat".

---

## Conversation History

- Frontend sends the full conversation as a `history` array with each request
- Backend trims to the last N turns (configurable via `chatMaxHistoryTurns`, default 10)
- Each entry is sanitized: only `user`/`assistant` roles, content capped at 2000 chars
- History is prepended to Claude's messages array, with the current question + wine list as the final user message

---

## Key Files

| File | Role |
|---|---|
| `backend/src/services/aiChat.js` | Core RAG pipeline, streaming, expansion |
| `backend/src/routes/chat.js` | REST endpoints, validation, rate limiting |
| `backend/src/config/aiConfig.js` | System prompt, model config, feature flags |
| `backend/src/utils/maturityUtils.js` | Drink window classification + labels |
| `backend/src/services/embedding.js` | Voyage AI embedding calls |
| `backend/src/services/vectorStore.js` | Qdrant vector search |
| `frontend/src/pages/CellarChat.js` | Chat UI, SSE client, session persistence |
| `frontend/src/pages/CellarChat.css` | Chat styles, markdown rendering |
