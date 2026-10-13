const mongoose = require('mongoose');

// A pick list (forum request 2026-10-13): a named list of the user's own
// bottles to fetch from the cellar ("Saturday dinner", "Drink next"), shown
// with each bottle's cellar, rack and slot so nobody opens the bottles one by
// one to find them. Bottles from any cellar the user can see may be on it.
//
// Deliberately NOT a reservation: a reserved bottle is "spoken for" (kept out
// of drink suggestions, consume warns), a picked one is about to be drunk.
//
// Items are references only; what a bottle IS (wine, vintage, where it sits)
// is read live from the bottle and its rack when the list is shown, so a
// moved bottle never shows a stale slot.

const MAX_ITEMS_PER_LIST = 500;
const MAX_LISTS_PER_USER = 50;

const itemSchema = new mongoose.Schema({
  bottle: { type: mongoose.Schema.Types.ObjectId, ref: 'Bottle', required: true },
  addedAt: { type: Date, default: Date.now },
  // Ticked off while fetching; null = still to pick.
  pickedAt: { type: Date, default: null },
}, { _id: false });

const pickListSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'A pick list needs a name'],
    trim: true,
    maxlength: [100, 'Pick list name too long (max 100 characters)'],
  },
  items: {
    type: [itemSchema],
    default: [],
    validate: {
      validator: (v) => !v || v.length <= MAX_ITEMS_PER_LIST,
      message: `A pick list holds at most ${MAX_ITEMS_PER_LIST} bottles`,
    },
  },
}, { timestamps: true });

// Lists change through atomic updates (add, remove, tick — services/
// pickListOps), so two devices ticking at once never overwrite each other.

const PickList = mongoose.model('PickList', pickListSchema);
PickList.MAX_ITEMS_PER_LIST = MAX_ITEMS_PER_LIST;
PickList.MAX_LISTS_PER_USER = MAX_LISTS_PER_USER;

module.exports = PickList;
