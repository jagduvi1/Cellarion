/**
 * The server's copy of the Help text.
 *
 * Used by:
 * 1. GET /api/help (routes/help.js). The Help page takes each section's
 *    `route` from here for its "Go to …" links. It matches a section to its
 *    own key by lowercasing the id and dropping everything but letters and
 *    digits, so `on-order` here is `onOrder` there.
 * 2. The crawler page /og/help (routes/og.js), which prints every section.
 *
 * It says what the Help page says (`help.sections.*` in
 * frontend/src/locales/en/translation.json), section for section; the words
 * may differ a little. When a screen changes, update both. The frontend's
 * utils/helpSections.test.js checks that the two list the same sections.
 *
 * `route` is null when a section has no page of its own. Pick lists keep
 * null on purpose: the Help page offers their page only to members who see
 * it in the menu, which a route here would override. Their text holds
 * whichever state their flag is in (it changes without a deploy).
 */

const { PLANS } = require('../config/plans');

// "Supporter ($2/mo), Patron ($5/mo) and Benefactor ($10/mo)", from the plans
// themselves, so a price change cannot leave the help text behind.
const tierLine = () => {
  const tiers = ['supporter', 'patron', 'benefactor'].map(k => `${PLANS[k].label} ($${PLANS[k].price}/mo)`);
  return `${tiers.slice(0, -1).join(', ')} and ${tiers[tiers.length - 1]}`;
};

