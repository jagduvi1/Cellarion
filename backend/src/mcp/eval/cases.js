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
  { id: 'portfolio-value', prompt: 'What is my wine collection worth right now?', expect: { tool: 'cellar_stats' } },
  {
    id: 'drink-soon-urgency',
    prompt: 'Which of my wines should I drink soon, before they go past their peak?',
    expect: { anyOf: ['cellar_stats', 'search_bottles'] },
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
];

module.exports = { CASES };
