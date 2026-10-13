const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listPickLists, createPickList, renamePickList, addToPickList, removeFromPickList,
  setPicked, deletePickList, getPickListView,
} = require('../services/pickListOps');

// Pick lists (forum request 2026-10-13): named lists of the user's own
// bottles to fetch, shown with cellar, rack and slot. Each route is a thin
// wrapper over services/pickListOps, which the MCP tools share. Open to every
// member: the early-access flag (pickLists) only decides who sees the screens.

const router = express.Router();
router.use(requireAuth);

const send = (res, result, okStatus = 200) => (result.error
  ? res.status(result.error.status).json({ error: result.error.message })
  : res.status(okStatus).json(result));

const handle = (fn, okStatus) => async (req, res) => {
  try {
    send(res, await fn(req), okStatus);
  } catch (err) {
    console.error('Pick list request failed:', err.message);
    res.status(500).json({ error: 'Pick list request failed' });
  }
};

// GET /api/pick-lists — the user's lists, newest change first.
router.get('/', handle((req) => listPickLists(req.user.id)));

// POST /api/pick-lists { name, bottleIds? } → 201 { list, added, skipped }
router.post('/', handle((req) => createPickList(req.user.id, req.body || {}, req), 201));

// GET /api/pick-lists/:id — the list with each bottle's wine, cellar, rack and slot, in walking order.
router.get('/:id', handle((req) => getPickListView(req.user.id, req.params.id)));

// PATCH /api/pick-lists/:id { name }
router.patch('/:id', handle((req) => renamePickList(req.user.id, req.params.id, req.body?.name, req)));

// POST /api/pick-lists/:id/items { bottleIds } → { list, added, skipped }
router.post('/:id/items', handle((req) => addToPickList(req.user.id, req.params.id, req.body?.bottleIds, req)));

// POST /api/pick-lists/:id/items/remove { bottleIds } → { list, removed }
router.post('/:id/items/remove', handle((req) => removeFromPickList(req.user.id, req.params.id, req.body?.bottleIds, req)));

// POST /api/pick-lists/:id/picked { bottleIds, picked } — tick or untick, many at once
// (the page batches ticks: the write limiter counts requests, not bottles).
router.post('/:id/picked', handle((req) => setPicked(req.user.id, req.params.id, req.body?.bottleIds, req.body?.picked)));

// DELETE /api/pick-lists/:id
router.delete('/:id', handle((req) => deletePickList(req.user.id, req.params.id, req)));

module.exports = router;
