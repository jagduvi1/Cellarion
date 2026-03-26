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
  'create-cellar': {
    title: 'Create Your First Cellar',
    steps: [
      {
        element: '[data-guide="nav-cellars"]',
        title: 'Go to My Cellars',
        description: 'Click here to open your cellars page where all your wine collections live.',
        placement: 'bottom',
        navigateTo: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="create-cellar"]',
        title: 'Create a New Cellar',
        description: 'Type a name for your cellar (like "Kitchen Rack" or "Wine Fridge") and click Create. Each cellar is a separate collection of bottles.',
        placement: 'bottom',
        waitForPage: '/cellars',
      },
    ],
  },

  'add-bottle': {
    title: 'Add a Bottle to Your Cellar',
    steps: [
      {
        element: '[data-guide="nav-cellars"]',
        title: 'Open Your Cellars',
        description: 'Start by navigating to your cellars.',
        placement: 'bottom',
        navigateTo: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="cellar-card"]',
        title: 'Select a Cellar',
        description: 'Click on the cellar where you want to add a bottle.',
        placement: 'bottom',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="add-bottle"]',
        title: 'Add a Bottle',
        description: 'Click "Add Bottle" to start adding a wine. You can search our database of thousands of wines or scan a label with your camera!',
        placement: 'bottom',
        waitForPage: '/cellars/',
      },
    ],
  },

  'scan-label': {
    title: 'Scan a Wine Label',
    steps: [
      {
        element: '[data-guide="nav-cellars"]',
        title: 'Open Your Cellars',
        description: 'First, go to your cellars.',
        placement: 'bottom',
        navigateTo: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="cellar-card"]',
        title: 'Select a Cellar',
        description: 'Choose the cellar where you want to add the scanned wine.',
        placement: 'bottom',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="add-bottle"]',
        title: 'Go to Add Bottle',
        description: 'Click "Add Bottle" to open the add bottle page where you can scan a label.',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
      {
        element: '[data-guide="scan-label"]',
        title: 'Scan Your Label',
        description: 'Click the camera button to take a photo of your wine label. The AI will identify the wine automatically!',
        placement: 'top',
        waitForPage: '/add-bottle',
      },
    ],
  },

  'use-wishlist': {
    title: 'Use the Wishlist',
    steps: [
      {
        element: '[data-guide="nav-wishlist"]',
        title: 'Open Your Wishlist',
        description: 'Click here to go to your Wishlist — a place to track wines you want to buy.',
        placement: 'bottom',
        navigateTo: '/wishlist',
        clickAdvance: true,
      },
      {
        element: '[data-guide="add-wishlist"]',
        title: 'Add a Wine',
        description: 'Click "Add to Wishlist" to search for a wine you want to remember. You can add notes about where to buy it and set a target price!',
        placement: 'bottom',
        waitForPage: '/wishlist',
      },
    ],
  },

  'share-cellar': {
    title: 'Share a Cellar',
    steps: [
      {
        element: '[data-guide="nav-cellars"]',
        title: 'Open Your Cellars',
        description: 'Go to your cellars to pick one to share.',
        placement: 'bottom',
        navigateTo: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="cellar-card"]',
        title: 'Select a Cellar',
        description: 'Click on the cellar you want to share with someone.',
        placement: 'bottom',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="share-cellar"]',
        title: 'Share This Cellar',
        description: 'Click the share button to invite someone by email. You can give them view-only or editor access!',
        placement: 'left',
        waitForPage: '/cellars/',
      },
    ],
  },

  'manage-racks': {
    title: 'Organize Bottles in Racks',
    steps: [
      {
        element: '[data-guide="nav-cellars"]',
        title: 'Open Your Cellars',
        description: 'Start by going to your cellars.',
        placement: 'bottom',
        navigateTo: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="cellar-card"]',
        title: 'Select a Cellar',
        description: 'Choose the cellar you want to organize.',
        placement: 'bottom',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="rack-view"]',
        title: 'Open Rack View',
        description: 'Click "Racks" to see your physical rack layout. You can create racks in different sizes to match your real wine storage!',
        placement: 'bottom',
        waitForPage: '/cellars/',
      },
    ],
  },

  'write-journal': {
    title: 'Write a Tasting Note',
    steps: [
      {
        element: '[data-guide="nav-journal"]',
        title: 'Open Your Journal',
        description: 'Click here to go to your Tasting Journal — your personal wine diary.',
        placement: 'bottom',
        navigateTo: '/journal',
        clickAdvance: true,
      },
      {
        element: '[data-guide="add-journal"]',
        title: 'Add an Entry',
        description: 'Click here to write a new tasting note. Record the wine, your impressions, aromas, flavors, and how it made you feel!',
        placement: 'bottom',
        waitForPage: '/journal',
      },
    ],
  },

  'use-cellar-chat': {
    title: 'Chat with the AI Sommelier',
    steps: [
      {
        element: '[data-guide="nav-cellar-chat"]',
        title: 'Open Cellar Chat',
        description: 'Click here to open a conversation with your personal AI sommelier. It knows your entire collection!',
        placement: 'bottom',
        navigateTo: '/cellar-chat',
        clickAdvance: true,
      },
      {
        element: '[data-guide="chat-input"]',
        title: 'Ask Anything',
        description: 'Try asking "What should I drink tonight with pasta?" or "Which of my wines is at peak maturity?" — the sommelier will recommend wines from your cellar!',
        placement: 'top',
        waitForPage: '/cellar-chat',
      },
    ],
  },

  'view-statistics': {
    title: 'View Your Collection Analytics',
    steps: [
      {
        element: '[data-guide="nav-statistics"]',
        title: 'Open Analytics',
        description: 'Click here to see detailed charts and insights about your wine collection — value trends, country distribution, drink windows, and more.',
        placement: 'bottom',
        navigateTo: '/statistics',
        clickAdvance: true,
      },
    ],
  },

  'configure-settings': {
    title: 'Configure Your Settings',
    steps: [
      {
        element: '[data-guide="nav-settings"]',
        title: 'Open Settings',
        description: 'Click the gear icon to customize your experience — currency, language, rating scale, notification preferences, and your profile.',
        placement: 'left',
        navigateTo: '/settings',
        clickAdvance: true,
      },
    ],
  },

  'use-restock': {
    title: 'Track Low Stock Wines',
    steps: [
      {
        element: '[data-guide="nav-restock"]',
        title: 'Open Restock',
        description: 'Click here to see wines that are running low in your cellar. You can set alerts to be notified when it\'s time to restock!',
        placement: 'bottom',
        navigateTo: '/restock',
        clickAdvance: true,
      },
    ],
  },

  'get-recommendations': {
    title: 'Get Wine Recommendations',
    steps: [
      {
        element: '[data-guide="nav-recommendations"]',
        title: 'Open Recommendations',
        description: 'Click here to get AI-powered wine recommendations based on your collection and taste preferences.',
        placement: 'bottom',
        navigateTo: '/recommendations',
        clickAdvance: true,
      },
    ],
  },
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
  '/cellars/:id': [
    'How do I add a bottle?',
    'How do I share this cellar?',
    'How do I organize bottles in racks?',
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
  { keywords: ['import', 'csv', 'bulk', 'spreadsheet'], tourId: null, message: 'You can import bottles in bulk from a CSV file! Open a cellar, then look for the "Import" option. It supports wine names, vintages, prices, and more.' },
  { keywords: ['nfc', 'tag'], tourId: null, message: 'You can attach NFC tags to your racks! When scanned with a phone, they open the rack view directly. Set this up in the Rack view of a cellar.' },
  { keywords: ['help', 'how', 'what', 'feature', 'can'], tourId: null, message: 'Cellarion helps you manage your wine collection! You can create cellars, add bottles (even by scanning labels), organize with racks, get AI recommendations, track your wishlist, write tasting notes, and much more. What would you like to know about?' },
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
