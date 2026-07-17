// Single place that loads every tool module (each registers its tools as a
// side-effect at require time). server.js requires this once so the registry is
// fully populated before the first request. Add new tool files here.
//
// Tool modules may require Mongoose models freely, but must NEVER top-require
// services/search or anything else that pulls the ESM-only meilisearch package
// — lazy-require those inside handlers (jest cannot parse the ESM dist; the
// same chain broke auth.refresh.test.js, fixed in PR #702).
require('./meta');
require('./cellars');
require('./bottles');
require('./racks');
require('./stats');
require('./wines');
require('./personal');
require('./consume');
require('./write');
require('./bulk');
require('./somm');
require('./rack');
require('./similar');
require('./insights');
require('./drinking');
require('./journey');
require('./semantic');
require('./tasting');
require('./arrange');
require('./notify');

module.exports = {};
