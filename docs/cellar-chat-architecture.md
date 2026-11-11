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
│   Vector Search      │  Top-K similar wine vectors (your own wines)
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
│   Claude             │  System prompt + conversation history
│                      │  + enriched wine list → the answer
└──────────────────────┘
```

---

## Query Expansion & Intent Classification

The query expansion step serves two purposes, handled in a single Claude Haiku call (zero extra API calls for classification):

### First message (no history)

The user's message is rewritten into wine-search terminology. For example:

> **User:** "I'm making lamb with rosemary tonight"
> **Expanded:** "full-bodied red wine, Cabernet Sauvignon, Syrah, Grenache, Southern Rhône, Bordeaux, structured tannins, herbal notes, food pairing with roasted lamb, rosemary"

This dramatically improves embedding matches for vague or food-focused questions compared to embedding the raw user message.

### Follow-up messages (with history)

The same Haiku call also classifies whether a new vector search is needed:

| Follow-up type | Classification | Action |
|---|---|---|
| "Make it cheaper" | `SEARCH: no` | Reuse existing wine context |
| "Tell me more about the second one" | `SEARCH: no` | Reuse existing wine context |
| "What about a white wine instead?" | `SEARCH: yes` | New embedding + vector search |
| "Actually, we're having fish" | `SEARCH: yes` | New embedding + vector search |

**Why this matters:** Embedding + vector search is the most expensive part of the pipeline. For refinement follow-ups ("cheaper", "for more people", "tell me more"), we skip it entirely and let Claude work with the same wine list — saving cost and latency.

### Edge cases

- **"Hi, I like wine!"** → `SEARCH: yes`, but no wine-related terms to match → the vector search returns low-relevance results → Claude responds conversationally without inventing wines
- **No previous context but classified as REUSE** → Forced to `SEARCH: yes` (safety fallback)
- **Expansion fails** (API error) → Falls back to original message, always searches

---

## Wine Context Round-Tripping

The backend returns an opaque `wineContext` string — the full formatted wine list with all enrichment data. The frontend:

1. Caches `wineContext` in React state (and sessionStorage)
2. Sends it back as `previousWines` on the next request
3. When `SEARCH: no`, the backend skips embedding and vector search entirely and uses `previousWines` as the wine section in the Claude prompt

This means Claude always has the full wine context even on follow-ups, without any extra database or API calls.

---

## The answer

`POST /api/chat` answers once, with JSON, when the model has finished. Nothing is streamed.

| Field | Meaning |
|---|---|
| `answer` | The recommendation, as Markdown |
| `wines` | The cellar wines the model was given: the wine cards under the answer |
| `expandedQuery` | The search query the question was rewritten to, or `null` |
| `searchPerformed` | Whether this turn searched the cellar again |
| `wineContext` | The enriched wine list, to send back as `previousWines` on a follow-up |
| `usage` | `{ inputTokens, outputTokens }` |
| `used`, `limit`, `period` | The member's chat allowance after this question |

### Frontend handling

- The page shows a "thinking" bubble, posts the question with `apiFetch`, and replaces the bubble with the answer when the JSON arrives.
- A 429 with `used` and `limit` in its body is the chat allowance: the composer locks. A 429 without them is the per-minute limiter: only the error shows.

### Backend implementation

- `_prepareChatContext()` is the pipeline: expand the query, search, filter, enrich.
- `chat()` calls the model once. If the primary model fails with a retryable error (429, 5xx, overloaded), the fallback model is tried once.
- `services/aiProvider.js` still offers a streaming call with the same events for either provider; no route uses it.

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
| Relevance score | Vector search | "(relevance: 87%)" |

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
| `backend/src/services/aiChat.js` | Core RAG pipeline, expansion |
| `backend/src/routes/chat.js` | REST endpoints, validation, rate limiting |
| `backend/src/config/aiConfig.js` | System prompt, model config, feature flags |
| `backend/src/utils/maturityUtils.js` | Drink window classification + labels |
| `backend/src/services/embedding.js` | Voyage AI embedding calls |
| `backend/src/services/vectorStore.js` | Vector search: vectors stored on WineEmbedding rows in MongoDB, compared in memory |
| `frontend/src/pages/CellarChat.js` | Chat UI, session persistence |
| `frontend/src/pages/CellarChat.css` | Chat styles, markdown rendering |
