/**
 * Single source of truth for all Cellarion feature documentation.
 *
 * Used by:
 * 1. The AI help guide system prompt (guideAI.js)
 * 2. The public /api/help endpoint (served to the Help page)
 *
 * Keep this file accurate — the AI will repeat whatever is here.
 * If a feature changes, update it here and both consumers get the fix.
 */

const sections = [
  {
    id: 'cellars',
    title: 'Cellars',
    route: '/cellars',
    summary: 'Create cellars to organize your wine collection.',
    details: [
      'Create cellars by clicking "+ New Cellar" and typing a name.',
      'Each cellar is a separate bottle collection.',
      'Open a cellar to see all its bottles. Filter by search, vintage, rating. Sort by newest/oldest/price/rating.',
      'Cellar overview tab shows: bottle count, total value, and links to Racks and Room View.',
    ],
    tourId: 'create-cellar',
  },
  {
    id: 'bottles',
    title: 'Bottles',
    route: null,
    summary: 'Add, manage, and track individual bottles in your cellars.',
    details: [
      'Add a bottle: click "+ Add Bottle" in a cellar. Two ways: search the wine database by name, OR scan a wine label with your phone camera (AI identifies the wine).',
      'Bottle detail page shows: wine name, producer, country, type, vintage, size, price paid, market value estimate, your rating, your notes, images, grape varieties, aging & maturity status, price evolution chart.',
      'Edit details: click "Edit Details" on the bottle page to change vintage, price, rating, notes, size.',
      'Upload photos: on the bottle detail page, you can add photos of the bottle or label. Background removal is automatic.',
      'Share a bottle: click the share icon on the bottle detail page to send a link to someone.',
      'Consume/remove: click "Remove Bottle" to mark it as consumed. Set the date you drank it. The bottle moves to the cellar\'s history.',
      'Write a review: on the bottle detail page, scroll down to write a community review.',
    ],
    tourId: 'add-bottle',
  },
  {
    id: 'label-scan',
    title: 'Label Scanning',
    route: null,
    summary: 'Scan a wine label with your camera to identify it automatically.',
    details: [
      'Available when adding a bottle — click the camera button.',
      'Take a photo of the wine label and the AI will read it and identify the wine.',
      'Works with most printed labels. Best results with clear, well-lit photos.',
      'After scanning, the wine details are pre-filled. Review and save.',
    ],
    tourId: 'scan-label',
  },
  {
    id: 'sharing',
    title: 'Sharing',
    route: null,
    summary: 'Share cellars with friends or send a link to a specific bottle.',
    details: [
      'Share a cellar: open a cellar → click the "..." menu → Share. Invite someone by email as Viewer (can browse) or Editor (can add/remove bottles). Only the cellar owner can share.',
      'Share a bottle: on any bottle detail page, click the share icon to send a direct link to someone.',
    ],
    tourId: 'share-cellar',
  },
  {
    id: 'racks',
    title: 'Racks',
    route: null,
    summary: 'Organize bottles in physical rack grids that match your real storage.',
    details: [
      'Access racks: open a cellar → click the "..." menu → Racks.',
      'Create racks with custom names and sizes (any number of rows × columns).',
      'Place bottles into rack slots by clicking an empty slot and selecting a bottle.',
      'Visual grid shows which slots are filled and which are empty.',
    ],
    tourId: 'manage-racks',
  },
  {
    id: 'room-view',
    title: '3D Room View',
    route: null,
    summary: 'Build a 3D virtual room that mirrors your real cellar.',
    details: [
      'Access: open a cellar → overview tab → Room View.',
      'Place and arrange your racks in a virtual 3D room.',
      'Click "Edit" to enter edit mode: drag racks, rotate them, add unplaced racks.',
      'Click "Save" to keep your layout. Come back anytime to rearrange.',
    ],
    tourId: 'build-3d-room',
  },
  {
    id: 'wishlist',
    title: 'Wishlist',
    route: '/wishlist',
    summary: 'Track wines you want to buy.',
    details: [
      'Click "+ Add Wine" to search the database and add a wine to your wishlist.',
      'Add notes (e.g. where to buy it) and set a target price.',
      'Filter tabs: Wanted / Bought / All.',
    ],
    tourId: 'use-wishlist',
  },
  {
    id: 'restock',
    title: 'Smart Restock',
    route: '/restock',
    summary: 'Automatic analysis of your consumption patterns vs inventory.',
    details: [
      'Shows: bottles consumed per year, purchased per year, net change, and years of runway.',
      'Breaks down stock levels by wine type, grape, region, country, and producer.',
      'Flags categories running low based on your actual drinking pace.',
      'Fully automatic — based on your consumption history. No manual setup needed.',
    ],
    tourId: 'use-restock',
  },
  {
    id: 'journal',
    title: 'Wine Journal',
    route: '/journal',
    summary: 'Write tasting notes and record your wine experiences.',
    details: [
      'Click "+ New Entry" to create a tasting note.',
      'Each entry records the wine, your impressions, and the occasion.',
      'Filter and search past entries.',
    ],
    tourId: 'write-journal',
  },
  {
    id: 'recommendations',
    title: 'Recommendations',
    route: '/recommendations',
    summary: 'Wine recommendations from friends and other users.',
    details: [
      'Other users can recommend wines to you.',
      'View their suggestions and add wines you like to your cellar or wishlist.',
    ],
    tourId: 'get-recommendations',
  },
  {
    id: 'cellar-chat',
    title: 'Cellar Chat',
    route: '/cellar-chat',
    summary: 'Chat with an AI sommelier who knows your entire cellar.',
    details: [
      'Ask for food pairings, what to drink tonight, or wine suggestions from your collection.',
      'The sommelier knows all your bottles, ratings, and notes.',
      'Usage limits depend on your plan (Free: 4/week, Basic: 20/day, Premium: 50/day).',
    ],
    tourId: 'use-cellar-chat',
  },
  {
    id: 'analytics',
    title: 'Analytics',
    route: '/statistics',
    summary: 'Charts and insights about your wine collection.',
    details: [
      'Collection value over time, bottles by country/type/grape/region.',
      'World map showing where your wines come from.',
      'Drink window overview: wines that are ready, still aging, or past peak.',
      'Export your stats as a shareable card image.',
      'Premium feature — available on the Premium plan.',
    ],
    tourId: 'view-statistics',
  },
  {
    id: 'community',
    title: 'Community',
    route: '/community',
    summary: 'Connect with other wine lovers through reviews and discussions.',
    details: [
      'Reviews tab: browse wine reviews from other users.',
      'Discussions tab: forum-style threads. Create new discussions, reply to others.',
      'Follow other users and view their profiles.',
    ],
    tourId: 'start-discussion',
  },
  {
    id: 'wine-requests',
    title: 'Wine Requests',
    route: '/wine-requests',
    summary: 'Suggest wines missing from the database.',
    details: [
      'Click "+ New Request" to suggest a wine.',
      'An admin reviews and adds approved wines so everyone can use them.',
    ],
    tourId: 'suggest-wine',
  },
  {
    id: 'import',
    title: 'Bulk Import',
    route: null,
    summary: 'Import your wine collection from a CSV or JSON file.',
    details: [
      'Access: open a cellar → "..." menu → Import Bottles.',
      'Upload a CSV or JSON file with your wine data.',
      'AI helps match imported wines to the database automatically.',
    ],
    tourId: 'import-bottles',
  },
  {
    id: 'settings',
    title: 'Settings',
    route: '/settings',
    summary: 'Customize your Cellarion experience.',
    details: [
      'Currency preference (used for prices and value calculations).',
      'Language selection.',
      'Rating scale: 5-star, 10-point, 20-point, or 100-point.',
      'Push notification preferences and device management.',
      'Profile: username and email.',
    ],
    tourId: 'configure-settings',
  },
  {
    id: 'history',
    title: 'Cellar History',
    route: null,
    summary: 'View all bottles you\'ve consumed from a cellar.',
    details: [
      'Access: open a cellar → "..." menu → History.',
      'Shows every bottle you\'ve marked as consumed, with dates.',
    ],
    tourId: 'view-history',
  },
  {
    id: 'other',
    title: 'Other Features',
    route: null,
    summary: 'Blog, plans, support, and NFC tags.',
    details: [
      'Blog (/blog): wine articles and guides.',
      'Plans (/plans): subscription tiers — Free, Basic, Premium.',
      'Support (/support): submit support tickets for help.',
      'NFC tags: attach NFC tags to racks — scan with your phone to open the rack directly.',
    ],
    tourId: null,
  },
];

