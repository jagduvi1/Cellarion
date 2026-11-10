// Correction-proposal decisions: what approving or rejecting ONE proposal does.
//
// A proposal (models/WineCorrectionProposal) asks for a change to a registry
// wine: corrected identity fields, a merge into another wine, or a not-wine
// quarantine. approveProposal claims the pending row and applies it by kind;
// rejectProposal records the reviewer's reason. Both answer { status, body }
// instead of writing a response, so every caller runs the same machinery:
//   - the admin review routes, single and bulk (routes/admin/wineProposals.js);
//   - a proposal that applies without review, as decided by
//     services/proposalDirectApply: the sommelier's propose_wine_correction
//     (mcp/tools/somm/corrections.js), a member's not-wine flag
//     (services/nonWineOps) and a member's field correction on a server that
//     does not review (services/trustedContributions).
// Those three reach approveProposal through routes/admin/wineProposals.js,
// which re-exports it.
//
// This module stays free of Express: `req` is passed for the decider's id
// (req.user.id) and for audit attribution.

const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineEmbedding = require('../models/WineEmbedding');
const Country = require('../models/Country');
const { logAudit } = require('./audit');
const { submitUrls } = require('./indexNow');
const searchService = require('./search');
const { reembedActiveVintages } = require('./embeddingJob');
const { profileInputsSnapshot, reenrichAfterRecordEdit } = require('./enrichmentJob');
const { findOrCreateRegion } = require('./findOrCreateWine');
// Same helpers the somm's own set_wine_profile writes through, so an approved
// proposal and a direct curator edit resolve varieties identically.
const { WINE_TYPES, resolveGrapeIdsStrict } = require('./wineProfileOps');
const { WINE_COLOURS, isStyleType } = require('../utils/wineColour');
const { resolveCanonicalAppellation } = require('./appellationResolve');
const { otherProducerSpellings, planProducerRename, displaySpelling } = require('./producerSpelling');
const { termNameForWine } = require('./sweetnessOps');
const { performWineMerge } = require('./wineMergeOps');
const { generateWineKey, normalizeAppellation, normalizeString, resolveCountryName } = require('../utils/normalize');
const { assignClassification } = require('./classificationOps');
const { stripHtml } = require('../utils/sanitize');
// Telling the submitter lives in a service: merges and deletes close pending
// corrections too (services/wineMergeOps, routes/admin/wines.js) and owe the
// same notification.
const { notifyProposer } = require('./wineCorrectionNotify');
const { awardProposal, settleNonWineProposals } = require('./suggestionCred');

const REJECT_REASON_MIN = 5;
// What the proposal row can store (models/WineCorrectionProposal rejectReason)
// and what the review form lets an admin type: a real explanation needs room.
const REJECT_REASON_MAX = 2000;

// The Country the wine carries once the proposal applies: the proposed one
// when it resolves (approving refuses one that does not), else its own. The
// producer-spelling bucket is fenced by country.
async function countryAfter(pf, wine) {
  if (pf.country) {
    const doc = await Country.findOne({ normalizedName: normalizeString(resolveCountryName(pf.country)) });
    if (doc) return doc._id;
  }
  return wine.country?._id || wine.country || null;
}

// The admin's answer to a producer-spelling split (see approveProposal).
// Absent = no answer yet; anything else malformed is a 400. A rename names
// the spelling(s) to fold: the bucket over-folds (Domaine de Bellevue and
// Château Bellevue share one), so "all of them" could re-attribute another
// estate's wines (review 2026-09-28).
function parseSpellingChoice(body) {
  const kind = body?.producerSpelling;
  if (kind === undefined || kind === null) return { choice: null };
  if (kind === 'proposed') return { choice: { kind } };
  if (kind === 'existing') {
    const spelling = typeof body.existingSpelling === 'string' ? displaySpelling(body.existingSpelling) : '';
    if (!spelling) return { error: 'existingSpelling is required with producerSpelling "existing"' };
    return { choice: { kind, spelling } };
  }
  if (kind === 'renameAll') {
    const raw = body.renameSpellings;
    const spellings = Array.isArray(raw) && raw.length <= 20 && raw.every((s) => typeof s === 'string')
      ? [...new Set(raw.map(displaySpelling).filter(Boolean))]
      : [];
    if (!spellings.length) return { error: 'renameSpellings (the spellings to rename, 1–20) is required with producerSpelling "renameAll"' };
    return { choice: { kind, spellings } };
  }
  return { error: 'producerSpelling must be "existing", "renameAll" or "proposed"' };
}

