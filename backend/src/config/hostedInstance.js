/**
 * True only on the hosted cellarion.app deployment. FRONTEND_URL is the
 * backend's existing single source of truth for its public web origin
 * (prod sets https://cellarion.app; self-hosters set their own domain and
 * the compose default is http://localhost) — so this needs no new env var
 * and no compose change.
 *
 * Used to gate the MCP supporter-awareness messaging (instructions,
 * get_source_info funding block, cellarion://about): the hosted service is
 * supporter-funded, but a self-hosted instance pays its own bills — showing
 * OUR donation pitch there would be wrong, so self-hosted serves none of it.
 * Read per call: trivial cost, and tests can flip the env without module
 * cache tricks.
 */
function isHostedCellarion() {
  return (process.env.FRONTEND_URL || '').replace(/\/+$/, '') === 'https://cellarion.app';
}

module.exports = { isHostedCellarion };
