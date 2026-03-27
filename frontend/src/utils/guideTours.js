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
const PAGE_SUGGESTIONS = {
  '/cellars/:id/add-bottle': [
    'How do I scan a wine label?',
    'How do I search for a wine?',
    'What if my wine isn\'t in the database?',
  ],
  '/cellars/:id/racks': [
    'How do racks work?',
    'How do I place a bottle in a slot?',
    'Can I print NFC tags for racks?',
  ],
  '/cellars/:id/room': [
    'How do I build my 3D room?',
    'How do I add racks to the room?',
    'How do I save my room layout?',
  ],
  '/cellars/:id/history': [
    'What is cellar history?',
    'How do I mark a bottle as consumed?',
    'Can I undo a consumption?',
  ],
  '/cellars/:id/import': [
    'What file formats are supported?',
    'How do I format my CSV?',
    'Can I import from Vivino or CellarTracker?',
  ],
  '/cellars/:id': [
    'How do I add a bottle?',
    'How do I build a 3D cellar room?',
    'How do I share this cellar?',
  ],
  '/cellars': [
    'How do I create a cellar?',
    'How do I add my first bottle?',
    'How do I share a cellar?',
  ],
  '/wishlist': [
    'How do I add wines to my wishlist?',
    'How do I move a wishlist wine to my cellar?',
    'Can I set price alerts?',
  ],
  '/journal': [
    'How do I write a tasting note?',
    'What should I include in my notes?',
    'Can I add photos to journal entries?',
  ],
  '/statistics': [
    'What do these charts show?',
    'How is cellar value calculated?',
    'Can I export my stats?',
  ],
  '/cellar-chat': [
    'What can I ask the sommelier?',
    'How do I get food pairing suggestions?',
    'Can it recommend wines for a dinner?',
  ],
  '/recommendations': [
    'How do recommendations work?',
    'How do I improve my recommendations?',
    'What data does it use?',
  ],
  '/restock': [
    'How do restock alerts work?',
    'How do I set up an alert?',
    'What wines should I restock?',
  ],
  '/settings': [
    'How do I change my currency?',
    'How do I enable notifications?',
    'How do I change my rating scale?',
  ],
  '/community': [
    'How do I write a review?',
    'How do I start a discussion?',
    'How do I follow other users?',
  ],
};

const DEFAULT_SUGGESTIONS = [
  'How do I get started?',
  'How do I add my first wine?',
  'What features does Cellarion have?',
];

/**
 * Keyword-based FAQ fallback for when AI is unavailable.
 */
