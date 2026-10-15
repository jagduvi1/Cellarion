// The "all my cellars" scope a cellar's list or history remembers for this
// tab: cellar ids, this cellar first. Shared by CellarDetail and CellarHistory.

/** The saved scope if it is a well-formed one for this cellar, else just it. */
export function validScope(saved, cellarId) {
  return Array.isArray(saved) && saved[0] === cellarId && saved.every((x) => typeof x === 'string')
    ? saved
    : [cellarId];
}

/**
 * Drop the cellars the user no longer has (deleted or unshared since the scope
 * was saved); this cellar always stays. The same array back when nothing went.
 */
export function keepKnownCellars(scope, cellarId, cellars) {
  const known = new Set((cellars || []).map((c) => String(c._id)));
  const kept = scope.filter((cid) => cid === cellarId || known.has(cid));
  return kept.length === scope.length ? scope : kept;
}
