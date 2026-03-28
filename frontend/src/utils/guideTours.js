/**
 * Interactive tour definitions for the AI Help Guide.
 *
 * Each tour is an array of steps. Each step highlights a UI element and shows
 * instructions. Steps can span pages — the tour engine waits for the correct
 * page before highlighting.
 *
 * Step shape:
 *   element      – CSS selector for the element to highlight
 *   title        – Short step title
 *   description  – Instruction text
 *   placement    – Popover position: 'top' | 'bottom' | 'left' | 'right'
 *   navigateTo   – (optional) auto-navigate here before showing step
 *   waitForPage  – (optional) regex/string the URL must match before showing
 *   clickAdvance – (optional) if true, clicking the element advances the tour
 */

const TOURS = {
  'create-cellar': { title: 'Create Your First Cellar', steps: [
    { element: '[data-guide="create-cellar"]', descKey: 'help.tour.createCellar', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
  ]},

  'add-bottle': { title: 'Add a Bottle to Your Cellar', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.addBottleSelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="add-bottle"]', descKey: 'help.tour.addBottleClick', placement: 'bottom', waitForPage: '/cellars/', clickAdvance: true },
  ]},

  'scan-label': { title: 'Scan a Wine Label', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.scanSelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="add-bottle"]', descKey: 'help.tour.scanAddBottle', placement: 'bottom', waitForPage: '/cellars/', clickAdvance: true },
    { element: '[data-guide="scan-label"]', descKey: 'help.tour.scanClick', placement: 'top', waitForPage: '/add-bottle', clickAdvance: true },
  ]},

  'use-wishlist': { title: 'Use the Wishlist', steps: [
    { element: '[data-guide="add-wishlist"]', descKey: 'help.tour.wishlistAdd', placement: 'bottom', navigateTo: '/wishlist', waitForPage: '/wishlist', clickAdvance: true },
  ]},

  'share-cellar': { title: 'Share a Cellar', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.shareCellarSelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="more-menu-btn"]', descKey: 'help.tour.shareMenu', placement: 'bottom', waitForPage: '/cellars/', clickAdvance: true },
    { element: '[data-guide="share-cellar"]', descKey: 'help.tour.shareClick', placement: 'left', waitForPage: '/cellars/', clickAdvance: true, noSkip: true },
  ]},

  'manage-racks': { title: 'Organize Bottles in Racks', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.racksSelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="more-menu-btn"]', descKey: 'help.tour.racksMenu', placement: 'bottom', waitForPage: '/cellars/', clickAdvance: true },
    { element: '[data-guide="rack-view"]', descKey: 'help.tour.racksClick', placement: 'left', waitForPage: '/cellars/', clickAdvance: true, noSkip: true },
  ]},

  'write-journal': { title: 'Write a Tasting Note', steps: [
    { element: '[data-guide="add-journal"]', descKey: 'help.tour.journalAdd', placement: 'bottom', navigateTo: '/journal', waitForPage: '/journal', clickAdvance: true },
  ]},

  'use-cellar-chat': { title: 'Chat with the AI Sommelier', steps: [
    { element: '[data-guide="chat-input"]', descKey: 'help.tour.cellarChatInput', placement: 'top', navigateTo: '/cellar-chat', waitForPage: '/cellar-chat', clickAdvance: true },
  ]},

  'view-statistics': { title: 'View Your Collection Analytics', steps: [
    { element: '[data-guide="nav-statistics"]', descKey: 'help.tour.statistics', placement: 'bottom', navigateTo: '/statistics', waitForPage: '/statistics', clickAdvance: true },
  ]},

  'configure-settings': { title: 'Configure Your Settings', steps: [
    { element: '[data-guide="nav-settings"]', descKey: 'help.tour.settings', placement: 'left', navigateTo: '/settings', waitForPage: '/settings', clickAdvance: true },
  ]},

  'use-restock': { title: 'Track Low Stock Wines', steps: [
    { element: '[data-guide="nav-restock"]', descKey: 'help.tour.restock', placement: 'bottom', navigateTo: '/restock', waitForPage: '/restock', clickAdvance: true },
  ]},

  'get-recommendations': { title: 'Get Wine Recommendations', steps: [
    { element: '[data-guide="nav-recommendations"]', descKey: 'help.tour.recommendations', placement: 'bottom', navigateTo: '/recommendations', waitForPage: '/recommendations', clickAdvance: true },
  ]},

  'build-3d-room': { title: 'Build a 3D Cellar Room', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.roomSelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="cellar-room"]', descKey: 'help.tour.roomOpen', placement: 'bottom', waitForPage: '/cellars/', clickAdvance: true },
    { element: '[data-guide="room-edit-mode"]', descKey: 'help.tour.roomEdit', placement: 'bottom', waitForPage: '/room', clickAdvance: true },
    { element: '[data-guide="room-add-rack"]', descKey: 'help.tour.roomAddRack', placement: 'bottom', waitForPage: '/room', clickAdvance: true },
    { element: '[data-guide="room-save"]', descKey: 'help.tour.roomSave', placement: 'bottom', waitForPage: '/room', clickAdvance: true },
  ]},

  'import-bottles': { title: 'Import Bottles from a File', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.importSelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="more-menu-btn"]', descKey: 'help.tour.importMenu', placement: 'bottom', waitForPage: '/cellars/', clickAdvance: true },
    { element: '[data-guide="cellar-import"]', descKey: 'help.tour.importClick', placement: 'left', waitForPage: '/cellars/', noSkip: true, clickAdvance: true },
  ]},

  'consume-bottle': { title: 'Mark a Bottle as Consumed', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.consumeSelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="bottle-consume"]', descKey: 'help.tour.consumeClick', placement: 'bottom', waitForPage: '/bottles/', noSkip: true, clickAdvance: true },
  ]},

  'write-review': { title: 'Write a Wine Review', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.reviewSelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="bottle-write-review"]', descKey: 'help.tour.reviewClick', placement: 'bottom', waitForPage: '/bottles/', clickAdvance: true, noSkip: true },
  ]},

  'suggest-wine': { title: 'Suggest a Wine for the Database', steps: [
    { element: '[data-guide="wine-request-create"]', descKey: 'help.tour.suggestWine', placement: 'bottom', navigateTo: '/wine-requests', waitForPage: '/wine-requests', clickAdvance: true },
  ]},

  'start-discussion': { title: 'Start a Community Discussion', steps: [
    { element: '[data-guide="discussion-create"]', descKey: 'help.tour.discussionCreate', placement: 'bottom', navigateTo: '/community/discussions', waitForPage: '/community/discussions', clickAdvance: true },
  ]},

  'view-history': { title: 'View Consumed Bottles', steps: [
    { element: '[data-guide="cellar-card"]', descKey: 'help.tour.historySelect', placement: 'bottom', navigateTo: '/cellars', waitForPage: '/cellars', clickAdvance: true },
    { element: '[data-guide="more-menu-btn"]', descKey: 'help.tour.historyMenu', placement: 'bottom', waitForPage: '/cellars/', clickAdvance: true },
    { element: '[data-guide="cellar-history"]', descKey: 'help.tour.historyClick', placement: 'left', waitForPage: '/cellars/', noSkip: true, clickAdvance: true },
  ]},
};

