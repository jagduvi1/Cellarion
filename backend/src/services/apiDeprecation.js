/**
 * What a token request on a deprecated route gets (config/apiDeprecations):
 * the Deprecation, Sunset and Link headers, and one more count for its route
 * and day. Called by middleware/apiTokenAuth once the request is allowed.
 */
const mongoose = require('mongoose');
const ApiDeprecatedUse = require('../models/ApiDeprecatedUse');
const { DEPRECATED_SINCE, SUNSET } = require('../config/apiDeprecations');
const { siteBaseUrl } = require('../utils/siteUrl');

/** '/api/cellars/66f…/vintages/66f…/2015' → '/api/cellars/:id/vintages/:id/:n' */
function routeKey(path) {
  return path
    .split('/')
    .map((seg) => (/^[a-f0-9]{24}$/i.test(seg) ? ':id' : /^\d+$/.test(seg) ? ':n' : seg))
    .join('/');
}

function setDeprecationHeaders(res) {
  res.setHeader('Deprecation', `@${Math.floor(DEPRECATED_SINCE.getTime() / 1000)}`);
  res.setHeader('Sunset', SUNSET.toUTCString());
  res.setHeader('Link', `<${siteBaseUrl()}/developers>; rel="deprecation"; type="text/html"`);
}

/** Count one use. Fire-and-forget: counting must never slow or fail a request. */
function recordDeprecatedUse(method, path, now = new Date()) {
  // Without a live connection Mongoose would queue the write for seconds.
  if (mongoose.connection.readyState !== 1) return Promise.resolve();
  const day = now.toISOString().slice(0, 10);
  return ApiDeprecatedUse.updateOne(
    { day, route: `${method} ${routeKey(path)}` },
    { $inc: { count: 1 }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  ).catch(() => {});
}

module.exports = { routeKey, setDeprecationHeaders, recordDeprecatedUse };
