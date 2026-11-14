# Wine Identity Fields — name, appellation, classification and label sweetness

Four fields on a registry wine describe what the bottle *is*, and they are easy to mix up: a tier word or a sweetness word can sit in any of them, depending on who wrote the label. This page states which field each piece of label text belongs in, gives worked examples, and points to where each rule is enforced.

It is written for contributors filing corrections, sommeliers reviewing them, and anyone writing a prompt or an MCP schema that produces these fields.

The rules come from discussion #1696 and are tracked in #1700. The regulatory-mark rule landed in #1701; the classification taxonomy in #1740, #1741 and #1751; the production-method rule in #1815. Label sweetness comes from discussion #1754 and landed in #1790.

---

## The short version

| Field | Holds | Never holds |
|---|---|---|
| **name** | What tells this bottle apart within the producer's range | The producer, the vintage, a classification line on its own |
| **appellation** | The appellation as the register names it | The regulatory mark (DOCG, AOC, DO …), a production method |
| **classification** | One or more tiers from the registry's classification list, granted on top of the appellation | A regulatory mark (DOCG, DOC, AOC …), a word the list lacks |
| **labelSweetness** | The one sweetness or dosage term the label states, from the registry's term list | A term worked out from the Prädikat, a taste estimate, a word the label does not print |

The one-line test: **DOCG, DOC, AOC and their peers follow from the appellation, so they belong in no field.** Everything else has one home, and a tier word printed as part of the wine's name has two. A sweetness word such as "trocken" or "Brut Nature" leaves the name for `labelSweetness`, unless it is part of the cuvée's own name.

---

## name

The name is what distinguishes the bottle within the producer's range, without the producer and without the vintage.