const spellingList = (others) => others
  .map((o) => `"${o.spelling}" (${o.count} wine${o.count === 1 ? '' : 's'})`)
  .join(', ');

const idString = (v) => String(v && v._id ? v._id : (v || ''));

const splitBody = (proposed, spellings) => ({
  error: `The registry already spells this producer ${spellingList(spellings)} — choose which spelling to keep before approving: the registry's, "${proposed}" for the spellings you name, or both if they are different producers`,
  code: 'producer_spelling_split',
  proposed,
  spellings,
});

// A read-only first look at a pending producer change, BEFORE the claim (review
// 2026-09-28). A split with no pick is the routine first answer for these rows
// — every bulk batch gives one — so it must not cost a claim and a revert: the
// revert can collide with a proposal re-filed in that window and strand this
// one approved-but-unapplied. The check after the claim stays authoritative.
async function splitBeforeClaim(proposalId) {
  const pre = await WineCorrectionProposal.findOne({ _id: proposalId, status: 'pending' }).lean();
  const pf = pre && pre.kind === 'field_correction' ? (pre.proposedFields || {}) : null;
  if (!pf || !(pf.producer || pf.country)) return null;
  const wine = await WineDefinition.findById(pre.wineDefinition);
  if (!wine) return null;
  const producer = pf.producer ? pf.producer.trim() : wine.producer;
  const country = await countryAfter(pf, wine);
  const moved = displaySpelling(producer) !== displaySpelling(wine.producer) || idString(country) !== idString(wine.country);
  if (!moved) return null;
  const spellings = await otherProducerSpellings(producer, country, { excludeWineId: wine._id });
  return spellings.length ? { proposed: producer, spellings } : null;
}

// Already-decided vs never-existed, after a failed claim (aiBudgetRequests pattern).
async function decideOutcome(proposalId) {
  const exists = await WineCorrectionProposal.exists({ _id: proposalId });
  return exists
    ? { status: 409, body: { error: 'Proposal has already been decided' } }
    : { status: 404, body: { error: 'Proposal not found' } };
}

/**
 * Approve ONE proposal: atomic claim → apply by kind → per-proposal audit.
 * Returns { status, body } instead of writing to a response, so the single
 * route and the bulk loop run EXACTLY the same machinery — the
 * performWineMerge extraction pattern, one layer up. Unexpected errors are
 * thrown (after the claim revert) for the caller to map to its own 500.
 */
