// Sommelier tools: the pending-identity queue — wines minted at bottle-commit
// from an incomplete identity, completed by a curator from the bottle images.
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const WineDefinition = require('../../../models/WineDefinition');
const { registerTool } = require('../../registry');
const { ok, fail, objectId, pageParams, FIELD_DESCRIPTIONS, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAudit } = require('../../../services/audit');
const { logAction } = require('../../actionLedger');
const { isValidId } = require('../../../utils/validation');
const { WINE_TYPES, GRAPES_MAX, GRAPE_NAME_MAX } = require('../../../services/wineProfileOps');
const { WINE_COLOURS } = require('../../../utils/wineColour');
const {
  queryPendingWines,
  validatePendingFix,
  applyPendingFix,
  mergePendingInto,
  loadPendingWine,
  CREATED_VIA_FILTERS,
  FIELD_MAX,
  MAX_BOTTLE_IMAGES,
} = require('../../../services/pendingWineOps');

// ── Pending-identity queue ───────────────────────────────────────────────────
//
// Wines minted at bottle-commit from an INCOMPLETE identity: no producer, a
// sentinel one ("Unknown", "N/A"), or a geography typed into the producer box.
// The bottle saved instantly (never make adding harder); the registry row is
// hidden from everyone but its creator until a curator completes it. All three
// tools ride services/pendingWineOps, so REST and MCP cannot drift on
// projection, taxonomy resolution or conflict semantics.
//
// ANONYMISED like the owner inquiries: the curator gets the wine, its
// bottle count and its IMAGES — never who added it.
const { renderImage } = require('../../../services/photoBytes');
// ONE definition of "may curation read this label scan" — shared with the REST
// image gate (routes/images.js) and the retention sweep.
const { mayCurationReadScan, PROMOTED_SCAN_GRACE_DAYS, logCurationImageRead } = require('../../../services/labelScanAccess');

// Downscale cap for the image blocks. 1024px on the longest edge is what a
// vision model needs to read a wine label and is a large byte reduction on a
// phone capture; the total cap keeps one response inside a sane MCP payload.
const IMAGE_MAX_EDGE = 1024;
const IMAGE_TOTAL_CAP_BYTES = 4 * 1024 * 1024;

registerTool({
  name: 'list_pending_wines',
  title: 'Sommelier: list wines waiting for an identity',
  description:
    'Lists registry wines created from an INCOMPLETE identity — an unreadable label, a missing producer, or a region ' +
    'typed where the producer belongs. Their bottles are already in their owners\' cellars and work normally; the ' +
    'wine itself is hidden from every other user until a curator completes it, so this queue is what un-hides them. ' +
    'Newest first. Pass created_via to work one source at a time — "import" is typically one user\'s CSV burst and is ' +
    'best cleared in a batch, "ui" is the trickle of label scans. Each row carries image ids: call ' +
    'get_pending_wine_images to actually READ the label, then fix_pending_wine. Owners are never identified here. ' +
    'The queue also holds wines taken from a member\'s cellar FILE that wait for a curator\'s check (waiting_for_check: ' +
    'true), on a server that checks imported wines before they are public. Those usually have a complete identity ' +
    'and no photo: the row is what the file said. Pass kind "needs_check" to work them, OLDEST first (their owners ' +
    'are waiting in that order). For each: verify the wine exists as written, correct what is wrong, and publish it ' +
    'with fix_pending_wine identity_checked: true; when it is a wine the registry already holds, merge_pending_wine.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    created_via: z.enum(CREATED_VIA_FILTERS).optional()
      .describe('Narrow to one entry surface — the practical way to work a large import burst'),
    kind: z.enum(['needs_check', 'needs_identity']).optional()
      .describe('One half of the queue: "needs_check" = wines from a member\'s file waiting for a curator\'s check, oldest first; "needs_identity" = wines with an incomplete identity only. Omit for both, newest first.'),
    include_unavailable: z.boolean().optional()
      .describe('Also list rows already recorded as having NO producer on the label (excluded by default — they have no work left). Use it to review or reverse that disposition.'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { limit, offset } = pageParams(args, 20, 50);
    const { rows, total, pendingTotal, unavailableTotal, uncheckedTotal } = await queryPendingWines({
      limit, offset, createdVia: args.created_via, kind: args.kind,
      includeUnavailable: args.include_unavailable === true,
    });
    const data = rows.map((r) => ({
      wine_id: r._id,
      name: r.name,
      producer: r.producer,
      appellation: r.appellation,
      region: r.regionName,
      country: r.countryName,
      grapes: r.grapeNames,
      type: r.type,
      created_at: r.createdAt,
      created_via: r.createdVia,
      bottle_count: r.bottleCount,
      identity_unavailable: r.identityUnavailable,
      // From a member's file, waiting for a check: published only by
      // fix_pending_wine identity_checked (or ended by merge_pending_wine).
      waiting_for_check: r.unchecked,
      scan_image_id: r.scanImageId,
      // The optional BACK label of the same bottle: present when the front scan
      // came back incomplete and the owner took the rescue photo.
      scan_image_back_id: r.scanImageBackId,
      // Where the two labels disagreed at scan time. The FRONT value is what
      // was stored — a curator reading "producer: front 'Ch. Musar', back
      // 'Musar SAL'" can usually settle the row without opening the photos.
      // Omitted entirely on rows with one frame, which is most of them.
      ...(r.scanFieldConflicts && r.scanFieldConflicts.length
        ? { front_back_disagreements: r.scanFieldConflicts }
        : {}),
      bottle_image_ids: r.bottleImageIds,
      has_images: !!(r.scanImageId || r.scanImageBackId || r.bottleImageIds.length),
    }));
    return ok(
      `${pendingTotal} wine(s) in the pending queue (showing ${data.length} of ${total}${args.created_via ? ` via ${args.created_via}` : ''}${args.kind ? `, ${args.kind}` : ''})` +
      (uncheckedTotal ? `; ${uncheckedTotal} of them from a member's file, waiting for a check` : '') +
      (unavailableTotal ? `; ${unavailableTotal} more recorded as having no producer on the label` : ''),
      data,
      { page: { limit, offset, total } }
    );
  },
});

