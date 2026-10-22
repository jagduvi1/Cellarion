/**
 * What a token request on a deprecated route gets (config/apiDeprecations):
 * the Deprecation, Sunset and Link headers, and one more count for its route
 * and day. Called by middleware/apiTokenAuth once the request is allowed.
 */
const mongoose = require('mongoose');
const ApiDeprecatedUse = require('../models/ApiDeprecatedUse');
const { DEPRECATED_SINCE, SUNSET } = require('../config/apiDeprecations');
const { siteBaseUrl } = require('../utils/siteUrl');

function setDeprecationHeaders(res) {
  res.setHeader('Deprecation', `@${Math.floor(DEPRECATED_SINCE.getTime() / 1000)}`);
  res.setHeader('Sunset', SUNSET.toUTCString());
  res.setHeader('Link', `<${siteBaseUrl()}/developers>; rel="deprecation"; type="text/html"`);
}

/**
 * The route Express matched, as declared ('GET /api/cellars/:id/statistics'),
 * or null when no route answered. Never built from the request path: the
 * caller writes that, and every made-up path would become a row of its own.
 */
function matchedRoute(req) {
  if (!req.route || req.route.path === undefined) return null;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  return `${method} ${req.baseUrl || ''}${String(req.route.path)}`;
}

/**
 * Count one answered use (call on the response's 'finish'). Only a real route
 * that answered successfully counts. Fire-and-forget: counting must never
 * slow or fail a request.
 */
function recordDeprecatedUse(req, res, now = new Date()) {
  const route = matchedRoute(req);
  if (!route || res.statusCode >= 400) return Promise.resolve();
  // Without a live connection Mongoose would queue the write for seconds.
  if (mongoose.connection.readyState !== 1) return Promise.resolve();
  const day = now.toISOString().slice(0, 10);
  return ApiDeprecatedUse.updateOne(
    { day, route },
    { $inc: { count: 1 }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  ).catch(() => {});
}

module.exports = { matchedRoute, setDeprecationHeaders, recordDeprecatedUse };
