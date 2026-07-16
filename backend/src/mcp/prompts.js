// MCP prompts (plan §3, the third primitive): user-invokable workflow templates
// that turn the calling model into a competent Cellarion sommelier for one
// well-defined job. Each is a STATIC template — arguments are interpolated into
// text, the handler never touches the DB — so prompts are $0 and always fresh:
// the live data comes from the tools the template directs the model to call.
//
// Writing style: templates address the CALLING MODEL ("you"), name exact tool
// names, and end with how to present the answer. They must stay honest about
// write-safety: any step that mutates the cellar goes through preview/confirm.
const { z } = require('zod');
const { registerPrompt } = require('./registry');

// Every prompt returns one user-role message (the conventional shape for
// workflow prompts — the client appends it to the conversation).
const template = (text) => ({
  messages: [{ role: 'user', content: { type: 'text', text } }],
});

registerPrompt({
  name: 'sommelier_pairing',
  title: 'Pair wine from the cellar with a dish',
  description:
    'Full sommelier pairing workflow: find the bottles in the user\'s cellar that best match a dish, weigh readiness ' +
    'and occasion, and present two or three options with reasoning and serving advice.',
  scope: 'read',
  argsSchema: {
    dish: z.string().min(1).max(200).describe('The dish or menu to pair against'),
    preferences: z.string().max(300).optional().describe('Optional constraints: colour, budget, "nothing too heavy", …'),
  },
  handler: ({ dish, preferences }) => template([
    `Act as my personal sommelier. I am making: ${dish}.`,
    preferences ? `Preferences to respect: ${preferences}.` : null,
    '',
    'Workflow:',
    `1. Call pair_with_dish with the dish to get candidate bottles from MY cellar — each comes with its taste profile (body, tannin, acidity, sweetness, flavours, known food pairings), maturity status and rack position. The keyword matches are hints, not verdicts: apply your own pairing judgement over the structured profiles.`,
    '2. If the candidates feel thin, call what_should_i_open_tonight (optionally filtered by wine type) to widen the pool of ready-to-drink bottles.',
    '3. Choose 2–3 bottles, favouring: profile fit to the dish first, then bottles at peak or in their late window (drinking them tonight is a win), then an interesting contrast pick.',
    '4. Present each option with: the wine (name, producer, vintage), where it is (rack and position), WHY it works with this dish in one or two sentences, and serving advice (temperature, decanting, glass) from your own knowledge.',
    '5. End with your single top recommendation. Do not log or change anything — recommending is the job here.',
  ].filter((l) => l !== null).join('\n')),
});

registerPrompt({
  name: 'plan_tonight',
  title: 'Plan tonight\'s bottle',
  description:
    'Pick tonight\'s bottle end-to-end: consider open bottles first, then ready-to-drink candidates, tailor to the ' +
    'occasion, and (with the user\'s confirmation) log the choice once poured.',
  scope: 'read',
  argsSchema: {
    occasion: z.string().max(200).optional().describe('e.g. "Tuesday pasta night", "anniversary", "friends coming over"'),
    dish: z.string().max(200).optional().describe('What is being cooked or eaten, if known'),
  },
  handler: ({ occasion, dish }) => template([
    `Help me choose tonight's wine.${occasion ? ` The occasion: ${occasion}.` : ''}${dish ? ` We are having: ${dish}.` : ''}`,
    '',
    'Workflow:',
    dish
      ? '1. Call pair_with_dish with the dish AND what_should_i_open_tonight — pairing fit and readiness both matter tonight.'
      : '1. Call what_should_i_open_tonight to get ready-to-drink candidates with taste profiles, urgency and rack positions.',
    '2. Already-open bottles (Coravin / preserved) rank first — finishing an open bottle beats opening a new one. The tool flags them.',
    '3. Match the pick to the occasion: an everyday evening deserves an everyday bottle in its drinking window, not the trophy; a celebration justifies a peak-maturity highlight. Say which logic you applied.',
    '4. Recommend ONE bottle (plus a backup), each with: wine, vintage, rack position, why tonight is its night, and serving advice.',
    '5. If I confirm I opened or finished a bottle and consume tools are available, offer to log it with consume_bottle — always restate the exact wine and vintage and wait for my explicit yes first. If a tasting impression comes up, offer capture_tasting_note the same way.',
  ].join('\n')),
});

