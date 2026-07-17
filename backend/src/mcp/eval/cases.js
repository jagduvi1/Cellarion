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
];

module.exports = { CASES };