const tours = [
  { id: 'create-cellar', label: 'Create a new cellar' },
  { id: 'add-bottle', label: 'Add a bottle to a cellar' },
  { id: 'scan-label', label: 'Scan a wine label with camera' },
  { id: 'use-wishlist', label: 'Use the wishlist' },
  { id: 'share-cellar', label: 'Share a cellar with someone' },
  { id: 'manage-racks', label: 'Open the rack view' },
  { id: 'write-journal', label: 'Write a tasting note' },
  { id: 'use-cellar-chat', label: 'Chat with the AI sommelier' },
  { id: 'view-statistics', label: 'View analytics' },
  { id: 'configure-settings', label: 'Change settings' },
  { id: 'use-restock', label: 'View restock info' },
  { id: 'get-recommendations', label: 'View recommendations' },
  { id: 'build-3d-room', label: 'Build a 3D room layout' },
  { id: 'import-bottles', label: 'Import from CSV/JSON' },
  { id: 'consume-bottle', label: 'Mark a bottle as consumed' },
  { id: 'write-review', label: 'Write a wine review' },
  { id: 'suggest-wine', label: 'Suggest a missing wine' },
  { id: 'start-discussion', label: 'Start a discussion' },
  { id: 'view-history', label: 'View consumed bottles' },
];

module.exports = { sections, tours };