async function approveProposal(proposalId, req, { deferFollowThrough = false, producerSpelling = null } = {}) {
    if (!producerSpelling) {
      const split = await splitBeforeClaim(proposalId);
      if (split) return { status: 409, body: splitBody(split.proposed, split.spellings) };
    }

    // Atomically CLAIM the pending row so only the first of two concurrent
    // decisions wins (the aiBudgetRequests check-then-act fix): a null result
    // means already-decided (409) or never-existed (404).
    const now = new Date();
    const proposal = await WineCorrectionProposal.findOneAndUpdate(
      { _id: proposalId, status: 'pending' },
      { $set: { status: 'approved', decidedBy: req.user.id, decidedAt: now } },
      { new: true }
    );
    if (!proposal) return decideOutcome(proposalId);

    // Any apply failure below reverts the claim so there is no half-approved
    // state. Best-effort by necessity: the moment our claim left 'pending',
    // the one-pending-per-(wine, kind) index frees — a proposal re-filed in
    // that window makes the revert collide, in which case we log and leave
    // the row decided rather than 500-ing over bookkeeping.
    const revertClaim = async () => {
      try {
        await WineCorrectionProposal.updateOne(
          { _id: proposal._id, status: 'approved', decidedAt: now },
          { $set: { status: 'pending', decidedBy: null, decidedAt: null } }
        );
      } catch (err) {
        console.error('Wine proposal claim revert failed:', err.message);
      }
    };

    let appliedNote = '';
    // Set only by the field_correction branch when the caller defers — the
    // bulk loop fires ONE follow-through per wine after every decision has
    // applied (audit 2026-08-16: per-proposal firing raced same-wine batches
    // and cost N forced AI calls for one wine).
    let followThrough = null;
    // The corrected wine, for the submitter's notification once all is recorded.
    let correctedWine = null;
    try {
      if (proposal.kind === 'field_correction') {
        const wine = await WineDefinition.findById(proposal.wineDefinition);
        if (!wine) {
          await revertClaim();
          return { status: 404, body: { error: 'The proposed wine no longer exists' } };
        }
        correctedWine = wine;
        // Before-image for the re-enrich decision below — same real-change
        // semantics as the admin PUT.
        const beforeProfileInputs = profileInputsSnapshot(wine);
        const producerBefore = wine.producer;
        const countryBefore = wine.country;
        const pf = proposal.proposedFields || {};
        const applied = [];

        // Same identity-field semantics as the admin wine PUT: trimmed
        // strings, appellation normalized, country RESOLVED (never minted),
        // region through the gated findOrCreateRegion helper.
        if (pf.name) { wine.name = pf.name.trim(); applied.push('name'); }
        if (pf.producer) { wine.producer = pf.producer.trim(); applied.push('producer'); }
        if (pf.classification) {
          // The write rule (services/classificationOps), strict: a filed tier
          // the taxonomy lacks is a 400 that names the known tiers — add the
          // row under Taxonomy → Classifications, then approve. A regulatory
          // mark applies as nothing, as before.
          const cls = await assignClassification(wine, { classification: pf.classification, strict: true });
          if (!cls.ok) {
            await revertClaim();
            return { status: 400, body: { error: cls.message } };
          }
          if (cls.classification) applied.push('classification');
        }
        if (pf.appellation) {
          // Tier-strip AND curated-registry resolve. Approving a proposal is a
          // registry WRITE, so it owes the same canonicalization as the mint
          // chokepoint: without the resolver a somm's "Yecla DO" landed
          // verbatim on the wine (prod, 2026-08-12) because the trailing "DO"
          // is deliberately outside normalizeAppellation's token set.
          wine.appellation = await resolveCanonicalAppellation(normalizeAppellation(pf.appellation.trim()));
          applied.push('appellation');
        }

        let countryDoc = null;
        if (pf.country) {
          // Alias → canonical name → existing Country doc. Unresolvable is a
          // 400, never a minted Country — taxonomy grows deliberately, not
          // through an approval click.
          countryDoc = await Country.findOne({ normalizedName: normalizeString(resolveCountryName(pf.country)) });
          if (!countryDoc) {
            await revertClaim();
            return { status: 400, body: { error: `Unknown country "${pf.country}" — add it in Admin → Taxonomy first, then approve` } };
          }
          wine.country = countryDoc._id;
          applied.push('country');
        }
        // (The region is resolved last, after every check that can refuse:
        // findOrCreateRegion may MINT one, and a refused approve must leave
        // nothing behind.)

        // Type is re-validated here even though the MCP tool already refused a
        // bad one: this route is the only guarantee, and a proposal filed
        // before an enum change would otherwise write a value the schema
        // rejects at save() with a far worse error.
        if (pf.type) {
          if (!WINE_TYPES.includes(pf.type)) {
            await revertClaim();
            return { status: 400, body: { error: `Unknown wine type "${pf.type}" — must be one of: ${WINE_TYPES.join(', ')}` } };
          }
          wine.type = pf.type;
          applied.push('type');
        }

        // Colour is judged against the type the wine has NOW (after any type
        // in this same proposal): on a red/white/rosé wine the type already is
        // the colour, and the model hook would drop it anyway — say so rather
        // than report a field as applied that was not stored.
        if (pf.colour) {
          if (!WINE_COLOURS.includes(pf.colour)) {
            await revertClaim();
            return { status: 400, body: { error: `Unknown colour "${pf.colour}" — must be one of: ${WINE_COLOURS.join(', ')}` } };
          }
          if (isStyleType(wine.type)) {
            wine.colour = pf.colour;
            applied.push('colour');
          } else {
            applied.push('colour (skipped — only sparkling, dessert and fortified wines carry one)');
          }
        }

        // Grapes resolve against LIVE taxonomy at approval, not at filing: a
        // variety can be renamed or merged into its canonical entry in between
        // (17 were merged on 2026-08-19 alone), and the curator's names should
        // still land on the right rows afterwards. Match-only, exactly like
        // country above — approving a proposal must never MINT taxonomy.
        if (Array.isArray(pf.grapes) && pf.grapes.length) {
          const resolved = await resolveGrapeIdsStrict(pf.grapes);
          if (!resolved.ok) {
            await revertClaim();
            return { status: 400, body: {
              error: `Unknown grape${resolved.unmatched.length > 1 ? 's' : ''} ${resolved.unmatched.map((g) => `"${g}"`).join(', ')} — add ${resolved.unmatched.length > 1 ? 'them' : 'it'} in Admin → Taxonomy first, then approve`,
            } };
          }
          wine.grapes = resolved.ids;
          // Say when a synonym was folded ("Tinta Roriz" → Tempranillo) rather
          // than silently storing something the curator did not type.
          applied.push(resolved.substitutions.length
            ? `grapes (${resolved.substitutions.map((s) => `${s.from} → ${s.to}`).join(', ')})`
            : 'grapes');
        }

        // Producer SPELLING (2026-09-28). The mint-time resolver
        // (services/producerSpelling) never sees a producer changed on an
        // existing wine, and approving one that way split 9 producers in a
        // single week ("Château Lagrézette" beside "Chateau Lagrezette"). A
        // new producer — or the same one moved to another country — spelled
        // unlike the rest of its producer there (same key, same country)
        // needs the admin's pick: the registry's spelling, rename the
        // spellings they name to this one, or keep both (the bucket
        // deliberately over-folds, so two real estates can share it). No pick
        // (a stale page, a bulk batch) = 409 with the spellings. splitBeforeClaim
        // answers the usual case before the claim; this is the authoritative
        // re-check. Strict: a failed lookup must not read as "no split".
        let renamePlan = null;
        const producerChanged = pf.producer && displaySpelling(wine.producer) !== displaySpelling(producerBefore);
        const countryChanged = Boolean(countryDoc) && idString(countryDoc._id) !== idString(countryBefore);
        if (producerChanged || countryChanged) {
          const others = await otherProducerSpellings(wine.producer, wine.country, { excludeWineId: wine._id, strict: true });
          if (!others.length && producerSpelling && producerSpelling.kind !== 'proposed') {
            // The admin picked a registry spelling (or a rename) from a split
            // that no longer exists — the other wines were merged, renamed or
            // quarantined meanwhile. Writing the proposed string under a
            // "keep the registry's spelling" click would apply what they
            // declined; refuse so they see the current state and click again.
            await revertClaim();
            return { status: 409, body: {
              error: 'The registry no longer spells this producer another way — the split was resolved meanwhile. Reload the list and approve again.',
              code: 'producer_spelling_gone',
            } };
          }
          if (others.length) {
            const proposed = wine.producer;
            // A country-only proposal has no 'producer' entry to annotate.
            const note = (text) => {
              const at = applied.indexOf('producer');
              if (at === -1) applied.push(text); else applied[at] = text;
            };
            if (!producerSpelling) {
              await revertClaim();
              return { status: 409, body: splitBody(proposed, others) };
            }
            if (producerSpelling.kind === 'existing') {
              if (!others.some((o) => o.spelling === producerSpelling.spelling)) {
                await revertClaim();
                return { status: 400, body: { error: `"${producerSpelling.spelling}" is not one of this producer's registry spellings (${spellingList(others)})` } };
              }
              wine.producer = producerSpelling.spelling;
              note(`producer (the registry's spelling "${producerSpelling.spelling}" rather than "${proposed}")`);
            } else if (producerSpelling.kind === 'renameAll') {
              const unknown = producerSpelling.spellings.filter((s) => !others.some((o) => o.spelling === s));
              if (unknown.length) {
                await revertClaim();
                return { status: 400, body: { error: `${unknown.map((s) => `"${s}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not among this producer's registry spellings (${spellingList(others)})` } };
              }
              renamePlan = await planProducerRename(producerSpelling.spellings, proposed, wine.country, {
                excludeWineId: wine._id,
                // The corrected wine's own new key, term included: the plan's
                // keys carry the term too, so a termed sibling clash is seen
                // and an untermed twin is not a false one.
                reservedKeys: [generateWineKey(wine.name, proposed, wine.appellation, { sweetness: await termNameForWine(wine) })],
              });
              if (renamePlan.tooMany) {
                await revertClaim();
                return { status: 409, body: {
                  error: `Renaming them would change ${renamePlan.tooMany} wines — more than an approval should; use scripts/consolidate-producer-displays.js`,
                  code: 'producer_rename_too_large',
                } };
              }
              if (renamePlan.clashes.length) {
                await revertClaim();
                return { status: 409, body: {
                  error: `Renaming them would make ${renamePlan.clashes.map((c) => `"${c.name}"`).join(', ')} identical to another registry wine — merge ${renamePlan.clashes.length === 1 ? 'it' : 'them'} first, then approve`,
                  code: 'producer_rename_clash',
                  clashes: renamePlan.clashes,
                } };
              }
            } else {
              note(`producer "${proposed}" (kept apart from ${others.map((o) => `"${o.spelling}"`).join(', ')} — a different producer)`);
            }
          }
        }

        if (pf.region) {
          // findOrCreateRegion carries the mint gates (comma hierarchies and
          // country-name regions → null, new mints flagged pendingReview).
          // A gated null is the helper's honest "no region" and is applied as
          // such rather than failing the whole approve.
          const regionDoc = await findOrCreateRegion(pf.region, countryDoc?._id || wine.country, req.user.id);
          wine.region = regionDoc?._id || null;
          applied.push(regionDoc ? 'region' : 'region (cleared — name failed the mint gates)');
        }

        // Same rule as the PUT: the dedup key follows name/producer/appellation
        // (the producer can also change through a spelling pick above).
        if (pf.name || pf.producer || pf.appellation || wine.producer !== producerBefore) {
          wine.normalizedKey = generateWineKey(wine.name, wine.producer, wine.appellation);
        }

        try {
          await wine.save();
        } catch (err) {
          if (err.code === 11000) {
            await revertClaim();
            return { status: 409, body: {
              error: 'Applying this correction would make the wine identical to an existing registry wine — use a merge proposal instead',
              // Coded, so the review modal keeps the row and shows this
              // instead of reloading it away as "decided elsewhere".
              code: 'identical_wine',
            } };
          }
          throw err;
        }

        // The PUT's follow-through: registry index, the embedding text — and
        // the IndexNow ping (an approved identity fix changes the public wine
        // page exactly like a PUT rename; parity per audit 2026-08-10).
        submitUrls(`/wines/${wine._id}`);
        searchService.indexWine(wine._id);
        // And the PUT's re-enrich (parity gap found live 2026-08-16: approving
        // "Fabelhaft" → "Niepoort" left the négociant-fiction profile attached
        // until a manual force re-enrich). Real-change only, curator-safe —
        // see reenrichAfterRecordEdit.
        const profileInputsChanged = profileInputsSnapshot(wine) !== beforeProfileInputs;
        if (deferFollowThrough) {
          followThrough = { wineId: String(wine._id), wine, changed: profileInputsChanged };
        } else {
          reembedActiveVintages(wine._id).catch(() => {});
          reenrichAfterRecordEdit(wine, profileInputsChanged);
        }

        // "Rename": the wines under the spellings the admin named follow,
        // through the consolidate-producer-displays write path (doc.save
        // hooks, the pre-checked key, its audit action). The approval itself
        // is already recorded — a row that fails here (a key taken since the
        // plan) is named in the note for a manual fix, never a reason to undo
        // it. A spelling change is not a new wine, so no re-enrich — just the
        // index, the public URL and the embedding text — and a profile that
        // described the record still does: its input snapshot follows the
        // spelling, or the next enrichment sweep would regenerate it as stale.
        let renamedNote = '';
        if (renamePlan && renamePlan.wines.length) {
          let renamed = 0;
          const failed = [];
          for (const { doc, from, newKey } of renamePlan.wines) {
            const snapshotWasCurrent = Boolean(doc.aiProfile?.inputsSnapshot)
              && doc.aiProfile.inputsSnapshot === profileInputsSnapshot(doc);
            doc.producer = wine.producer;
            doc.normalizedKey = newKey;
            if (snapshotWasCurrent) doc.aiProfile.inputsSnapshot = profileInputsSnapshot(doc);
            try {
              await doc.save();
              renamed += 1;
              logAudit(req, 'admin.wine.producer_consolidate', { type: 'wine', id: doc._id },
                { from, to: wine.producer, via: 'wine-proposal', proposalId: proposal._id });
              searchService.indexWine(doc._id);
              submitUrls(`/wines/${doc._id}`);
              reembedActiveVintages(doc._id).catch(() => {});
            } catch (err) {
              console.error(`Producer rename after proposal ${proposal._id} failed for wine ${doc._id}:`, err.message);
              failed.push(`"${doc.name}"`);
            }
          }
          renamedNote = `; ${renamed} other wine${renamed === 1 ? '' : 's'} renamed to "${wine.producer}"`
            + (failed.length ? ` (not renamed: ${failed.join(', ')})` : '');
        }

        appliedNote = `Applied: ${applied.join(', ')}${renamedNote}`;
      } else if (proposal.kind === 'merge') {
        // The extracted single-pair merge — exactly what POST /:id/merge runs.
        const result = await performWineMerge(String(proposal.wineDefinition), String(proposal.mergeTargetId), req);
        if (result.error) {
          await revertClaim();
          return { status: result.error.status, body: { error: result.error.message } };
        }
        const targetLabel = [result.target.producer, result.target.name].filter(Boolean).join(' — ');
        appliedNote = `Merged into ${targetLabel} (${result.bottlesMoved} bottle(s) moved)`;
      } else { // non_wine
        const wine = await WineDefinition.findById(proposal.wineDefinition);
        if (!wine) {
          await revertClaim();
          return { status: 404, body: { error: 'The proposed wine no longer exists' } };
        }
        // Same semantics as POST /:id/non-wine value:true — flag + let the
        // self-healing index sync drop it from search.
        wine.nonWine = true;
        await wine.save();
        // Earlier flags on this wine that a restore took back stand again (as
        // when an admin re-quarantines it with the toggle); this row's
        // receipt is written below, and awardProposal pays it.
        await settleNonWineProposals(wine._id, true);
        searchService.indexWine(wine._id);
        // Its vectors go too, or semantic search and the similar-wines graph
        // would keep showing the row (audit 2026-10-14).
        await WineEmbedding.deleteMany({ wineDefinition: wine._id });
        // Completes the quarantine for the somm queue: PENDING maturity rows
        // go (they are auto-seeded stubs); REVIEWED windows are curated data
        // and stay with the record.
        const del = await WineVintageProfile.deleteMany({ wineDefinition: wine._id, status: 'pending' });
        appliedNote = `Quarantined as non-wine; ${del.deletedCount || 0} pending maturity-queue row(s) removed`;
        logAudit(req, 'admin.wine.nonWine', { type: 'wine', id: wine._id },
          { value: true, name: wine.name, producer: wine.producer, via: 'wine-proposal' });
      }
    } catch (err) {
      // Unexpected apply failure: give the row back to the queue (merges are
      // idempotent + re-runnable by design, field writes did not commit).
      await revertClaim();
      throw err;
    }

    await WineCorrectionProposal.updateOne({ _id: proposal._id }, { $set: { appliedNote } });

    logAudit(req, 'admin.wineProposal.approve',
      { type: 'WineCorrectionProposal', id: proposal._id },
      {
        kind: proposal.kind,
        wineDefinitionId: proposal.wineDefinition,
        ...(proposal.mergeTargetId ? { mergeTargetId: proposal.mergeTargetId } : {}),
        appliedNote,
      });

    // Accepted and applied: the proposer's Cellar Cred, once per row — the
    // self-apply door and staff proposals earn nothing (services/suggestionCred).
    // Never throws; the decision above stands either way.
    await awardProposal(proposal);

    notifyProposer(proposal, correctedWine, req.user.id, true);

    return {
      status: 200,
      body: { message: 'Proposal approved and applied', proposalId: proposal._id, status: 'approved', appliedNote },
      ...(followThrough ? { followThrough } : {}),
    };
}

// Reason hygiene shared by the single and bulk reject paths: plain text only,
// bounded even after strip (reject_price_request hygiene).
function parseRejectReason(raw) {
  const reason = stripHtml(typeof raw === 'string' ? raw : '');
  if (!reason || reason.length < REJECT_REASON_MIN) {
    return { error: `A reject reason of at least ${REJECT_REASON_MIN} characters is required` };
  }
  if (reason.length > REJECT_REASON_MAX) {
    return { error: `Reject reason must be at most ${REJECT_REASON_MAX} characters` };
  }
  return { reason };
}

/** Reject ONE proposal via the same atomic claim. Returns { status, body }. */
async function rejectProposal(proposalId, reason, req) {
  const proposal = await WineCorrectionProposal.findOneAndUpdate(
    { _id: proposalId, status: 'pending' },
    { $set: { status: 'rejected', decidedBy: req.user.id, decidedAt: new Date(), rejectReason: reason } },
    { new: true }
  );
  if (!proposal) return decideOutcome(proposalId);

  logAudit(req, 'admin.wineProposal.reject',
    { type: 'WineCorrectionProposal', id: proposal._id },
    { kind: proposal.kind, wineDefinitionId: proposal.wineDefinition, reason });

  // Only the label is needed — and only when there is somebody to tell. The
  // decision is ALREADY recorded and audited above, so a failed label read must
  // not answer 500 (the admin would retry into a 409 and the submitter would
  // never hear): the notification then simply goes out without the label.
  if (proposal.kind === 'field_correction' && proposal.via) {
    let wineDoc = null;
    try {
      wineDoc = await WineDefinition.findById(proposal.wineDefinition).select('name producer').lean();
    } catch (err) {
      console.warn('[wineProposals] label lookup for the rejection notice failed (non-fatal):', err.message);
    }
    notifyProposer(proposal, wineDoc, req.user.id, false, reason);
  }

  return { status: 200, body: { message: 'Proposal rejected', proposalId: proposal._id, status: 'rejected' } };
}

module.exports = {
  REJECT_REASON_MIN,
  REJECT_REASON_MAX,
  countryAfter,
  parseSpellingChoice,
  approveProposal,
  parseRejectReason,
  rejectProposal,
};
