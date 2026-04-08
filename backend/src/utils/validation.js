const mongoose = require('mongoose');

/**
 * Check whether a value is a valid MongoDB ObjectId string.
 *
 * Combines a type-check with Mongoose's validation so callers never
 * accidentally pass an object (e.g. `{ $gt: "" }`) into a query filter.
 *
 * @param {*} id - The value to check
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && mongoose.isValidObjectId(id);
}

module.exports = { isValidId };