registerTool({
  name: 'get_pending_wine_images',
  title: 'Sommelier: read a wine\'s label scan and public photos',
  description:
    'Returns the actual PHOTOS for one wine — as images you can look at, downscaled server-side, each preceded by a ' +
    'caption saying what it is. THIS is how the pending-identity queue gets fixed: read the producer, appellation ' +
    'and classification off the label, then call fix_pending_wine with what the label says. Do not guess from the ' +
    'broken name string when a photo is available. ' +
    'What comes back depends on what exists, not on whether the wine is in the queue: the LABEL SCAN (front, and ' +
    'the back label when the owner photographed that too) while it is inside its window — always for a pending ' +
    'wine, and for 7 days after a wine leaves the queue so a wrong completion can still be corrected, after which ' +
    'it is deleted; the wine\'s APPROVED PUBLIC gallery photos for ANY wine, pending or long since published, ' +
    'exactly the set the public wine page already shows anyone (credit included when stored); and, for a PENDING ' +
    'wine only, up to 3 of its owners\' own bottle photos. Once a wine has left the queue those private photos are ' +
    'private again — but its published ones are not, so a promoted wine is worth asking about. ' +
    'A wine with no scan and no public photo says so — judge it on its text or use ask_bottle_owner, never invent ' +
    'a producer. A gallery photo may not show the label at all; read it for what it can actually settle.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_pending_wines'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');

    // WHAT MAY BE SERVED, and why — three separate questions, deliberately not
    // one: a single gate would refuse a promoted wine whose scan exists, or a
    // wine whose APPROVED PUBLIC photo the wine page renders to anonymous
    // visitors.
    //
    //   scan frames  — curation evidence. Readable while they EXIST and are
    //                  inside their window: pending → readable, promoted →
    //                  readable until retainUntil passes (services/
    //                  labelScanAccess, one definition shared with the REST
    //                  sibling and the retention sweep). QUEUE MEMBERSHIP IS
    //                  NOT THE GATE: it would keep the scans that failed badly
    //                  readable and hide those that failed subtly — inverted
    //                  against need.
    //   public gallery — the wine's approved+public photos, for ANY wine. The
    //                  web page already serves these to anybody with the URL,
    //                  so serving them here is ZERO new exposure, and refusing
    //                  them while claiming privacy is simply false.
    //   private photos — the owners' own bottle photos. Pending-only: shipping
    //                  somebody's private gallery to an external model is
    //                  justified by a curator reading a label they were asked
    //                  to identify, and by nothing else.
    const BottleImage = require('../../../models/BottleImage');
    const Bottle = require('../../../models/Bottle');
    const wine = await WineDefinition.findById(args.wine_id)
      .select('name producer pendingIdentity draft scanImage scanImageBack scanFieldConflicts').lean();
    // A private draft (pending by invariant, but in nobody's queue) answers
    // the same not_found a missing id does — its label is not curation
    // evidence. `draft` is selected above, so this check can see it.
    if (!wine || wine.draft === true) return fail('not_found', 'No wine with that id. Use list_pending_wines for valid ids.');

    const stillPending = wine.pendingIdentity === true;
    const loadScan = async (id) => (id
      ? BottleImage.findById(id).select('_id kind side originalUrl processedUrl retainUntil').lean()
      : null);
    const scan = await loadScan(wine.scanImage);
    // The optional BACK label of the same bottle (the rescue scan). Gated on
    // its OWN retainUntil as well as the front's: a wine may carry only a back
    // frame — the front scan 422'd and its frame was never committed — and
    // reading the gate off a missing front would hide the only evidence there
    // is.
    const scanBack = await loadScan(wine.scanImageBack);

    // PER-IMAGE readability, not the pair's: each frame
    // carries its own retainUntil, and if they ever diverge (the retention job
    // explicitly anticipates a back scan added later) the expired one must not
    // ride the other's grace window.
    const readableScans = [];
    if (scan && mayCurationReadScan(wine, scan)) readableScans.push(scan); // the scanned label first — primary evidence
    // …then the back label, when the owner took the rescue photo. Second
    // because the front is what names the wine; the back is what usually names
    // the producer and the appellation the front left off.
    if (scanBack && mayCurationReadScan(wine, scanBack)) readableScans.push(scanBack);

    // The PUBLIC gallery — byte-for-byte the filter GET /api/images/wine/:id
    // serves the web (status approved + visibility public, official image
    // first), so this surface can never show more than the page does. The
    // kind exclusion is belt-and-braces: a label scan is always private, so it
    // cannot match anyway.
    // BOTH linkage forms: an approved public photo may hang off the WINE or
    // off one of its BOTTLES, and the wine page renders both. The distinct()
    // runs for any wine because it only feeds this approved+public query; the
    // PRIVATE both-ways owner query below stays pending-only.
    const galleryBottleIds = (await Bottle.distinct('_id', { wineDefinition: wine._id })) || [];
    const gallery = await BottleImage.find({
      $or: [
        { wineDefinition: wine._id },
        ...(galleryBottleIds.length ? [{ bottle: { $in: galleryBottleIds } }] : []),
      ],
      status: 'approved',
      visibility: 'public',
      kind: { $ne: 'label-scan' },
    }).select('_id kind status visibility credit originalUrl processedUrl')
      .sort({ assignedToWine: -1, createdAt: -1 }).limit(MAX_BOTTLE_IMAGES).lean();

    if (readableScans.length === 0 && gallery.length === 0 && !stillPending) {
      // Two states, two truths: a wine never added from a photo has no window
      // that closed, and saying it "has closed" would tell the curator that
      // evidence had existed and they were too late.
      if (!scan && !scanBack) {
        return fail('conflict',
          'That wine has no label scan — it was not added from a photo — and no public gallery photo either, so there '
          + 'is nothing to look at. Its owners\' bottle photos are private. Use ask_bottle_owner if the label is the '
          + 'only thing that can settle this.');
      }
      return fail('conflict',
        `That wine's label scan is gone — its ${PROMOTED_SCAN_GRACE_DAYS}-day correction window has closed — and the `
        + 'wine has no public gallery photo either. Use ask_bottle_owner if the label is the only thing that can settle this.');
    }

    // "Which images belong to this wine" has exactly one definition — the same
    // both-ways match the queue projection uses (some upload paths stamp the
    // wine on the image, the plain add flow only links it to the bottle).
    // `status`/`visibility` ride along so each photo can be captioned for what
    // it actually is. PENDING ONLY (the private-photos rule above).
    const bottleIds = stillPending ? await Bottle.distinct('_id', { wineDefinition: wine._id }) : [];
    const imgs = stillPending ? await BottleImage.find({
      kind: { $ne: 'label-scan' },
      $or: [{ wineDefinition: wine._id }, ...(bottleIds.length ? [{ bottle: { $in: bottleIds } }] : [])],
    }).select('_id kind status visibility credit originalUrl processedUrl')
      .sort({ createdAt: -1 }).limit(MAX_BOTTLE_IMAGES).lean() : [];

    const ordered = [...readableScans, ...imgs];
    // Gallery photos FILL the same photo budget rather than adding a second
    // one, and only where they are not already in `imgs` (on a pending wine the
    // both-ways query above has usually picked them up already).
    const seen = new Set(imgs.map((i) => String(i._id)));
    for (const g of gallery) {
      if (ordered.length - readableScans.length >= MAX_BOTTLE_IMAGES) break;
      if (seen.has(String(g._id))) continue;
      ordered.push(g);
    }

    if (ordered.length === 0) {
      return ok(
        `No photos are stored for "${wine.name}" — this row has to be judged on its text alone`,
        { wine_id: wine._id, images: 0, still_pending: stillPending }
      );
    }

    const blocks = [];
    const included = [];
    let totalBytes = 0;
    for (const doc of ordered) {
      // The ORIGINAL is what a curator wants: background removal can eat a
      // corner of the label. Fall back to the processed render if it is gone.
      const url = doc.originalUrl || doc.processedUrl;
      if (!url || typeof url !== 'string' || !url.startsWith('/api/uploads/')) continue;
      try {
        // Downscaled exactly as get_photo does it (services/photoBytes).
        const rendered = await renderImage(url, { maxEdge: IMAGE_MAX_EDGE });
        if (!rendered) continue;
        // Cap the WHOLE response, not each image: 4 MB is the budget, and a
        // curator would rather see two labels than be refused all of them.
        if (totalBytes + rendered.bytes > IMAGE_TOTAL_CAP_BYTES) break;
        totalBytes += rendered.bytes;
        // A caption block BEFORE each image, because a queue row can carry
        // two label frames of one bottle and "the producer is not printed on
        // this one" means opposite things about a front and a back label. The
        // ids in `data.images` alone cannot carry that: nothing ties an id to a
        // position in the image stream.
        const isScan = (doc.kind || 'bottle') === 'label-scan';
        const face = doc.side === 'back' ? 'BACK' : 'FRONT';
        // A published gallery photo and somebody's private bottle photo are
        // different things and must not be captioned alike — one is what every
        // visitor to the wine page sees, the other is released to curation for
        // one purpose. Derived from the doc rather than from which query it
        // came out of, so the two paths can never label the same row
        // differently.
        const isPublic = !isScan && doc.status === 'approved' && doc.visibility === 'public';
        const credit = typeof doc.credit === 'string' && doc.credit.trim() ? doc.credit.trim() : null;
        let caption;
        if (isScan) caption = `the ${face} LABEL frame the owner scanned`;
        else if (isPublic) caption = `a PUBLIC gallery photo of this wine${credit ? ` (credit: ${credit})` : ''}`;
        else caption = "a photo of the owner's bottle";
        blocks.push({
          type: 'text',
          text: `Image ${included.length + 1} — ${caption} (image_id ${doc._id})`,
        });
        blocks.push({ type: 'image', data: rendered.data, mimeType: rendered.mimeType });
        // Marked private unless the owner published it: these are somebody's
        // own bottle photos, released to curation for one purpose only.
        included.push({
          image_id: String(doc._id),
          kind: doc.kind || 'bottle',
          // Only meaningful for a label scan; a gallery photo is always 'front'
          // by schema default and nothing should read it as a claim.
          ...(isScan ? { side: doc.side === 'back' ? 'back' : 'front' } : {}),
          private: !isPublic && doc.visibility !== 'public',
          ...(isPublic ? { public_gallery: true } : {}),
          ...(credit ? { credit } : {}),
        });
      } catch (err) {
        console.warn('[mcp] pending-wine image read failed:', err.message);
      }
    }
    if (included.length === 0) {
      return fail('unavailable', 'The stored photos for this wine could not be read right now — retry later, or judge the row on its text.');
    }

    // Somebody's private photo is about to leave the platform for the
    // curator's model provider — that leaves a record on this surface exactly
    // as on the REST twin.
    logCurationImageRead(ctx.req, {
      wineId: wine._id,
      imageIds: included.map(i => i.image_id),
      privateCount: included.filter(i => i.private).length,
      scanCount: included.filter(i => i.kind === 'label-scan').length,
      via: 'mcp',
    });

    // Text part FIRST so the model reads the instruction before the pixels.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: `${included.length} photo(s) for "${wine.name}"${wine.producer ? ` — ${wine.producer}` : ' (no producer recorded)'}`,
            data: {
              wine_id: wine._id,
              still_pending: stillPending,
              // Only present after promotion: how long the label stays
              // correctable. The model should say so when it reports a fix.
              ...(stillPending ? {} : { correction_window_until: scan?.retainUntil || scanBack?.retainUntil || null }),
              images: included,
              // What the two labels disagreed about at scan time, front value
              // kept. Absent unless a back-label rescue scan actually ran.
              ...((wine.scanFieldConflicts || []).length
                ? { front_back_disagreements: wine.scanFieldConflicts.map((c) => ({ field: c.field, front: c.front, back: c.back })) }
                : {}),
              guidance: stillPending
                ? 'Read the producer, appellation and classification off the label. Transcribe what is printed — never infer a producer from the region. These are the owner\'s private photos, released for this one purpose: do not describe, store or reuse them for anything but completing this wine\'s identity.'
                : readableScans.length
                  ? 'This wine has already left the pending queue — you are looking at its label inside the correction window, to CHECK an identity somebody already wrote. If it is wrong, propose the correction (propose_wine_correction); do not describe, store or reuse this photo for anything else.'
                  // No scan (expired, or the wine never had one) but the wine
                  // publishes photos. Say plainly what they are, so the model
                  // does not read a marketing shot as a label transcription.
                  : 'No label scan is available for this wine — what you are looking at is its PUBLIC gallery, the same photos the wine page shows to anyone. Read them for what they can settle and no more: a gallery shot may not show the label at all. If the record looks wrong, propose the correction (propose_wine_correction) or ask the owners (ask_bottle_owner).',
            },
          }),
        },
        ...blocks,
      ],
    };
  },
});