const FAQ_ENTRIES = [
  { keywords: ['cellar', 'create', 'new', 'first', 'start', 'begin'], tourId: 'create-cellar', message: 'I can show you how to create your first cellar! Click "Show me" to start the guided tour.' },
  { keywords: ['bottle', 'add', 'wine', 'put'], tourId: 'add-bottle', message: 'Adding a bottle is easy! I can walk you through it step by step.' },
  { keywords: ['scan', 'label', 'camera', 'photo', 'picture'], tourId: 'scan-label', message: 'You can scan a wine label with your camera to automatically identify it! Let me show you.' },
  { keywords: ['wishlist', 'wish', 'want', 'buy', 'purchase'], tourId: 'use-wishlist', message: 'The Wishlist helps you track wines you want to buy. Let me show you how!' },
  { keywords: ['share', 'invite', 'friend', 'collaborate', 'together'], tourId: 'share-cellar', message: 'You can share a cellar with friends or family! I\'ll show you how.' },
  { keywords: ['rack', 'organize', 'grid', 'physical', 'layout', 'slot'], tourId: 'manage-racks', message: 'Racks help you map your physical wine storage. You can create racks in any size! Let me show you.' },
  { keywords: ['journal', 'tasting', 'note', 'taste', 'experience', 'diary'], tourId: 'write-journal', message: 'The Journal is perfect for recording your tasting experiences. Want me to show you?' },
  { keywords: ['chat', 'sommelier', 'pairing', 'food', 'drink', 'recommend', 'dinner'], tourId: 'use-cellar-chat', message: 'Cellar Chat is an AI sommelier that knows your entire collection! Let me show you how.' },
  { keywords: ['statistics', 'stats', 'analytics', 'chart', 'graph', 'value', 'insight'], tourId: 'view-statistics', message: 'The Analytics page shows beautiful charts about your collection. Let me give you a tour!' },
  { keywords: ['settings', 'config', 'currency', 'language', 'notification', 'preference'], tourId: 'configure-settings', message: 'You can customize your experience in Settings. Let me show you!' },
  { keywords: ['restock', 'low', 'stock', 'running out', 'alert'], tourId: 'use-restock', message: 'Restock tracking helps you know when your favorites are running low. Let me show you!' },
  { keywords: ['recommendation', 'suggest', 'discover', 'new wine'], tourId: 'get-recommendations', message: 'Get AI-powered wine recommendations based on your collection! Let me show you.' },
  { keywords: ['import', 'csv', 'bulk', 'spreadsheet', 'upload'], tourId: 'import-bottles', message: 'You can import bottles in bulk from a CSV or JSON file! Let me show you how.' },
  { keywords: ['3d', 'room', 'virtual', 'build', 'layout', 'arrange'], tourId: 'build-3d-room', message: 'You can build a 3D virtual room that mirrors your real cellar! Place and arrange your racks visually. Let me show you.' },
  { keywords: ['consume', 'drank', 'drunk', 'opened', 'finished', 'remove'], tourId: 'consume-bottle', message: 'You can mark a bottle as consumed and keep a record of when you drank it. Let me show you!' },
  { keywords: ['review', 'rate', 'opinion', 'community review'], tourId: 'write-review', message: 'You can write reviews that other users see in the community feed! Let me show you how.' },
  { keywords: ['request', 'missing', 'database', 'not found', 'suggest wine'], tourId: 'suggest-wine', message: 'If a wine is missing from our database, you can suggest it! An admin will review and add it.' },
  { keywords: ['discussion', 'forum', 'thread', 'conversation', 'post'], tourId: 'start-discussion', message: 'Start a discussion with other wine lovers in the community! Let me show you.' },
  { keywords: ['history', 'consumed', 'past', 'drank before'], tourId: 'view-history', message: 'Your cellar history shows every bottle you\'ve consumed. Let me show you where to find it!' },
  { keywords: ['nfc', 'tag'], tourId: null, message: 'You can attach NFC tags to your racks! When scanned with a phone, they open the rack view directly. Set this up in the Rack view of a cellar.' },
  { keywords: ['help', 'how', 'what', 'feature', 'can'], tourId: null, message: 'Cellarion helps you manage your wine collection! You can create cellars, add bottles (even by scanning labels), organize with racks, build a 3D room, get AI recommendations, track your wishlist, write tasting notes, and much more. What would you like to know about?' },
];

/**
 * Get contextual suggestions for the current page.
 */
export function getSuggestionsForPage(pathname) {
  // Try most specific match first (routes with params)
  const sortedKeys = Object.keys(PAGE_SUGGESTIONS).sort((a, b) => b.length - a.length);
  for (const pattern of sortedKeys) {
    // Convert :param patterns to regex-like matching
    const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '(/|$)');
    if (regex.test(pathname)) {
      return PAGE_SUGGESTIONS[pattern];
    }
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
      message: bestMatch.message,
      tourId: bestMatch.tourId,
      suggestions: DEFAULT_SUGGESTIONS,
    };
  }

  return {
    message: 'I\'m not sure about that, but I can help you with many things! Try asking about creating cellars, adding bottles, scanning labels, or using the wishlist.',
    tourId: null,
    suggestions: DEFAULT_SUGGESTIONS,
  };
}

export { TOURS };
export default TOURS;
