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
        element: '[data-guide="create-cellar"]',
        description: 'Click the "+ New Cellar" button. Give it a name like "Kitchen Rack" or "Wine Fridge" — each cellar is a separate collection.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
      },
    ],
  },

  'add-bottle': {
    title: 'Add a Bottle to Your Cellar',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'First, click on the cellar where you want to add a bottle.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="add-bottle"]',
        description: 'Now click "Add Bottle" — you can search our database of thousands of wines or scan a label with your camera!',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
    ],
  },

  'scan-label': {
    title: 'Scan a Wine Label',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'First, select the cellar where you want to add the scanned wine.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="add-bottle"]',
        description: 'Click "Add Bottle" to open the add bottle page.',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
      {
        element: '[data-guide="scan-label"]',
        description: 'Now click the camera button to take a photo of your wine label. The AI will read the label and identify the wine automatically!',
        placement: 'top',
        waitForPage: '/add-bottle',
      },
    ],
  },

  'use-wishlist': {
    title: 'Use the Wishlist',
    steps: [
      {
        element: '[data-guide="add-wishlist"]',
        description: 'Click "Add Wine" to search for a wine you want to buy. You can add notes about where to find it and set a target price!',
        placement: 'bottom',
        navigateTo: '/wishlist',
        waitForPage: '/wishlist',
      },
    ],
  },

  'share-cellar': {
    title: 'Share a Cellar',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'Click on the cellar you want to share with someone.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="more-menu-btn"]',
        description: 'Click the menu button (three dots) to see more options.',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
      {
        element: '[data-guide="share-cellar"]',
        description: 'Click "Share" to invite someone by email. You can give them view-only or editor access!',
        placement: 'left',
        waitForPage: '/cellars/',
        clickAdvance: true,
        noSkip: true,
      },
    ],
  },

  'manage-racks': {
    title: 'Organize Bottles in Racks',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'Click on the cellar you want to organize.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="more-menu-btn"]',
        description: 'Click the menu button (three dots) to find the Racks option.',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
      {
        element: '[data-guide="rack-view"]',
        description: 'Click "Racks" to see your physical rack layout. You can create racks in different sizes to match your real wine storage!',
        placement: 'left',
        waitForPage: '/cellars/',
        clickAdvance: true,
        noSkip: true,
      },
    ],
  },

  'write-journal': {
    title: 'Write a Tasting Note',
    steps: [
      {
        element: '[data-guide="add-journal"]',
        description: 'Click "New Entry" to write a tasting note. Record the wine, your impressions, aromas, flavors, and how it made you feel!',
        placement: 'bottom',
        navigateTo: '/journal',
        waitForPage: '/journal',
      },
    ],
  },

  'use-cellar-chat': {
    title: 'Chat with the AI Sommelier',
    steps: [
      {
        element: '[data-guide="chat-input"]',
        description: 'Try asking "What should I drink tonight with pasta?" or "Which of my wines is at peak maturity?" — the sommelier will recommend wines from your cellar!',
        placement: 'top',
        navigateTo: '/cellar-chat',
        waitForPage: '/cellar-chat',
      },
    ],
  },

  'view-statistics': {
    title: 'View Your Collection Analytics',
    steps: [
      {
        element: '[data-guide="nav-statistics"]',
        description: 'Here you can see detailed charts and insights about your wine collection — value trends, country distribution, drink windows, and more.',
        placement: 'bottom',
        navigateTo: '/statistics',
        waitForPage: '/statistics',
      },
    ],
  },

  'configure-settings': {
    title: 'Configure Your Settings',
    steps: [
      {
        element: '[data-guide="nav-settings"]',
        description: 'Here you can customize your experience — currency, language, rating scale, notification preferences, and your profile.',
        placement: 'left',
        navigateTo: '/settings',
        waitForPage: '/settings',
      },
    ],
  },

  'use-restock': {
    title: 'Track Low Stock Wines',
    steps: [
      {
        element: '[data-guide="nav-restock"]',
        description: 'Here you can see wines that are running low in your cellar. You can set alerts to be notified when it\'s time to restock!',
        placement: 'bottom',
        navigateTo: '/restock',
        waitForPage: '/restock',
      },
    ],
  },

  'get-recommendations': {
    title: 'Get Wine Recommendations',
    steps: [
      {
        element: '[data-guide="nav-recommendations"]',
        description: 'Here you can get AI-powered wine recommendations based on your collection and taste preferences.',
        placement: 'bottom',
        navigateTo: '/recommendations',
        waitForPage: '/recommendations',
      },
    ],
  },

  'build-3d-room': {
    title: 'Build a 3D Cellar Room',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'First, select the cellar you want to build a 3D room for.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="cellar-room"]',
        description: 'Click "Room View" to enter the 3D room builder. Here you can place your racks in a virtual room that mirrors your real cellar!',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
      {
        element: '[data-guide="room-edit-mode"]',
        description: 'Click "Edit" to start arranging your room. In edit mode you can drag racks, rotate them, and position everything.',
        placement: 'bottom',
        waitForPage: '/room',
        clickAdvance: true,
      },
      {
        element: '[data-guide="room-add-rack"]',
        description: 'Click "Add Rack" to place your racks into the 3D room. Drag them around to match your real layout.',
        placement: 'bottom',
        waitForPage: '/room',
        clickAdvance: true,
      },
      {
        element: '[data-guide="room-save"]',
        description: 'When you\'re happy with the arrangement, click "Save" to keep your room layout!',
        placement: 'bottom',
        waitForPage: '/room',
        clickAdvance: true,
      },
    ],
  },

  'import-bottles': {
    title: 'Import Bottles from a File',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'Select the cellar where you want to import bottles.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="more-menu-btn"]',
        description: 'Click the menu button (three dots) to find the Import option.',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
      {
        element: '[data-guide="cellar-import"]',
        description: 'Click "Import Bottles" to open the bulk import tool. You can upload a CSV or JSON file!',
        placement: 'left',
        waitForPage: '/cellars/',
        noSkip: true,
        clickAdvance: true,
      },
    ],
  },

  'consume-bottle': {
    title: 'Mark a Bottle as Consumed',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'First, open the cellar that has the bottle you drank, then click on the bottle.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="bottle-consume"]',
        description: 'Click this button to mark the bottle as consumed. You can set the date you drank it and add tasting notes. It moves to your cellar history!',
        placement: 'bottom',
        waitForPage: '/bottles/',
        noSkip: true,
        clickAdvance: true,
      },
    ],
  },

  'write-review': {
    title: 'Write a Wine Review',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'Open a cellar, then click on the bottle you want to review.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="bottle-write-review"]',
        description: 'Click "Write a Review" to share your thoughts with the community. Your review appears on the wine\'s page and in the community feed!',
        placement: 'bottom',
        waitForPage: '/bottles/',
        clickAdvance: true,
        noSkip: true,
      },
    ],
  },

  'suggest-wine': {
    title: 'Suggest a Wine for the Database',
    steps: [
      {
        element: '[data-guide="wine-request-create"]',
        description: 'Click here to suggest a wine that\'s missing from our database. An admin will review it and add it so everyone can use it!',
        placement: 'bottom',
        navigateTo: '/wine-requests',
        waitForPage: '/wine-requests',
      },
    ],
  },

  'start-discussion': {
    title: 'Start a Community Discussion',
    steps: [
      {
        element: '[data-guide="discussion-create"]',
        description: 'Click "New Discussion" to start a conversation with other wine lovers. Share discoveries, ask questions, or discuss pairings!',
        placement: 'bottom',
        navigateTo: '/community/discussions',
        waitForPage: '/community/discussions',
      },
    ],
  },

  'view-history': {
    title: 'View Consumed Bottles',
    steps: [
      {
        element: '[data-guide="cellar-card"]',
        description: 'Select the cellar whose history you want to see.',
        placement: 'bottom',
        navigateTo: '/cellars',
        waitForPage: '/cellars',
        clickAdvance: true,
      },
      {
        element: '[data-guide="more-menu-btn"]',
        title: 'Open the Menu',
        description: 'Click the menu button to find the History option.',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
      {
        element: '[data-guide="more-menu-btn"]',
        description: 'Click the menu button (three dots) to find the History option.',
        placement: 'bottom',
        waitForPage: '/cellars/',
        clickAdvance: true,
      },
      {
        element: '[data-guide="cellar-history"]',
        description: 'Click "History" to see all bottles you\'ve consumed from this cellar, with dates and tasting notes.',
        placement: 'left',
        waitForPage: '/cellars/',
        noSkip: true,
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
