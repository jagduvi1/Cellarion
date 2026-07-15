// Single place that loads every tool module (each registers its tools as a
// side-effect at require time). server.js requires this once so the registry is
// fully populated before the first request. Add new tool files here.
require('./meta');

module.exports = {};
