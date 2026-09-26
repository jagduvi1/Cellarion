// The orders a cellar's bottle list can open in: the values of the cellar
// page's sort select. The backend validates the remembered choice against the
// same list (config/constants.js CELLAR_SORTS).
export const CELLAR_SORTS = ['-createdAt', 'createdAt', 'name', '-name', 'vintage', '-vintage', 'price', '-price', 'maturity'];
export const DEFAULT_CELLAR_SORT = '-createdAt';

// The sort the user last picked on a cellar page (preferences.cellarSort), or
// newest first. A stored value the page no longer offers is ignored.
export function preferredCellarSort(user) {
  const sort = user?.preferences?.cellarSort;
  return CELLAR_SORTS.includes(sort) ? sort : DEFAULT_CELLAR_SORT;
}
