// Golden tool-selection cases (plan §9): natural phrasings a real user would
// type into their assistant, with the tool a well-instructed model SHOULD
// reach for first. `anyOf` marks cases where more than one first move is
// legitimately correct (e.g. resolving a cellar id before a per-cellar tool).
// Keep prompts realistic — the eval measures our NAMES + DESCRIPTIONS, not the
// model. When a case fails consistently, fix the tool description, not the case.

const CASES = [
  { id: 'cellars-overview', prompt: 'What cellars do I have?', expect: { tool: 'list_cellars' } },
  {
    id: 'own-a-wine',
    prompt: 'Do I have any Barolo left?',
    expect: { tool: 'search_bottles' },
    args: (a) => /barolo/i.test(a.query || ''),
  },
  {
    id: 'where-is-bottle',
    prompt: 'Where in my cellar is the Cloudy Bay stored?',
    expect: { anyOf: ['search_bottles', 'get_rack'] },
  },
  { id: 'drank-recently', prompt: 'What did I drink last month?', expect: { tool: 'list_history' } },
  {
    id: 'portfolio-value',
    prompt: 'What is my wine collection worth right now?',
    // value_report (Phase 3) answers collection-worth questions at least as
    // well as the stats overview — both are correct first moves.
    expect: { anyOf: ['cellar_stats', 'value_report'] },
  },
  {
    id: 'drink-soon-urgency',
    prompt: 'Which of my wines should I drink soon, before they go past their peak?',
    // Phase 3 added two tools that answer this directly (urgency ladder in the
    // health check; readiness ranking in tonight's candidates).
    expect: { anyOf: ['cellar_stats', 'search_bottles', 'cellar_health_check', 'what_should_i_open_tonight'] },
  },
  {
    id: 'rack-layout',
    prompt: 'Show me how my racks are laid out.',
    expect: { anyOf: ['list_racks', 'list_cellars'] }, // may need a cellar_id first — both are correct first moves
  },
  {
    id: 'registry-lookup',
    prompt: 'Does Cellarion know the wine Château Margaux?',
    expect: { tool: 'search_registry' },
    args: (a) => /margaux/i.test(a.query || ''),
  },
  {
    id: 'more-like-this',
    prompt: 'I love my Felsina Chianti — find me wines similar in style to it.',
    expect: { anyOf: ['find_similar_wines', 'search_bottles'] }, // may resolve the bottle id first
  },
  { id: 'wishlist', prompt: "What's on my wine wishlist?", expect: { tool: 'list_wishlist' } },
  { id: 'journal', prompt: 'Read me my latest tasting journal entries.', expect: { tool: 'list_journal' } },
  {
    id: 'what-is-cellarion',
    prompt: 'What exactly is Cellarion, and is it open source?',
    expect: { tool: 'get_source_info' },
  },
  {
    id: 'support-the-project',
    // The supporter-awareness path (hosted only): a grateful user asking how
    // to give back should land on get_source_info, whose funding block (and
    // the instructions line) carries the voluntary-supporter answer. A no-tool
    // answer is acceptable — the instructions alone already contain the URL.
    prompt: 'I love this app — is it really free? How can I support the project?',
    expect: { anyOf: ['get_source_info'], orNone: true },
  },
  {
    id: 'consumed-vintage-year',
    prompt: 'Which bottles did I consume during 2025?',
    expect: { tool: 'list_history' },
    args: (a) => Number(a.year) === 2025 || a.year === undefined, // year arg preferred, plain call acceptable
  },
  { id: 'no-tool-smalltalk', prompt: 'Hi! How are you today?', expect: { none: true } },


  // ── Phase 3: sommelier intelligence ──────────────────────────────────────
  {
    id: 'health-check',
    prompt: 'Give my cellar a health check — am I buying faster than I drink?',
    expect: { anyOf: ['cellar_health_check', 'cellar_stats'] },
  },
  {
    id: 'dead-stock',
    prompt: 'Which wines am I hoarding but never actually drinking?',
    expect: { tool: 'cellar_health_check' },
  },
  {
    id: 'open-tonight',
    prompt: 'What should I open tonight?',
    expect: { tool: 'what_should_i_open_tonight' },
  },
  {
    id: 'pair-dinner',
    prompt: "I'm cooking duck confit — which bottle from my cellar goes best with it?",
    expect: { anyOf: ['pair_with_dish', 'what_should_i_open_tonight'] },
    args: (a) => a.dish === undefined || /duck/i.test(a.dish),
  },
  {
    id: 'collection-gaps',
    prompt: 'What is missing from my wine collection? Help me round it out.',
    expect: { anyOf: ['find_gaps', 'cellar_stats'] },
  },
  {
    id: 'value-gains',
    prompt: 'Are any of my bottles worth a lot more than I paid for them?',
    expect: { tool: 'value_report' },
  },
  {
    id: 'case-development',
    prompt: 'How is my case of 2016 Léoville Barton developing? Should I speed up drinking it?',
    expect: { anyOf: ['case_journey', 'search_bottles'] }, // may resolve the wine/bottle id first
  },
  {
    id: 'semantic-mood',
    prompt: 'Find me a wine that tastes like a walk through a pine forest after rain.',
    expect: { anyOf: ['semantic_search_wines', 'search_registry'] },
  },
  {
    id: 'log-tasting-note',
    prompt: 'Note on the Rioja I just drank: leather and dried cherries, better than last bottle. 4 stars.',
    expect: { anyOf: ['capture_tasting_note', 'search_bottles', 'list_history'] }, // likely resolves the bottle first
  },
  {
    id: 'rearrange-rack',
    prompt: 'Rearrange my main rack so the bottles I should drink first end up on top.',
    expect: { anyOf: ['auto_arrange', 'list_racks', 'list_cellars'] }, // may resolve ids first; apply still needs a preview
  },

  // ── Phase 4: proactive sommelier ─────────────────────────────────────────
  {
    id: 'any-alerts',
    prompt: 'Anything in my cellar that needs my attention right now?',
    expect: { anyOf: ['list_notifications', 'cellar_health_check'] },
  },
  {
    id: 'climate-check',
    prompt: 'Is the temperature in my cellar okay?',
    expect: { anyOf: ['climate_status', 'list_cellars'] }, // may resolve the cellar id first
  },
  {
    id: 'clear-alerts',
    prompt: "Thanks, I've seen all those alerts — clear them.",
    expect: { tool: 'mark_notification_read' },
    args: (a) => a.all === true || a.notification_id !== undefined,
  },

  // ── Phase 6: public registry/guides tools (also on the personal surface) ──
  {
    id: 'when-to-drink-vintage',
    prompt: 'When should a 2016 Barolo Monfortino be drunk? Is it ready now?',
    expect: { anyOf: ['drink_window_for', 'search_registry'] }, // may resolve the wine id first
  },
  {
    id: 'storage-guide',
    prompt: 'Do you have a guide on how to store wine properly long-term?',
    expect: { tool: 'list_guides' },
  },
  {
    id: 'attach-photo',
    prompt: 'Here is the label photo for that Barolo — https://example.com/barolo-label.jpg — put it on the bottle.',
    expect: { anyOf: ['attach_bottle_image', 'search_bottles'] }, // may resolve the bottle id first
    args: (a) => a.image_url === undefined || /barolo-label/.test(a.image_url),
  },

  // ── Phase 7: self-service account tools ──
  {
    id: 'read-preferences',
    prompt: 'What currency and rating scale is my account set to?',
    expect: { tool: 'get_preferences' },
  },
  {
    id: 'change-currency',
    prompt: 'Change my display currency to Swedish kronor.',
    // Imperative — a well-behaved model calls the tool; get_preferences first is
    // also a defensible move (read the current value before changing it).
    expect: { anyOf: ['update_preferences', 'get_preferences'] },
  },
  {
    id: 'read-profile',
    prompt: 'What does my public Cellarion profile say about me?',
    expect: { tool: 'get_profile' },
  },
  {
    id: 'update-bio',
    prompt: 'Set my profile bio to: Barolo obsessive and weekend sommelier.',
    expect: { anyOf: ['update_profile', 'get_profile'] },
  },
  {
    id: 'report-a-bug',
    prompt: "Please report a bug to the Cellarion team: the 3D room view won't load on my phone.",
    expect: { tool: 'create_support_ticket' },
  },
  {
    id: 'support-replied-yet',
    // The read side of the ticket flow. list_notifications is also a fair
    // first move — the admin reply lands as a notification too.
    prompt: 'Did Cellarion support ever answer the bug ticket I filed last week?',
    expect: { anyOf: ['list_my_tickets', 'list_notifications'] },
  },
  {
    id: 'follow-up-on-ticket',
    // Continuing the conversation — the model may need the ticket_id first.
    prompt: 'Reply to my open support ticket: thanks for the fix, but the room view still crashes on Firefox.',
    expect: { anyOf: ['reply_to_ticket', 'list_my_tickets'] },
  },
  {
    id: 'request-missing-wine',
    prompt: "Cellarion doesn't have this wine and I don't know the producer — ask the team to add it. Here's the page: https://www.systembolaget.se/produkt/123",
    expect: { anyOf: ['request_wine_addition', 'resolve_wine', 'search_registry'] },
  },

  // ── Writes (Phase 2, consume/write scope) ────────────────────────────────
  // Many writes legitimately open with a READ to resolve an id from the user's
  // words ("my 2015 Barolo" → search_bottles → consume), so those cases accept
  // the lookup-first move via anyOf. The registry-safe add is the exception:
  // the instructions teach resolve_wine FIRST, and that two-step is the whole
  // point of registry integrity, so we assert it directly.
  {
    id: 'consume-a-bottle',
    prompt: 'I opened and finished my 2015 Barolo tonight — mark it as drunk.',
    expect: { anyOf: ['consume_bottle', 'search_bottles'] },
  },
  {
    id: 'restore-a-bottle',
    prompt: 'That Chablis I logged as consumed is actually still in my rack — put it back.',
    expect: { anyOf: ['restore_bottle', 'search_bottles', 'list_history'] },
  },
  {
    id: 'undo-last-change',
    prompt: 'Actually, undo the last change you just made to my cellar.',
    // A careful model may confirm which change before reversing it.
    expect: { tool: 'undo_last', orNone: true },
  },
  {
    id: 'add-a-bottle-resolve-first',
    prompt: 'Add a bottle of 2019 Château Pontet-Canet to my cellar.',
    // The registry-safe two-step means the model must NOT jump straight to
    // add_bottle: it either resolves the wine first (resolve_wine) or resolves
    // the target cellar first (list_cellars). Both are correct; add_bottle as
    // the first move — skipping dedup — is the failure this catches.
    expect: { anyOf: ['resolve_wine', 'list_cellars'] },
  },
  {
    id: 'update-a-price',
    prompt: 'Change the price on my 2016 Rioja to 45 euros.',
    expect: { anyOf: ['update_bottle', 'search_bottles'] },
  },
  {
    id: 'add-a-case-bulk',
    prompt: 'I just bought a case of 12 bottles of Domaine du Cayron Gigondas 2020 — add them all.',
    // Valid first moves: preview the batch (bulk_add), dedup-resolve the wine
    // (resolve_wine), or resolve the target cellar (list_cellars). A careful
    // model may also confirm first. The failure to catch is a WRONG tool.
    expect: { anyOf: ['bulk_add', 'resolve_wine', 'list_cellars'], orNone: true },
  },
  {
    id: 'create-a-cellar',
    prompt: "Create a new empty cellar called 'Everyday Reds'.",
    expect: { tool: 'create_cellar', orNone: true },
  },
  {
    id: 'create-a-rack',
    prompt: 'Add a new rack with 6 columns and 12 rows to my cellar.',
    expect: { anyOf: ['create_rack', 'list_cellars'] }, // may resolve a cellar_id first
  },
  {
    id: 'place-a-bottle',
    prompt: 'Put my Cloudy Bay into slot 4 of the top rack.',
    expect: { anyOf: ['place_bottle', 'search_bottles', 'get_rack', 'list_racks'] },
  },
  {
    id: 'move-a-bottle',
    prompt: 'Move my 2015 Barolo over to my other cellar.',
    // Needs both the bottle and the destination cellar, so resolving either
    // first (search_bottles / list_cellars) or moving directly are all valid.
    expect: { anyOf: ['move_bottle', 'search_bottles', 'list_cellars'] },
  },
  {
    id: 'unplace-a-bottle',
    prompt: 'Take my Cloudy Bay out of its rack slot but keep it in the cellar.',
    expect: { anyOf: ['unplace_bottle', 'search_bottles'] },
  },

  // ── Data portability (export tools) ──────────────────────────────────────
  {
    id: 'export-cellar',
    prompt: 'Export my whole wine collection so I can back it up somewhere.',
    expect: { anyOf: ['export_cellar', 'get_account_export'] },
  },
  {
    id: 'gdpr-account-export',
    prompt: 'Give me a full GDPR export of everything you have about me.',
    expect: { anyOf: ['get_account_export', 'export_cellar'] },
  },

  // ── Sommelier curation (role-gated: judged only when a somm/admin token is
  // used, auto-SKIPPED for a normal user whose token can't see these tools). ──
  {
    id: 'somm-maturity-queue',
    prompt: 'As the sommelier, is anything sitting in my maturity review queue right now?',
    expect: { tool: 'list_maturity_queue' },
  },
  {
    id: 'somm-set-maturity',
    // Name a concrete wine so the model has a real first move (look it up to get
    // the wine id, then set its window). Phrased as a per-wine data edit — not
    // "drink window", which the model conflates with the maturity-review queue.
    prompt: 'As sommelier, for the wine Penfolds Grange 2015, set the earliest drinking year to 2025 and the latest to 2035.',
    expect: { anyOf: ['set_vintage_maturity', 'search_registry'], orNone: true },
  },
  {
    id: 'somm-price-queue',
    prompt: 'Which wines are waiting for a price update in the tracking queue?',
    expect: { tool: 'list_price_tracking_requests' },
  },
  {
    id: 'somm-set-price',
    prompt: 'As sommelier, record a market price of 120 USD for Sassicaia 2016.',
    expect: { anyOf: ['set_vintage_price', 'search_registry'], orNone: true },
  },
];

module.exports = { CASES };
