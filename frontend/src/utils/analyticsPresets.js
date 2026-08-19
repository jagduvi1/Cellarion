// Pre-built analytics queries (#987, Johan 2026-08-19): the curated starting
// points a user picks instead of composing dimensions and measures from
// scratch. Client-side constants — applying one just sets the table's state,
// so presets need no storage, no schema and no extra requests. User-SAVED
// views are a later slice (R-E); these are the system ones.
//
// `build()` returns the state patch; date-dependent presets compute their
// values at click time. labelKey resolves through i18n with `label` as the
// fallback, like every other analytics string.

const thisYear = () => new Date().getFullYear();
const isoDaysAgo = (days) => {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
};

export const ANALYTICS_PRESETS = [
  {
    key: 'moneyByRegion',
    label: 'Where my money sits',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: true, dim1: 'wine.region', dim2: '', measures: [{ field: 'purchase.price', agg: 'sum' }, { field: 'purchase.price', agg: 'avg' }] },
      chartType: 'bar',
    }),
  },
  {
    key: 'favouriteRegions',
    label: 'My favourite regions (by my ratings)',
    build: () => ({
      bottleScope: 'all', // ratings live on active AND consumed bottles
      grouping: { on: true, dim1: 'wine.region', dim2: '', measures: [{ field: 'rating.current', agg: 'avg' }] },
      chartType: 'bar',
    }),
  },
  {
    key: 'cellarByType',
    label: 'What I buy (cellar by type)',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: true, dim1: 'wine.type', dim2: '', measures: [] },
      chartType: 'donut',
    }),
  },
  {
    key: 'whatIDrink',
    label: 'What I actually drink (by type)',
    build: () => ({
      bottleScope: 'consumed',
      grouping: { on: true, dim1: 'wine.type', dim2: '', measures: [] },
      chartType: 'donut',
    }),
  },
  {
    key: 'agingRunway',
    label: 'Aging runway (bottles per drink-to year)',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: true, dim1: 'maturity.drinkTo', dim2: '', measures: [] },
      chartType: 'line',
    }),
  },
  // ── The ones a user does not think to ask ────────────────────────────────
  {
    key: 'pastWindow',
    label: 'Past their window (still in the rack)',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: false, dim1: 'wine.type', dim2: '', measures: [] },
      chartType: 'table',
      // The user's own drink-to year is already behind us, yet the bottle is
      // still active — the list nobody checks until it is too late.
      filters: [{ field: 'maturity.drinkTo', op: 'lte', value: thisYear() - 1 }],
      columns: ['wine.producer', 'wine.name', 'bottle.vintage', 'maturity.drinkTo', 'bottle.location', 'purchase.price'],
      sort: { field: 'maturity.drinkTo', dir: 'asc' },
    }),
  },
  {
    key: 'forgottenBottles',
    label: 'Forgotten bottles (in the cellar 2+ years)',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: false, dim1: 'wine.type', dim2: '', measures: [] },
      chartType: 'table',
      filters: [{ field: 'bottle.addedAt', op: 'lte', value: isoDaysAgo(730) }],
      columns: ['wine.producer', 'wine.name', 'bottle.vintage', 'bottle.addedAt', 'bottle.location', 'maturity.status'],
      sort: { field: 'bottle.addedAt', dir: 'asc' },
    }),
  },
  {
    key: 'whereIShop',
    label: 'Where I shop (and what it costs me)',
    build: () => ({
      bottleScope: 'all',
      grouping: { on: true, dim1: 'purchase.location', dim2: '', measures: [{ field: 'purchase.price', agg: 'avg' }] },
      chartType: 'bar',
    }),
  },
  {
    key: 'giftedVsDrunk',
    label: 'How bottles leave (drunk, gifted, sold)',
    build: () => ({
      bottleScope: 'consumed',
      grouping: { on: true, dim1: 'consumption.reason', dim2: '', measures: [{ field: 'purchase.price', agg: 'sum' }] },
      chartType: 'donut',
    }),
  },
  {
    key: 'vintageSpread',
    label: 'Vintage spread',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: true, dim1: 'bottle.vintage', dim2: '', measures: [] },
      chartType: 'line',
    }),
  },
  {
    key: 'topProducers',
    label: 'Top producers',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: true, dim1: 'wine.producer', dim2: '', measures: [] },
      chartType: 'bar',
    }),
  },
  {
    key: 'drankLastYear',
    label: 'What I drank this past year',
    build: () => ({
      bottleScope: 'consumed',
      grouping: { on: false, dim1: 'wine.type', dim2: '', measures: [] },
      chartType: 'table',
      filters: [{ field: 'consumption.date', op: 'gte', value: isoDaysAgo(365) }],
      columns: ['wine.producer', 'wine.name', 'bottle.vintage', 'consumption.date', 'consumption.reason', 'rating.consumed'],
      sort: { field: 'consumption.date', dir: 'desc' },
    }),
  },
  {
    key: 'drinkSoon',
    label: 'Drink soon (my windows)',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: false, dim1: 'wine.type', dim2: '', measures: [] },
      chartType: 'table',
      // Bottle-level windows the USER set — honest scope: bottles without a
      // personal drink-to year simply are not in this view.
      filters: [{ field: 'maturity.drinkTo', op: 'between', value: [thisYear(), thisYear() + 1] }],
      columns: ['wine.producer', 'wine.name', 'bottle.vintage', 'maturity.drinkFrom', 'maturity.drinkTo', 'maturity.status'],
      sort: { field: 'maturity.drinkTo', dir: 'asc' },
    }),
  },
  {
    key: 'priciest',
    label: 'My priciest bottles',
    build: () => ({
      bottleScope: 'active',
      grouping: { on: false, dim1: 'wine.type', dim2: '', measures: [] },
      chartType: 'table',
      filters: [],
      columns: ['wine.producer', 'wine.name', 'bottle.vintage', 'purchase.price', 'purchase.currency', 'wine.region'],
      sort: { field: 'purchase.price', dir: 'desc' },
    }),
  },
];