registerTool({
  name: 'fix_pending_wine',
  title: 'Sommelier: complete a pending wine\'s identity',
  description:
    'Writes the corrected identity onto one wine in the pending-identity queue: producer, name, appellation, region, ' +
    'country, grapes, type. The moment producer AND name are both real the wine is PROMOTED automatically — it enters ' +
    'registry search, gets embedded, and its vintages enter the maturity queue — so send both in one call whenever ' +
    'you can. Region and country are plain NAMES resolved against the taxonomy (the country must already exist; grape ' +
    'synonyms resolve, unknown varieties are refused, never created). Refuses a wine that is no longer pending. This ' +
    'is SHARED registry data other users will see: base it on the label photo (get_pending_wine_images) or on the ' +
    'somm\'s own knowledge, never on a guess from the broken string. When the label genuinely prints no producer at ' +
    'all, identity_unavailable clears the row from the queue WITHOUT promoting it — read its description first. ' +
    'A wine with waiting_for_check: true (from a member\'s file) is NOT promoted by a complete producer and name: it ' +
    'is promoted only by identity_checked: true, sent alone when the record is right as it stands, or together with ' +
    'the corrections. If that answers a conflict naming an existing wine, the registry already holds it: call ' +
    'merge_pending_wine with that wine instead.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_pending_wines'),
    producer: z.string().min(1).max(FIELD_MAX).optional().describe('The winery exactly as printed on the label'),
    name: z.string().min(1).max(FIELD_MAX).optional().describe('The cuvée/wine name WITHOUT the producer in it'),
    appellation: z.string().max(FIELD_MAX).optional().describe(FIELD_DESCRIPTIONS.appellation + ' Empty string clears it.'),
    classification: z.string().max(FIELD_MAX).optional().describe(FIELD_DESCRIPTIONS.classification + ' Empty string clears it.'),
    region: z.string().max(FIELD_MAX).optional().describe(FIELD_DESCRIPTIONS.region + ' Empty string clears it.'),
    country: z.string().max(FIELD_MAX).optional().describe('Country NAME — must already exist in the taxonomy'),
    grapes: z.array(z.string().min(1).max(GRAPE_NAME_MAX)).max(GRAPES_MAX).optional()
      .describe('Variety NAMES, taxonomy-resolved (synonyms ok). Replaces the whole list.'),
    type: z.enum(WINE_TYPES).optional(),
    colour: z.enum(WINE_COLOURS).nullable().optional()
      .describe('Colour of a sparkling, dessert or fortified wine (e.g. a sparkling rosé). null clears it; dropped on red/white/rosé wines.'),
    cross_field_override: z.boolean().optional()
      .describe(
        'Force through a producer the cross-field rules refuse. Use ONLY when the label plainly prints this name ' +
        'and the TAXONOMY is what is wrong — a user-minted region or appellation that happens to carry a real ' +
        'producer\'s name, which would otherwise make that producer permanently unwritable. Never use it to push ' +
        'through a place or a grape you read off the label as a producer. Requires a producer in the same call, and ' +
        'is recorded in the audit log with the rules it overrode.'
      ),
    identity_checked: z.literal(true).optional()
      .describe(
        'For a wine with waiting_for_check: true only. You verified that this wine exists as the record states it ' +
        'after this call (producer, name, place, type): publish it. Send it alone to confirm the record unchanged, ' +
        'or with the fields you corrected. Do not send it for a record you could not verify; leave the wine ' +
        'waiting, or ask its owners (ask_bottle_owner). Only true is accepted: a check is not taken back, a ' +
        'published wine that turns out wrong is corrected like any registry wine.'
      ),
    identity_unavailable: z.boolean().optional()
      .describe(
        'LAST RESORT — only after asking the bottle\'s owner (ask_bottle_owner works on pending wines) and being ' +
        'told the label genuinely prints NO producer: a retailer own-label, a négociant clean-skin, an unlabelled ' +
        'bin-end. Takes the row OUT OF THE QUEUE without promoting it: the wine stays hidden from the registry, out ' +
        'of search, embeddings and the maturity queue, exactly as it is now. Never use it to clear a row you simply ' +
        'could not read — promoting a producerless wine would wreck deduplication (producer is 45% of the score), ' +
        'and guessing a producer is worse. Reversible: send false.'
      ),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    // snake_case in, the shared validator's field names out — ONE validator
    // with the REST PATCH, so the two surfaces cannot drift.
    const patch = {};
    if (args.identity_unavailable !== undefined) patch.identityUnavailable = args.identity_unavailable;
    if (args.identity_checked !== undefined) patch.identityChecked = args.identity_checked;
    if (args.producer !== undefined) patch.producer = args.producer;
    if (args.name !== undefined) patch.name = args.name;
    if (args.appellation !== undefined) patch.appellation = args.appellation;
    if (args.classification !== undefined) patch.classification = args.classification;
    if (args.region !== undefined) patch.regionName = args.region;
    if (args.country !== undefined) patch.countryName = args.country;
    if (args.grapes !== undefined) patch.grapeNames = args.grapes;
    if (args.type !== undefined) patch.type = args.type;
    if (args.colour !== undefined) patch.colour = args.colour;
    if (args.cross_field_override !== undefined) patch.crossFieldOverride = args.cross_field_override;

    const check = validatePendingFix(patch);
    if (!check.ok) return fail('invalid_input', check.error);

    const loaded = await loadPendingWine(args.wine_id);
    if (!loaded.ok) return fail(loaded.code, loaded.message);

    const applied = await applyPendingFix(loaded.wine, check.clean, ctx.user.id);
    if (!applied.ok) {
      // A duplicate names the wine it collided with, so the next call can be
      // the merge instead of a second attempt at the same fix.
      const twin = applied.duplicate;
      const hint = twin
        ? ` The existing wine is "${[twin.producer, twin.name].filter(Boolean).join(' — ')}" (wine_id ${twin.wineId}).` +
          (twin.published
            ? ' If this row is that wine, call merge_pending_wine with into_wine_id set to it.'
            : ' That wine is itself still pending: check or complete it first, then merge this one into it.')
        : '';
      return fail(applied.code, `${applied.message}${hint}`);
    }
    const { wine, promoted, diff, crossFieldOverridden } = applied;

    // Same audit action string as the REST PATCH — REST and MCP curation must
    // audit identically (this file's header rule), override metadata included.
    logAudit(ctx.req, 'wine.pending_fix', { type: 'wine', id: wine._id }, {
      fields: Object.keys(check.clean), diff, promoted, via: 'mcp',
      ...(crossFieldOverridden ? { crossFieldOverridden } : {}),
    });

    const unavailable = wine.identityUnavailable === true;
    // Still waiting for a check, with a producer: the fields were written and
    // the row stays until identity_checked is sent.
    const waiting = !promoted && wine.uncheckedIdentity === true && !!wine.producer;
    const envelope = {
      summary: promoted
        ? `${wine.producer} — ${wine.name}: identity completed, the wine is now live in the registry`
        : unavailable
          ? `${wine.name}: recorded as having no producer on the label — out of the queue, still not in the registry`
          : waiting
            ? `${wine.producer} — ${wine.name}: saved, still waiting for a check — it stays in the pending queue`
            : `${wine.name}: saved, but still missing a producer — it stays in the pending queue`,
      data: {
        wine_id: wine._id,
        promoted,
        still_pending: !promoted,
        identity_unavailable: unavailable,
        waiting_for_check: wine.uncheckedIdentity === true,
        producer: wine.producer || null,
        name: wine.name,
        appellation: wine.appellation || null,
        type: wine.type || null,
        ...(applied.grapeNames ? { grapes: applied.grapeNames } : {}),
        changed: Object.keys(diff),
        note: promoted
          ? 'The wine is now searchable, embedded, and its vintages are in the maturity queue.'
          : unavailable
            ? 'It stays hidden from the registry and its owner keeps their bottle. Send identity_unavailable: false to put it back in the queue.'
            : waiting
              ? 'Send identity_checked: true once the record is right to publish it.'
              : 'Send a producer to promote it — everything else is optional.',
      },
    };
    await logAction(ctx, {
      tool: 'fix_pending_wine',
      action: 'somm_pending_fix',
      detail: {
        wineId: String(wine._id), fields: Object.keys(check.clean), promoted,
        ...(crossFieldOverridden ? { crossFieldOverridden } : {}),
      },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'merge_pending_wine',
  title: 'Sommelier: a pending wine is one the registry already holds',
  description:
    'Ends a row of the pending queue that is the SAME wine as one already published: every bottle that points at the ' +
    'pending row (with its photos, reviews, wishlist entries and the rest) moves onto the published wine, and the ' +
    'pending row is removed. The typical case is a second member\'s file naming a wine another member\'s file ' +
    'already brought in: once the first is checked, fix_pending_wine identity_checked on the second answers a ' +
    'conflict naming the published wine, and this tool is the answer. Also right for any pending row whose label, ' +
    'once read, turns out to be a wine the registry has (find it with search_registry). The owners keep their ' +
    'bottles and everything that is theirs; only the wine their bottles point at changes. Use it only when the two ' +
    'are the same wine: same producer, same cuvée, same appellation. A different cuvée, colour or sweetness of the ' +
    'same producer is a different wine: complete or check the pending row instead. The target must be a published ' +
    'wine. Not undoable.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('The pending row, from list_pending_wines'),
    into_wine_id: objectId.describe('The published registry wine it is the same as — from the conflict message of fix_pending_wine, or search_registry'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    const loaded = await loadPendingWine(args.wine_id);
    if (!loaded.ok) return fail(loaded.code, loaded.message);
    const source = { name: loaded.wine.name, producer: loaded.wine.producer || null };

    const merged = await mergePendingInto(loaded.wine, args.into_wine_id, { req: ctx.req });
    if (!merged.ok) return fail(merged.code, merged.message);
    const { target, bottlesMoved } = merged;

    const label = [target.producer, target.name].filter(Boolean).join(' — ');
    const envelope = {
      summary: `${[source.producer, source.name].filter(Boolean).join(' — ')}: merged into ${label} (${bottlesMoved} bottle(s) moved)`,
      data: {
        merged_wine_id: args.wine_id,
        into_wine_id: String(target._id),
        into: { producer: target.producer || null, name: target.name },
        bottles_moved: bottlesMoved,
        note: 'The pending row is gone. Its owners\' bottles now show the published wine.',
      },
    };
    await logAction(ctx, {
      tool: 'merge_pending_wine',
      action: 'somm_pending_merge',
      detail: { wineId: String(args.wine_id), intoWineId: String(target._id), bottlesMoved },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