/**
 * Context-aware suggestions shown as quick-action chips in the help panel.
 * Keyed by URL prefix — the most specific match wins.
 */
// Suggestions use i18n keys — resolved with t() in GuideContext
const PAGE_SUGGESTIONS = {
  '/cellars/:id/add-bottle': ['help.sug.scanLabel', 'help.sug.searchWine', 'help.sug.missingWine'],
  '/cellars/:id/racks': ['help.sug.howRacks', 'help.sug.placeBottle', 'help.sug.nfcTags'],
  '/cellars/:id/room': ['help.sug.build3d', 'help.sug.addRacksRoom', 'help.sug.saveRoom'],
  '/cellars/:id/history': ['help.sug.whatHistory', 'help.sug.consumeBottle', 'help.sug.undoConsume'],
  '/cellars/:id/import': ['help.sug.importFormats', 'help.sug.formatCsv', 'help.sug.importFrom'],
  '/cellars/:id': ['help.sug.addBottle', 'help.sug.build3dCellar', 'help.sug.shareCellar'],
  '/cellars': ['help.sug.createCellar', 'help.sug.addFirstBottle', 'help.sug.shareCellar'],
  '/wishlist': ['help.sug.addWishlist', 'help.sug.moveWishlist', 'help.sug.priceAlerts'],
  '/journal': ['help.sug.writeTasting', 'help.sug.includeNotes', 'help.sug.journalPhotos'],
  '/statistics': ['help.sug.chartsShow', 'help.sug.cellarValue', 'help.sug.exportStats'],
  '/cellar-chat': ['help.sug.askSommelier', 'help.sug.foodPairing', 'help.sug.dinnerWine'],
  '/recommendations': ['help.sug.howRecommend', 'help.sug.improveRecommend', 'help.sug.recommendData'],
  '/restock': ['help.sug.howRestock', 'help.sug.restockSetup', 'help.sug.whatRestock'],
  '/settings': ['help.sug.changeCurrency', 'help.sug.enableNotif', 'help.sug.changeRating'],
  '/community': ['help.sug.writeReview', 'help.sug.startDiscussion', 'help.sug.followUsers'],
};

const DEFAULT_SUGGESTIONS = [
  'help.sug.getStarted',
  'help.sug.addFirstWine',
  'help.sug.whatFeatures',
];

/**
 * Keyword-based FAQ fallback (when AI is unavailable).
 * Messages use i18n keys — resolved with t() by the caller.
 */
