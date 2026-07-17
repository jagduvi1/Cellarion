# MCP tool versioning & deprecation policy

The MCP surface is a **contract**: external agents get wired against tool
names, input schemas, and response shapes, and unlike our own frontend they
don't redeploy when we do. This document is the policy that keeps that
contract trustworthy. It covers tools, resources, and prompts alike —
"tool" below means all three.

## Versioning model

- **The server version is the app version.** `initialize` announces
  `cellarion vX.Y.Z` (from `backend/package.json`); there is no separate
  MCP version to track. `get_source_info` returns the same version.
- **Within a major line, changes are additive-only.** Allowed at any time:
  - a new tool / resource / prompt;
  - a new **optional** input field (with a default that preserves old behavior);
  - a new field in the response `data`;
  - description/title copy improvements (they steer models, not parsers).
- **Never** without the deprecation process below:
  - removing or renaming a tool or an input/response field;
  - changing a field's type or meaning;
  - narrowing accepted input (tightening a max, removing an enum value);
  - **raising the required scope** of an existing tool (a token minted
    yesterday must keep working); *lowering* scope is a security decision,
    not a compat one — treat it as a new tool.
- **The error taxonomy is API**: `invalid_input | not_found |
  forbidden_scope | budget_exhausted | conflict | rate_limited` (see
  `mcp/toolUtil.js`). New codes may be added; existing codes never change
  meaning. Agents key retry behavior off these.
- The response envelope — `{ summary, data, warnings?, page? }` on success,
  `{ error: { code, message } }` on failure, JSON in one text part — is
  frozen shape-wise the same way.

## Breaking changes: the parallel-tool rule

When a tool genuinely needs an incompatible contract, ship it as a **new
tool** (`search_bottles_v2`, or better: a new honest name) and deprecate the
old one. Two tools coexist through the sunset window. Never break the old
name in place.

## Deprecation process

1. **Mark it** — pass `deprecated: 'use <replacement> instead; removed
   after v<X.Y>'` to `registerTool` / `registerResource` / `registerPrompt`
   (`mcp/registry.js`). The registry prefixes the description with
   `[DEPRECATED — …]`, which is the text driving model tool-selection — so
   calling models steer to the replacement **without any client-side
   support**. The tool keeps working unchanged.
2. **Sunset window** — the marker stays for **at least 2 minor releases or
   90 days, whichever is longer**. The message must name the replacement
   and the removal release.
3. **Announce** — the release notes of the marking release and of the
   removal release both list it (What's New + GitHub release body).
4. **Remove** — delete the tool in the announced release, remove its
   `instructions.js` mention (the drift guard in `resources.test.js` forces
   this), and drop the marker. The `registry.test.js` drift guard
   (`no live tool ships deprecated right now`) fails the build until the
   sunset actually completes — a marker can't silently live forever.

## Emergency lever

The admin **kill switches** (Admin → AI Connector; `rateLimits.mcp` config)
shut the whole surface or just the anonymous endpoint with an honest 503 —
that's for incidents, never for retiring a tool.

## What guards the contract in CI

- `resources.test.js` — every tool/resource/prompt name must be mentioned
  in the server `instructions` (models can't select what they can't see).
- `registry.test.js` — deprecation marker format + the no-forgotten-markers
  drift guard.
- `mcp/eval/` golden cases — pin that real models still pick the right tool
  for the canonical intents; a rename or description regression shows up as
  a selection failure before any user sees it.