- **Producer out.** "Cloudy Bay Sauvignon Blanc" is name "Sauvignon Blanc", producer "Cloudy Bay".
- **Estate wines take the estate's name.** A château's grand vin with no separate cuvée name has name equal to producer: name "Château Margaux", producer "Château Margaux". This is correct, not a duplicate.
- **A classification line on its own is never a name.** "Grand Cru Classé en 1855" printed under the estate goes in `classification`; the name falls back to the estate.
- **Tier words printed as part of the name stay in the name.** "Riesling Spätlese", "Rioja Gran Reserva": the word stays, *and* `classification` is set too (see [Tier words in two fields](#tier-words-in-two-fields)).
- **A tier word may stand alone as the name** when the producer's range uses it as the wine's name: the Rioja convention (Crianza, Reserva, Gran Reserva) and Champagne co-op cuvées. Premier Cru and Grand Cru in Burgundy and its peers are appellation material instead.
- **Production method is not name material**, unless the label prints it as part of the cuvée's own name.
- **Sweetness words leave the name** for `labelSweetness` (see [labelSweetness](#labelsweetness)), unless they are part of the cuvée's own name.

## appellation

The appellation is the appellation **as the register names it, without the regulatory mark**.

- **The mark goes.** "Barolo DOCG" → "Barolo"; "DOCa Rioja" → "Rioja"; "Chianti Denominazione di Origine Controllata" → "Chianti". This is stripped automatically on write, as a prefix, a suffix or a spelled-out phrase.
- **Tier words that are part of the legal name stay.** "Chablis Premier Cru", "Saint-Émilion Grand Cru", "Alsace Grand Cru", "Gevrey-Chambertin Premier Cru" are the appellations themselves. The registry holds several hundred of these and they are correct. Do not move Premier Cru or Grand Cru out of the appellation in these regions. A Côte d'Or grand-cru vineyard is an appellation in its own right and is stored the same way, with "Grand Cru" as the label prints it ("Corton Grand Cru", "Musigny Grand Cru"); the bare register name ("Corton") is an accepted spelling that resolves to it.
- **Champagne is the exception.** There, Premier Cru and Grand Cru rate the village, not the appellation: the appellation stays "Champagne" and the cru goes in `classification`.
- **Some marks are the official form.** "Kamptal DAC", "VQA Ontario" and "Wine of Origin Western Cape" keep their mark, because that is how the register names them. Only the trailing forms "Ontario VQA" and "Swartland WO" are stripped.
- **A bare Prädikat is not an appellation.** "Spätlese" alone in the appellation field is moved to `classification` automatically.
- **Production method is not an appellation.** "Metodo Classico", "Méthode Traditionnelle", "Méthode Cap Classique" do not go here. The appellation is the origin the label names ("Western Cape", "Franciacorta"), or none when the label names no origin. An appellation that is nothing but a method is stored as none, and the keys read it as none. The method is not stripped off the end of a longer value, because real appellations end that way: "Oltrepò Pavese Metodo Classico" is a DOCG and "Blanquette méthode ancestrale" an AOC. A bare "Classico" is not a method, so "Chianti Classico" is untouched.

## classification

The classification is a quality tier granted on top of the appellation, **named as the registry's classification list has it**. The list is a curated taxonomy (Admin → Taxonomy → Classifications), seeded from `backend/src/data/classifications.json`. Each tier has a kind, a system and, when the word is law there, a country:

| Kind | Examples |
|---|---|
| `vineyard_rank` | Grand Cru Classé, Premier Grand Cru Classé, Cru Bourgeois, Premier Cru and Grand Cru in Champagne, VDP Grosse Lage, Grosses Gewächs |
| `ripeness` | Kabinett, Spätlese, Auslese, Smaragd, Vendange Tardive, 5 Puttonyos |
| `ageing` | Riserva, Crianza, Reserva, Gran Reserva, Vintage Port, 20 Years Old |
| `other` | A producer's own designation: Reserve, Single Vineyard, Estate, Old Vines |

- **Only tiers on the list.** Each tier carries its accepted spellings, so "1er Cru", "Grand Cru Classé en 1855" and "Großes Gewächs" are stored as "Premier Cru", "Grand Cru Classé" and "Grosses Gewächs". A word the list lacks is refused, with the known tiers in the message, at the admin wine form, on a curator's fix and when a correction is filed or approved. When a new wine comes from a member, a scan, an import or the registry bridge, it is dropped if another tier resolved and otherwise kept as text for review, so nothing is lost. A missing tier is added to the list, not typed in free text.
- **Several tiers are allowed.** They are stored in kind order and shown comma-separated: "VDP Grosse Lage, Spätlese".
- **The wine's country settles a shared word.** "Erste Lage" is VDP in Germany and ÖTW in Austria; "Ortswein" is the DAC pyramid in Austria and VDP in Germany.
- **A regulatory mark is never a classification.** "Riserva DOCG" is stored as "Riserva", and a value that is only a mark ("DOCG", "D.O.C.G.", "Appellation d'Origine Protégée") is stored as no classification at all. This is stripped automatically on every write, with the same rule the appellation uses. Ride-along words such as "trocken", "Qualitätswein" or "en 1855" are dropped too; a sweetness word belongs in `labelSweetness`.
- **A producer's own word goes under `other`.** "Réserve", "Cuvée Réservée" and "Vieilles Vignes" have no legal meaning in most countries, but the list holds them as Reserve and Old Vines (kind `other`), so they can be filtered without being mistaken for a legal tier.
- **Leave it empty** when the label states no tier. Do not infer one: a Médoc classed growth whose label says only "Grand Cru Classé en 1855" is "Grand Cru Classé", not the growth a reference book gives it.

### Tier words in two fields

When the label prints a tier as part of the wine's name, the word goes in **both** `name` and `classification`.

- `name` needs it because the duplicate guard tells an estate's Kabinett from its Spätlese by the words in the name (see `utils/styleTerms.js`). Without it, two different wines can be filed as one.
- `classification` needs it so the tier is consistent and filterable across the registry.

The taxonomy migration fills `classification` from the name this way, but only where the word is a legal or customary tier in the wine's country (`detectFromName` in `services/classificationOps.js`). In France that means Bordeaux's classed growths, the Champagne village ranking and Alsace's late-harvest designations. Premier Cru and Grand Cru in Burgundy, Alsace and Saint-Émilion stay in the appellation.

## labelSweetness

The sweetness or dosage term **the label states**, named as the registry's term list has it. The list is a curated table (Admin → Taxonomy → Sweetness terms, and `list_sweetness_terms` over MCP), seeded from `backend/src/data/sweetness-terms.json` with the terms of EU 2019/33 Annex III per language. Each term has a scale and a band on that scale:

| Scale | Bands | Examples |
|---|---|---|
| `still` | dry, off-dry, medium-sweet, sweet | trocken, halbtrocken, feinherb, amabile |
| `sparkling` | brut-nature, extra-brut, brut, extra-dry, sec, demi-sec, doux | Brut Nature, Extra Brut, Brut, Extra Dry |

- **One term, as printed.** A listed spelling is accepted and stored as the term. The scale follows from the wine's type: "trocken" on a Sekt is the sec band, on a still wine the dry band. Fortified wines carry none.
- **The word leaves the name**, unless it is part of the cuvée's own name ("Brut Premier"). A curator marks that case, and the word then stays in the name.
- **Never worked out.** Not from a Kabinett or Spätlese tier, and not from the tasting profile's dry/off-dry/sweet estimate. Empty when the label states none.
- **The display name puts it back.** Reads carry `labelSweetness` and a display name that reads as the label does, so "Riesling Spätlese" with "trocken" shows as "Riesling Spätlese trocken".

| Label | name | classification | labelSweetness |
|---|---|---|---|
| Riesling Spätlese trocken, Mosel | Riesling Spätlese | Spätlese | trocken |
| Riesling Spätlese, Mosel | Riesling Spätlese | Spätlese | *(empty)* |

---

## How a classification is written

```
 the string a form, scan, import or API client sent         rows a picker chose
 ("Riserva DOCG", "Spätlese, VDP.Grosse Lage")               (ids or names)
              │                                                     │
              ▼                                                     │
 normalizeClassification ── a mark only (DOCG) ──► no classification │
              │                                                     │
              ▼                                                     │
 split on , ; / ( ) and the like                                     │
              │                                                     │
              ▼                                                     ▼
 resolve each part against the taxonomy: name or spelling, ride-along words
 dropped, the wine's country first when two systems share a word
              │
              ├── a part no tier answers ── strict (admin form, curator, correction) ──► refused, known tiers listed
              │                          └─ lenient (new wine, scan, import, bridge) ──► dropped, or kept as text
              ▼
 wine.classifications = the rows, in kind order
 wine.classification  = their names, comma-separated (what older readers show)
```

`assignClassification` in `backend/src/services/classificationOps.js` is the only write path. With no taxonomy loaded (no database connection, no seed yet) every path keeps the cleaned string as before.

---

## Worked examples

| Label | name | appellation | classification |
|---|---|---|---|
| Château Lynch-Bages, Pauillac, Grand Cru Classé en 1855 | Château Lynch-Bages | Pauillac | Grand Cru Classé |
| Château Figeac, Saint-Émilion Grand Cru, Premier Grand Cru Classé | Château Figeac | Saint-Émilion Grand Cru | Premier Grand Cru Classé |
| Giacomo Borgogno, Barolo Riserva DOCG | Barolo Riserva | Barolo | Riserva |
| Alpha Zeta, Amarone della Valpolicella DOCG | Amarone della Valpolicella | Amarone della Valpolicella | *(empty)* |
| Joseph Drouhin, Chablis Premier Cru "Vaillons" | Vaillons | Chablis Premier Cru | *(empty)* |
| Domaine Faiveley, Corton Grand Cru "Clos des Cortons" | Clos des Cortons | Corton Grand Cru | *(empty)* |
| Pierre Gimonnet, Cuis 1er Cru Blanc de Blancs, Champagne | Cuis 1er Cru Blanc de Blancs | Champagne | Premier Cru |
| Dr. Loosen, Wehlener Sonnenuhr Riesling Spätlese | Wehlener Sonnenuhr Riesling Spätlese | Mosel | Spätlese |
| Hugel, Riesling Vendange Tardive, Alsace | Riesling Vendange Tardive | Alsace | Vendange Tardive |
| La Rioja Alta, Gran Reserva 904, DOCa Rioja | Gran Reserva 904 | Rioja | Gran Reserva |
| Pongrácz, Blanc de Blancs, Méthode Cap Classique, Western Cape | Blanc de Blancs | Western Cape | *(empty)* |

Notes on the examples:

- **Lynch-Bages:** "en 1855" is a ride-along word, and "Grand Cru Classé en 1855" is one of the tier's spellings, so it is stored as "Grand Cru Classé".
- **Figeac:** "Grand Cru" is part of the appellation; "Premier Grand Cru Classé" is the tier on top of it. They are not the same thing.
- **Gimonnet:** in Champagne the cru is a classification, not part of the appellation. The tier is printed as part of the name, so it is in both, and "1er Cru" is stored as "Premier Cru".
- **Corton:** the vineyard is an appellation in its own right. It is stored with "Grand Cru" as the label prints it, "Corton Grand Cru", like "Chablis Grand Cru"; the bare register name "Corton" is an accepted spelling that resolves to it. The grand-cru status is in the appellation, so classification stays empty.
- **Hugel:** in Alsace the late-harvest designation is a classification, while "Alsace Grand Cru" would stay in the appellation.
- **Pongrácz:** the method is neither name nor appellation, so the appellation is the origin, "Western Cape".
- **Amarone:** the DOCG follows from the appellation, so classification stays empty. This is the case that started this page.

---

## Where each rule is enforced

| Rule | Where | Status |
|---|---|---|
| Strip DOCG, AOC, DO … from the appellation | `normalizeAppellation` in `backend/src/utils/normalize.js` | In place |
| Strip regulatory marks from the classification; empty when only a mark is left | `normalizeClassification` in `backend/src/utils/normalize.js`, called by the write rule | #1701 |
| Only tiers on the list, in kind order, the wine's country first; strict for admins and curators, lenient for members, scans and imports | `assignClassification` in `backend/src/services/classificationOps.js`, called from the mint, the admin wine routes, proposals, pending wines, drafts, wine requests and the registry bridge | #1741 |
| The list itself: tiers, kinds, systems, countries and spellings | `backend/src/models/Classification.js`, seeded from `backend/src/data/classifications.json`; Admin → Taxonomy → Classifications | #1740, #1741 |
| Members choose tiers from the list when suggesting a fix | `WineRecordSection.js` and `useClassifications.js` in the frontend, over `GET /api/taxonomy/classifications` | #1751 |
| Move existing free-text classifications onto the list, and fill tiers stated in the name (dry run by default) | `backend/src/scripts/migrate-classification-taxonomy.js`, `detectFromName` in `classificationOps.js` | #1740 |
| Clean the existing classifications of regulatory marks (dry run by default) | `backend/src/scripts/normalize-classification-tiers.js` | #1701 |
| Move a bare Prädikat from appellation to classification | `splitPradikatFromAppellation` in `backend/src/utils/styleTerms.js` | In place |
| Keep a Kabinett and a Spätlese from one estate apart | `conflictingStyleTerms` in `backend/src/utils/styleTerms.js` | In place |
| A Bordeaux classification line is not a name | `unpolluteEstateName` / `CLASSIFICATION_ONLY_NAME_RX` in `backend/src/services/findOrCreateWine.js` | In place |
| Prompts ask for a tier on top of the appellation, never the mark | `backend/src/config/aiConfig.js` (label scan, back label, import lookup, text search, valuation) | #1701 |
| One field description for `appellation`, `region` and `classification` in every MCP tool that takes them, pointing at `list_classifications` | `FIELD_DESCRIPTIONS` in `backend/src/mcp/toolUtil.js`, `backend/src/mcp/tools/classifications.js` | #1701, #1741 |
| Production method out of the appellation: the prompts leave it out, a value that is only a method is stored and keyed as none | `backend/src/config/aiConfig.js`, `isProductionMethodOnly` in `backend/src/utils/normalize.js`, the `WineDefinition` pre-validate hook, `backend/src/scripts/clear-method-appellations.js` for existing rows | #1815 |
| A Champagne cru typed as the appellation ("Champagne Grand Cru", "Champagne Premier Cru", "Champagne 1er Cru") is stored and keyed as "Champagne", and the cru joins the wine's tiers | `champagneCruOf` in `backend/src/utils/champagneCru.js`, read by the key builders in `utils/normalize.js` and `utils/wineIdentity.js`; `moveChampagneCru` in `backend/src/services/classificationOps.js`, run by the `WineDefinition` pre-validate hook; the mint and the registry import split the value themselves | PR_NUMBER |
| Move the existing Champagne rows to "Champagne" and take the two cru entries off the curated appellation list; give each Côte d'Or grand-cru vineyard its one curated entry and spelling (dry run by default) | `backend/src/scripts/align-cru-appellations.js` | PR_NUMBER |
| The sweetness term list, the field, and the term in the keys and the style guard | `backend/src/models/SweetnessTerm.js`, seeded from `backend/src/data/sweetness-terms.json`; `labelSweetness` on `WineDefinition`; Admin → Taxonomy → Sweetness terms; `list_sweetness_terms` | #1790 |
| Move a sweetness word out of the name into `labelSweetness` | — | Open: comes with the next part of #1754 |

---

## Key Files

| File | Role |
|---|---|
| `backend/src/utils/normalize.js` | `normalizeAppellation` and `normalizeClassification`: tier tokens, dotted forms and spelled-out phrases |
| `backend/src/services/classificationOps.js` | The write rule (`assignClassification`), resolving against the taxonomy, the derived string, `detectFromName` |
| `backend/src/models/Classification.js` | A tier: name, kind, system, country, spellings, review state |
| `backend/src/data/classifications.json` | The seed list of tiers |
| `backend/src/models/SweetnessTerm.js` | A sweetness term: word, scale, band, country, synonyms |
| `backend/src/data/sweetness-terms.json` | The seed list of sweetness terms |
| `backend/src/services/sweetnessOps.js` | The term list in memory, word to term, the display name and the read shapes |
| `backend/src/scripts/clear-method-appellations.js` | Backfill that clears appellations that are only a production method |
| `backend/src/utils/styleTerms.js` | Prädikat and sweetness vocabulary, the Prädikat split, the style-term duplicate guard |
| `backend/src/services/findOrCreateWine.js` | The mint and lookup pipeline, including the estate-name pollution guard |
| `backend/src/scripts/migrate-classification-taxonomy.js` | Backfill from free text onto the taxonomy, with an NDJSON backup on `--apply` |
| `backend/src/scripts/fix-classification-polluted-names.js` | Backfill sharing the estate-name guard's pattern |
| `backend/src/scripts/normalize-classification-tiers.js` | Backfill that strips regulatory marks from existing classifications |
| `backend/src/config/aiConfig.js` | The prompts that produce these fields (label scan, back label, import lookup, text search, valuation) |
| `backend/src/mcp/toolUtil.js` | `FIELD_DESCRIPTIONS`, the shared MCP text for these fields |
| `backend/src/mcp/tools/classifications.js` | `list_classifications`, the tiers an AI client may write |
| `backend/src/mcp/tools/sweetnessTerms.js` | `list_sweetness_terms`, the sweetness terms an AI client may name |
| `backend/src/mcp/tools/write.js` | `NEW_WINE_SHAPE`, `resolve_wine`, `add_bottle`, `bulk_add` |
| `backend/src/mcp/tools/corrections.js` | `suggest_wine_correction` |
| `frontend/src/components/bottle/WineRecordSection.js` | The member's suggest-a-fix form, with the tier picker |