const FAQ_ENTRIES = [
  { keywords: ['cellar', 'create', 'new', 'first', 'start', 'begin', 'källare', 'skapa', 'ny', 'börja'], tourId: 'create-cellar', messageKey: 'help.faq.createCellar' },
  { keywords: ['bottle', 'add', 'wine', 'put', 'flaska', 'lägg', 'vin'], tourId: 'add-bottle', messageKey: 'help.faq.addBottle' },
  { keywords: ['scan', 'label', 'camera', 'photo', 'picture', 'skanna', 'etikett', 'kamera', 'foto'], tourId: 'scan-label', messageKey: 'help.faq.scanLabel' },
  { keywords: ['wishlist', 'wish', 'want', 'buy', 'purchase', 'önskelista', 'köpa', 'önska'], tourId: 'use-wishlist', messageKey: 'help.faq.wishlist' },
  { keywords: ['share', 'invite', 'friend', 'collaborate', 'dela', 'bjud', 'vän'], tourId: 'share-cellar', messageKey: 'help.faq.share' },
  { keywords: ['rack', 'organize', 'grid', 'physical', 'layout', 'slot', 'ställ', 'organisera', 'fysisk'], tourId: 'manage-racks', messageKey: 'help.faq.racks' },
  { keywords: ['journal', 'tasting', 'note', 'taste', 'experience', 'dagbok', 'provning', 'anteckning'], tourId: 'write-journal', messageKey: 'help.faq.journal' },
  { keywords: ['chat', 'sommelier', 'pairing', 'food', 'drink', 'recommend', 'dinner', 'mat', 'dricka', 'middag'], tourId: 'use-cellar-chat', messageKey: 'help.faq.chat' },
  { keywords: ['statistics', 'stats', 'analytics', 'chart', 'graph', 'statistik', 'analys', 'diagram'], tourId: 'view-statistics', messageKey: 'help.faq.statistics' },
  { keywords: ['settings', 'config', 'currency', 'language', 'notification', 'inställning', 'valuta', 'språk'], tourId: 'configure-settings', messageKey: 'help.faq.settings' },
  { keywords: ['restock', 'low', 'stock', 'running out', 'alert', 'påfyllning', 'slut', 'lager'], tourId: 'use-restock', messageKey: 'help.faq.restock' },
  { keywords: ['recommendation', 'suggest', 'discover', 'rekommendation', 'föreslå', 'upptäck'], tourId: 'get-recommendations', messageKey: 'help.faq.recommendations' },
  { keywords: ['import', 'csv', 'bulk', 'spreadsheet', 'upload', 'importera', 'ladda'], tourId: 'import-bottles', messageKey: 'help.faq.import' },
  { keywords: ['3d', 'room', 'virtual', 'build', 'rum', 'bygg', 'virtuell'], tourId: 'build-3d-room', messageKey: 'help.faq.room' },
  { keywords: ['consume', 'drank', 'drunk', 'opened', 'finished', 'remove', 'konsumera', 'drack', 'öppna'], tourId: 'consume-bottle', messageKey: 'help.faq.consume' },
  { keywords: ['review', 'rate', 'opinion', 'recension', 'betygsätt'], tourId: 'write-review', messageKey: 'help.faq.review' },
  { keywords: ['request', 'missing', 'database', 'not found', 'saknas', 'databas', 'förfrågan'], tourId: 'suggest-wine', messageKey: 'help.faq.suggestWine' },
  { keywords: ['discussion', 'forum', 'thread', 'conversation', 'diskussion', 'tråd', 'konversation'], tourId: 'start-discussion', messageKey: 'help.faq.discussion' },
  { keywords: ['history', 'consumed', 'past', 'historik', 'konsumerad', 'tidigare'], tourId: 'view-history', messageKey: 'help.faq.history' },
  { keywords: ['nfc', 'tag', 'tagg'], tourId: null, messageKey: 'help.faq.nfc' },
  { keywords: ['help', 'how', 'what', 'feature', 'can', 'hjälp', 'hur', 'vad', 'funktion'], tourId: null, messageKey: 'help.faq.general' },
];

// Precompile regexes at module load (patterns are static)
const SORTED_PAGE_PATTERNS = Object.keys(PAGE_SUGGESTIONS)
  .sort((a, b) => b.length - a.length)
  .map(pattern => ({
    regex: new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '(/|$)'),
    suggestions: PAGE_SUGGESTIONS[pattern],
  }));

export function getSuggestionsForPage(pathname) {
  for (const { regex, suggestions } of SORTED_PAGE_PATTERNS) {
    if (regex.test(pathname)) return suggestions;
  }
  return DEFAULT_SUGGESTIONS;
}

/**
 * Keyword-based fallback when AI is unavailable.
 */
export function findFaqMatch(question) {
  const words = question.toLowerCase().split(/\s+/);
  let bestMatch = null;
  let bestScore = 0;

  for (const entry of FAQ_ENTRIES) {
    const score = entry.keywords.reduce((sum, kw) =>
      sum + (words.some(w => w.includes(kw) || kw.includes(w)) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  if (bestScore >= 1 && bestMatch) {
    return {
      messageKey: bestMatch.messageKey,
      tourId: bestMatch.tourId,
      suggestionKeys: DEFAULT_SUGGESTIONS,
    };
  }

  return {
    messageKey: 'help.faq.general',
    tourId: null,
    suggestionKeys: DEFAULT_SUGGESTIONS,
  };
}

export { TOURS };
export default TOURS;