const sections = [
  {
    id: 'cellars',
    title: 'Cellars',
    route: '/cellars',
    summary: 'Create cellars to organize your wine collection.',
    details: [
      'Create a cellar: on My Cellars, tap "+ New Cellar" and type a name.',
      'Each cellar is a separate bottle collection.',
      'Open a cellar to see its bottles. Search by name, producer, grape or region, narrow the list with Filters, and sort it by date added, name, vintage, price, number of bottles or maturity.',
      'The strip at the top of a cellar switches between its views: Bottles, Overview, Racks, Room View, History and Cellar Book. Overview shows the number of bottles and wines, the total value and the average price.',
      'The ⋮ menu at the top right holds the cellar\'s actions: Edit Cellar, Set Color, Share, Wine Lists, Import Bottles, Export, Audit Log, Recently deleted and Delete Cellar. Some are for the cellar\'s owner only.',
    ],
    tourId: 'create-cellar',
  },
  {
    id: 'bottles',
    title: 'Bottles',
    route: null,
    summary: 'Add, manage, and track individual bottles in your cellars.',
    details: [
      'Add a bottle: open a cellar and tap "Add Bottle" (on a phone, the round + button). Search the shared wine registry by name, or point your camera at the label or the barcode.',
      'The bottle page shows: wine name, producer, country, type, vintage, size, price paid, market value estimate, your rating, your notes, images, grape varieties, aging and maturity status, and a price evolution chart.',
      'Edit details: tap "Edit Details" on the bottle page to change vintage, price, rating, notes and size.',
      'Upload photos: on the bottle page, add photos of the bottle or label. The background is removed automatically.',
      'Share a bottle: tap the share icon on the bottle page to send a link to someone.',
      'Drink or give away: tap "Drink" on the bottle page. In "Take out of the cellar", choose why it left (drank it, gifted, sold or other) and the date. The bottle is then "Taken out" and moves to the cellar\'s History.',
      'Write a review: on the bottle page, scroll down to write a community review.',
      'Bought wine that has not arrived yet? Add it on order: see the "Bottles on order" section.',
      'Saved a bottle under the wrong wine? Open the bottle, tap the ⋮ menu and choose "Change wine…": search for the right wine and the bottle moves there, keeping its dates, price, notes, rating, rack slot and history.',
      'The bottle page\'s ⋮ menu also has "Add more bottles", "Move to another cellar" and "Added by mistake?". A bottle added by mistake goes to Recently deleted, where you can bring it back for 30 days.',
    ],
    tourId: 'add-bottle',
  },
  {
    id: 'vintage-page',
    title: 'Wine and vintage page',
    route: null,
    summary: 'One page for each wine and vintage in a cellar, whether you have one bottle or twenty.',
    details: [
      'Tap a wine in your cellar\'s bottle list to open it. The page shows the wine, then this vintage, then each of your bottles with its rack slot, size, price and shop.',
      '"Drink a bottle" takes one bottle out of the cellar. If you have more than one, pick which; the others stay as they are.',
      '"Edit vintage" sets the drink window and notes on all your bottles of this vintage at once. A field that differs between the bottles is left as it is unless you fill it in.',
      '"Add bottle" starts adding another bottle of this wine and vintage.',
      'On a phone, these buttons sit in a bar at the bottom of the screen.',
      'The ⋮ menu holds the rest: Add a photo of this vintage, Add barcode, Suggest a fix to the wine, Report a problem with this wine, Recommend to a friend and Open in the shared registry.',
      'Tap "View bottle" to open one bottle\'s own page. Bottles already taken out and your other vintages of the wine are under "Drunk and other vintages".',
      'Fold away the parts you do not need with the arrow beside their title. Cellarion remembers this on your account, and the bottle page folds the same parts.',
    ],
    tourId: null,
  },
  {
    id: 'open-bottle',
    title: 'Open bottles and glasses',
    route: null,
    summary: 'Keep track of a bottle you have opened but not finished.',
    details: [
      'On the bottle page, tap "Open bottle…" and choose how you will keep it: Coravin, inert gas spray, vacuum stopper, sparkling stopper, or recorked. That sets the date to drink it by.',
      'An open bottle stays in your cellar, and in its rack slot, until you finish it.',
      '"Pour a glass" counts each glass and shows about how many are left. "Undo pour" takes the last one back.',
      'When it is empty, tap "Finish bottle…" to take it out of the cellar as usual.',
      'Opened it by mistake? "Opened by mistake?" closes it again and removes its pours.',
      'In a rack, tap a bottle and then "Drink": the dialog also offers "Just a glass — keep the bottle", which opens the bottle and pours one glass.',
    ],
    tourId: null,
  },
  {
    id: 'label-scan',
    title: 'Label Scanning',
    route: null,
    summary: 'Scan a wine label with your camera to identify it automatically.',
    details: [
      'When adding a bottle, tap "Start Camera" under "Scan the wine label".',
      'Take a photo of the wine label; Cellarion reads it and identifies the wine.',
      'Works with most printed labels. Best results with clear, well-lit photos.',
      'After scanning, the wine details are pre-filled. Review and save.',
      'If the front label leaves gaps, you may be asked to scan the back label too.',
    ],
    tourId: 'scan-label',
  },
  {
    id: 'barcode',
    title: 'Barcodes',
    route: null,
    summary: 'Find a wine by the barcode on its bottle, and help the next person find it.',
    details: [
      'When the camera is open in Add Bottle, it also reads barcodes. If members have saved that barcode before, the wine is found at once, without a label photo.',
      'A barcode nobody has saved yet is kept with your bottle: photograph the front label as usual, and the next member who scans it finds the wine straight away.',
      'Chose the wine by name instead? Tap "Scan barcode" under the wine to add its barcode.',
      'For a bottle already in your cellar: open it and tap ⋮ → "Add barcode". You can also type the numbers under the stripes (8, 12 or 13 digits).',
      'On the wine and vintage page, ⋮ → "Add barcode" saves it on your bottles of that vintage, except other bottle sizes and bottles that have a barcode of their own.',
    ],
    tourId: null,
  },
  {
    id: 'on-order',
    title: 'Bottles on order',
    route: null,
    summary: 'Wine you have bought that has not been delivered yet, such as en primeur or a pre-order.',
    details: [
      'When adding a bottle, tap "Add notes, occasion, purchase info" and tick "Not delivered yet (on order)". Add the month you expect it, if you know it.',
      'Bottles on order stay out of the cellar\'s counts, racks and drinking suggestions. A bar above the cellar\'s bottle list shows how many are on order and opens the On order page.',
      'On the On order page, each delivery has "Mark as arrived", "Change month" and "Change quantity".',
      'Mark as arrived: say how many came and on which date. They become ordinary bottles in the cellar, ready to place in a rack.',
      'Change quantity: type the new number of bottles on the order. New bottles get the order\'s price, shop and expected month. With fewer, the most recently added go to Recently deleted, where you can bring them back for 30 days.',
      'Once the expected month is over, Cellarion asks whether the wine has arrived.',
      'Order cancelled? Open the bottle and tap ⋮ → "Order cancelled? Remove it".',
      'A scanned prepayment receipt or pro-forma invoice brings its wines in on order too.',
    ],
    tourId: null,
  },
  {
    id: 'select-mode',
    title: 'Select several bottles',
    route: null,
    summary: 'Move, take out, reserve or delete many bottles at once.',
    details: [
      'In your cellar\'s bottle list, tap "Select" (or press and hold a bottle) and tick the bottles. Ticking a stack ticks all its bottles.',
      '"Select all" ticks every bottle loaded in the list.',
      'Then choose an action: Move (to another cellar), Purchase, Drink, Reserve, Drink window, List (add to a wine list) or Delete. If you have pick lists, Pick list is there too.',
      'Purchase and Drink window change only what you fill in. Anything left blank stays as it is on each bottle.',
      'Drink takes the bottles out of the cellar with one date. Rate them one by one later in the History.',
      'Reserve marks bottles as spoken for: give a person or occasion, a year, or both. Reserved bottles are left out of drink suggestions, and Drink leaves them alone unless you tick "Take the reserved ones out too".',
      'Delete moves the bottles to Recently deleted; from 10 bottles you type the number to confirm. Undo brings them all back at once.',
      'Select is for the cellar\'s owner, in one cellar at a time.',
    ],
    tourId: null,
  },
  {
    id: 'recently-deleted',
    title: 'Recently deleted',
    route: null,
    summary: 'Deleted bottles wait here for 30 days, so you can bring them back.',
    details: [
      'Open it from the cellar\'s ⋮ menu → Recently deleted.',
      'Bottles end up here when you delete them with Select → Delete, remove one with "Added by mistake?", or take some off an order with "Change quantity".',
      'Tap "Restore" on a bottle, or restore a whole batch at once. A restored bottle comes back with its photos and notes, and goes back to its rack slot if that slot is still free.',
      'After 30 days they are deleted for good, with their photos.',
      'A bottle you drank, gave away or sold is not deleted: you find it in the cellar\'s History.',
    ],
    tourId: null,
  },
  {
    id: 'sharing',
    title: 'Sharing',
    route: null,
    summary: 'Share cellars with friends or send a link to a specific bottle.',
    details: [
      'Share a cellar: open the cellar and tap ⋮ → Share. Invite someone by email as Viewer (can browse bottles and racks) or Editor (can also add and remove bottles). Only the cellar owner can share.',
      'Share a bottle: on any bottle page, tap the share icon to send a direct link to someone.',
      '"Make owner" hands the whole cellar, with its bottles and racks, to someone you share it with. You stay on as an editor, but you cannot take it back.',
    ],
    tourId: 'share-cellar',
  },
  {
    id: 'racks',
    title: 'Racks',
    route: null,
    summary: 'Organize bottles in physical rack grids that match your real storage.',
    details: [
      'Open a cellar and tap Racks in the strip at the top.',
      'Choose a rack type: grid, X-rack, honeycomb, A-frame, stack, modular cube, open shelf or wine cabinet.',
      'Give each rack a name, size and layout that matches your real storage.',
      'Place bottles into rack slots by tapping an empty slot and choosing a bottle.',
      'The rack shows which slots are filled and which are empty.',
    ],
    tourId: 'manage-racks',
  },
  {
    id: 'room-view',
    title: '3D Room View',
    route: null,
    summary: 'Build a 3D virtual room that mirrors your real cellar.',
    details: [
      'Open a cellar and tap Room View in the strip at the top.',
      'Place and arrange your racks in a virtual 3D room.',
      'Click "Edit" to enter edit mode: drag racks, rotate them, add unplaced racks.',
      'Click "Save" to keep your layout. Come back anytime to rearrange.',
      'In edit mode, click a rack to select it; Shift+click adds or removes more racks. The arrow keys move the selected racks 5 cm at a time.',
      'Ctrl+Z undoes your last change and Ctrl+Y (or Ctrl+Shift+Z) redoes it; on a Mac, use Cmd. Esc cancels Stack or Link while you are choosing a rack.',
    ],
    tourId: 'build-3d-room',
  },
  {
    id: 'pick-lists',
    title: 'Pick lists',
    route: null,
    summary: 'The bottles you are about to fetch, with the cellar, rack and slot of each. An early-access preview, not yet shown to everyone.',
    details: [
      'Not in your menu yet? Pick lists may still be in early access: turn on Settings → Early access → "Show me new features before everyone else" to try them.',
      'Add bottles: in your cellar, tap Select, tick the bottles and choose "Pick list". Or tap ⋮ → "Add to pick list" on a bottle\'s page or a wine and vintage page.',
      'Choose a list, or "New pick list…" to start one and give it a name, for example Saturday dinner.',
      'Your lists are under Pick lists in the menu. Each one shows where every bottle sits, in the order you walk past them.',
      'Tick bottles off as you pick them. "Print" gives a clean sheet to take with you.',
      'The "Mark … picked as drunk" button takes all the ticked bottles out of the cellar in one go.',
      'Deleting a list leaves its bottles in your cellar.',
    ],
    tourId: null,
  },
  {
    id: 'wine-lists',
    title: 'Wine lists',
    route: null,
    summary: 'Turn a cellar\'s bottles into a wine menu: a printable PDF and a web page.',
    details: [
      'Open a cellar and tap ⋮ → Wine Lists, or Wine Lists on the Overview tab. Only the cellar\'s owner can make them.',
      'Tap "New Wine List" and name it. Start with every wine in the cellar, priced from what you paid, or pick the wines yourself.',
      'The editor\'s tabs: Wines (which wines, their sections and prices), Preview, Branding (name, tagline, logo), Layout (style, font, page size and display options), Dashboard (stock, revenue and margin) and Share.',
      '"Preview PDF" shows the printable menu. Changes are saved as you go.',
      'Publish it under Share to get a public link; the PDF then carries a QR code that opens the web menu. "Unpublish" takes it down again.',
      'From the bottle list, Select → List adds the ticked bottles to a wine list.',
    ],
    tourId: null,
  },
  {
    id: 'wishlist',
    title: 'Wishlist',
    route: '/wishlist',
    summary: 'Track wines you want to buy.',
    details: [
      'Tap "+ Add Wine" to search the wine registry and add a wine to your wishlist.',
      'Add notes (for example where to buy it) and set a target price.',
      'Filter tabs: Wanted / Bought / All.',
    ],
    tourId: 'use-wishlist',
  },
  {
    id: 'restock',
    title: 'Smart Restock',
    route: '/restock',
    summary: 'Compares how fast you drink with what is left in your cellar.',
    details: [
      'Shows how many bottles you drink and buy per year, the net change, and how many years your stock lasts at that pace.',
      'Breaks down stock levels by wine type, grape, region, country, and producer.',
      'Flags categories running low based on your actual drinking pace.',
      'Fully automatic, based on the bottles you have taken out. No setup needed.',
    ],
    tourId: 'use-restock',
  },
  {
    id: 'journal',
    title: 'Wine Journal',
    route: '/journal',
    summary: 'Write tasting notes and record your wine experiences.',
    details: [
      'Tap "+ New Entry" to create a tasting note.',
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
    summary: 'Chat with a sommelier who knows your entire cellar.',
    details: [
      'Ask for food pairings, what to drink tonight, or wine suggestions from your collection.',
      'The sommelier knows all your bottles, ratings, and notes.',
      'Everyone gets the same number of questions per day, free like every feature. The count at the top shows how many you have asked today.',
    ],
    tourId: 'use-cellar-chat',
  },
  {
    id: 'analytics',
    title: 'Statistics',
    route: '/statistics',
    summary: 'Charts and insights about your wine collection.',
    details: [
      'Collection value over time, bottles by country/type/grape/region.',
      'World map showing where your wines come from.',
      'Drink window overview: how many bottles are not ready, early, at their peak, late or declining.',
      '"Share Card" turns your stats into an image you can share.',
      'Free for everyone, like every feature in Cellarion.',
      'Want your own tables and charts? The Dashboard builds them: see the "Dashboard" section.',
    ],
    tourId: 'view-statistics',
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    route: '/dashboard',
    summary: 'Build your own tables and charts from your bottles. Statistics is the ready-made overview.',
    details: [
      'Open Dashboard in the top menu (on a computer), from the link on the Statistics page, or with the table button above a cellar\'s bottle list.',
      'The Table tab lists your bottles. Choose which ones (Active bottles, Bottles taken out or All bottles) and which cellars, narrow them with "+ Filter", and pick the columns.',
      '"Summarize" groups the bottles, for example by region or vintage, and adds totals or averages such as price or rating. Show the result as a table, bars, a donut or a line.',
      '"Views" has ready-made views such as "Where my money sits" and "Drink soon (my windows)". "Save view" keeps your own, and a star keeps the ones you use most at the top.',
      '"Add to dashboard" pins the table or chart on a dashboard. The Boards tab shows your dashboards; "+ New dashboard" starts another.',
      '"Export CSV" downloads the table as a spreadsheet file.',
      'Prices are converted to the currency you chose in Settings.',
    ],
    tourId: null,
  },
  {
    id: 'community',
    title: 'Community',
    route: '/community',
    summary: 'Connect with other wine lovers through reviews and discussions.',
    details: [
      'Reviews tab: browse wine reviews from other users.',
      'Discussions tab: forum-style threads. Start a discussion or reply to others.',
      'Follow other users and view their profiles.',
    ],
    tourId: 'start-discussion',
  },
  {
    id: 'wine-requests',
    title: 'Wine Requests',
    route: '/wine-requests',
    summary: 'Suggest wines missing from the registry.',
    details: [
      'Tap "+ New Request" to suggest a wine.',
      'An admin reviews and adds approved wines so everyone can use them.',
    ],
    tourId: 'suggest-wine',
  },
  {
    id: 'import',
    title: 'Bulk Import',
    route: null,
    summary: 'Bring bottles in from a file, another app, or a photo of a receipt.',
    details: [
      'Open the cellar and tap ⋮ → Import Bottles.',
      'Upload a file: a Cellarion export (JSON), Vivino, CellarTracker, Oeno by Vintec, Ploc, or any CSV with Wine, Producer and Vintage columns.',
      'Imported wines are matched to the registry automatically, and you check the matches before anything is added.',
      'Bought several bottles? "Scan a receipt or order" (in beta) reads photos or a PDF of the receipt into rows you check the same way.',
      'To recreate whole cellars, with their racks and layout, from a Cellarion export, use "Import a cellar export" in Settings → Your data.',
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
      'Rating scale: 5-star, 20-point or 100-point.',
      'Push notification preferences and device management.',
      'Profile: username and email.',
      'Offline mode is under Preferences, and "Try new features early" under Early access: each has its own section ("Offline use" and "Early access").',
      'Your data: download everything Cellarion stores about you, or export your cellars to take them elsewhere.',
    ],
    tourId: 'configure-settings',
  },
  {
    id: 'offline',
    title: 'Offline use',
    route: '/settings#preferences',
    summary: 'Use your cellar where there is no signal.',
    details: [
      'Turn it on in Settings → Preferences → Offline mode: "Keep my cellar available offline on this device". The installed app asks you once.',
      'A copy of your cellars, racks and bottles is kept on that device, so you can open them without a connection.',
      'Offline you can take bottles out, open them, pour a glass, edit them, and place or move them in racks.',
      'A banner shows how many changes are waiting. They are sent when you are back online; if the cellar changed in the meantime, "Review" lets you keep yours or theirs.',
      'Other pages need a connection. They say so, and load by themselves when you are back online.',
      'Logging out deletes the copy, and any changes not sent yet. On a shared computer, leave offline mode off.',
    ],
    tourId: null,
  },
  {
    id: 'early-access',
    title: 'Early access',
    route: '/settings#early-access',
    summary: 'Try new features before everyone else, and tell us what you think.',
    details: [
      'Turn it on in Settings → Early access → "Show me new features before everyone else". Turn it off again at any time.',
      'Larger changes reach these members first, so they can be tried and improved before everyone gets them.',
      'Settings → Early access lists what is "In beta now" and what was "Recently released".',
      'A feature in early access shows a Beta strip with "Give feedback", which sends your thoughts to the Cellarion team as a support ticket.',
      'Your data is stored the same way either way, so turning it off loses nothing.',
      'Like everything in Cellarion, it is free.',
    ],
    tourId: null,
  },
  {
    id: 'history',
    title: 'Cellar History',
    route: null,
    summary: 'Every bottle you have taken out of a cellar.',
    details: [
      'Open a cellar and tap History in the strip at the top.',
      'Shows every bottle you have drunk, gifted or sold, with dates.',
      'Rate a bottle and add a tasting note afterwards, right in the history.',
      'Took one out by mistake? Tap Undo in the message that appears straight away, or open the bottle within 2 days and tap "Move back to cellar".',
    ],
    tourId: 'view-history',
  },
  {
    id: 'other',
    title: 'Other Features',
    route: null,
    summary: 'Blog, supporting Cellarion, support tickets and NFC tags.',
    details: [
      'Blog (/blog): wine articles and guides.',
      `Support Us (/supporter): every feature is free for everyone, on the free Enthusiast tier too. ${tierLine()}, also available yearly, are voluntary gifts that fund development and unlock nothing extra. A custom or one-time amount can be given through GitHub Sponsors.`,
      'Support (/support): look in Help first; if you are still stuck, send a support ticket.',
      'NFC tags: attach NFC tags to racks — scan with your phone to open the rack directly.',
    ],
    tourId: null,
  },
];

module.exports = { sections };