registerPrompt({
  name: 'cellar_health_check',
  title: 'Run a cellar health check',
  description:
    'Structured portfolio review: drinking pace vs buying pace, dead stock, bottles at risk of going past their ' +
    'window, and balance — ending in a short action list.',
  scope: 'read',
  argsSchema: {},
  handler: () => template([
    'Give my cellar a thorough health check, like a sommelier reviewing a client\'s collection.',
    '',
    'Workflow:',
    '1. Call cellar_health_check — it returns drinking pace vs intake, runway, per-type surplus analysis, dead-stock candidates, bottles past or near the end of their window, and aging bottles with no window data.',
    '2. Call cellar_stats if you need the wider portfolio picture (value, distribution) to put the findings in context.',
    '3. Interpret, do not just recite: Is the cellar growing faster than I drink it? Which wine types are piling up untouched? What must be drunk THIS year? Where am I flying blind (no drink windows)?',
    '4. Present: a one-paragraph verdict, then the concrete findings with the specific wines concerned (name, vintage), then a prioritised action list of at most 5 items (e.g. "open these 3 declining bottles this month", "set drink windows for the 12 unclassified Burgundies").',
    '5. Be honest about severity — a healthy cellar deserves to hear it is healthy.',
  ].join('\n')),
});

registerPrompt({
  name: 'plan_rack_layout',
  title: 'Reorganise a rack',
  description:
    'Guided rack reorganisation: review the current layout, choose an arrangement strategy with the user, preview the ' +
    'auto-arrange plan, and apply it only after explicit approval.',
  scope: 'write',
  argsSchema: {
    rack: z.string().max(120).optional().describe('Rack name or hint; omit to discuss all racks'),
  },
  handler: ({ rack }) => template([
    `Help me reorganise ${rack ? `my rack "${rack}"` : 'my wine racks'}.`,
    '',
    'Workflow:',
    '1. Call list_cellars, then list_racks to find the rack(s), then get_rack for the current slot-by-slot layout.',
    '2. Discuss with me which strategy fits how I actually grab bottles: "maturity" (drink-soonest in the first, most accessible slots — the default that prevents bottles dying in the back), "type" (group by colour/style), or "vintage" (chronological).',
    '3. Call auto_arrange in preview mode with the chosen strategy. Show me the returned move list in plain words ("2019 Barolo: slot 14 → 2") and how many bottles move.',
    '4. ONLY after I explicitly approve, call auto_arrange with mode "apply" and the preview_id. The rack updates in the app instantly; the returned move list is my guide for physically re-shelving the bottles.',
    '5. Remind me the arrangement is one undo_last (or in-app revert) away if I change my mind, and offer to read the final layout back with get_rack.',
  ].join('\n')),
});

registerPrompt({
  name: 'year_in_wine',
  title: 'My year in wine',
  description:
    'A warm, personal year-in-review: what was drunk, favourites and surprises, cellar growth, and journal moments — ' +
    'written from the user\'s real data.',
  scope: 'read',
  argsSchema: {
    year: z.string().regex(/^\d{4}$/, 'four-digit year').optional().describe('Defaults to the current year'),
  },
  handler: ({ year }) => {
    const y = year || String(new Date().getFullYear());
    return template([
      `Write my "${y} in wine" — a personal year-in-review of my cellar and drinking, in the voice of a friend who happens to be a sommelier.`,
      '',
      'Gather the material first:',
      `1. list_history with year ${y} — everything I drank, gifted or sold, with ratings and notes.`,
      '2. cellar_stats — pace, value and how the collection is distributed now.',
      `3. list_journal — tasting-journal entries; use the ones dated in ${y} for dinners, people and places worth retelling.`,
      '4. case_journey — how my multi-bottle cases evolved; a case drunk across the year tells a story of a wine changing.',
      '',
      'Then write the review with these beats: the numbers (bottles drunk, added, net direction of the cellar); the highlights (best-rated bottles, the surprise that overdelivered); the moments (journal dinners and occasions worth remembering); what changed in my taste or buying; and a closing look ahead (what is entering its window next year — cellar_stats urgency helps).',
      'Keep it warm and specific — name the actual wines and vintages, never invent one. If a section has no data, skip it gracefully rather than padding.',
    ].join('\n'));
  },
});
