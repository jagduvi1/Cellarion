// Proactive-sommelier companions (plan §3.12 + §4): the PULL side of the
// event-bus pushes. A session subscribed to cellarion://alerts gets nudged
// when something lands; these tools are how the model then reads and clears
// the alerts — and how a climate excursion is inspected.
const { z } = require('zod');
const Notification = require('../../models/Notification');
const { registerTool } = require('../registry');
const { ok, fail, objectId, MSG_CELLAR_NOT_FOUND, resolveCellarAccess } = require('../toolUtil');
const { isValidId } = require('../../utils/validation');

const serialize = (n) => ({
  notification_id: n._id,
  type: n.type,
  title: n.title,
  message: n.message,
  read: !!n.read,
  created_at: n.createdAt,
});

registerTool({
  name: 'list_notifications',
  title: 'List notifications / alerts',
  description:
    'The user\'s notifications, newest first: drink-window transitions (peak / ending / past), open-bottle expiry, ' +
    'restock alerts, climate excursions, community events. Call when asked "any alerts?", after a resource-updated ' +
    'push on cellarion://alerts, or to check what needs attention. unread_only defaults to true.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    unread_only: z.boolean().default(true),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
    const filter = { user: ctx.user.id };
    if (args.unread_only !== false) filter.read = false;
    const [total, unread, items] = await Promise.all([
      Notification.countDocuments(filter),
      Notification.countDocuments({ user: ctx.user.id, read: false }),
      Notification.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    ]);
    return ok(
      `${items.length} of ${total} notification(s)${args.unread_only !== false ? ' (unread)' : ''} — ${unread} unread in total`,
      items.map(serialize),
      { page: { limit, offset, total } }
    );
  },
});

registerTool({
  name: 'mark_notification_read',
  title: 'Mark notification(s) read',
  description:
    'Marks one notification (notification_id) or ALL of the user\'s notifications (all: true) as read, after the ' +
    'user has seen what you relayed. Cosmetic and idempotent — it changes no cellar data and is reversible by ' +
    'opening the notification list in the web app.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    notification_id: objectId.optional().describe('One notification to mark read'),
    all: z.boolean().optional().describe('true = mark every notification read'),
  },
  handler: async (args, ctx) => {
    // Deliberately NO McpActionLog row: this is cosmetic UI state (read flags),
    // not cellar data — nothing is lost and nothing needs undo. It still rides
    // the mutation budget via readOnlyHint:false like every write.
    if (args.all === true) {
      const r = await Notification.updateMany({ user: ctx.user.id, read: false }, { $set: { read: true } });
      return ok(`Marked ${r.modifiedCount} notification(s) read`, { marked: r.modifiedCount });
    }
    if (!args.notification_id || !isValidId(args.notification_id)) {
      return fail('invalid_input', 'Provide notification_id (from list_notifications) or all: true.');
    }
    const r = await Notification.updateOne(
      { _id: args.notification_id, user: ctx.user.id },
      { $set: { read: true } }
    );
    if (r.matchedCount === 0) {
      return fail('not_found', 'No such notification on this account. Use list_notifications for valid ids.');
    }
    return ok('Notification marked read', { notification_id: args.notification_id, marked: r.modifiedCount });
  },
});

registerTool({
  name: 'climate_status',
  title: 'Cellar climate status',
  description:
    'Climate for one cellar: configured temperature/humidity bounds, each sensor device with online state and ' +
    'every channel\'s latest reading plus whether it is currently in or out of range — plus history aggregates per ' +
    'reading type over 24h / 30d / 12m windows (min/max/mean, out-of-range reading count, excursion episodes with ' +
    'the longest duration), so "what temperature has this cellar been stored at" is answerable without raw data. ' +
    'Call for "how is the cellar climate", after a climate-excursion alert, or before advising on storage ' +
    'conditions. Fine-grained history charts remain web-app-only.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    cellar_id: objectId.describe('Cellar id from list_cellars'),
  },
  handler: async (args, ctx) => {
    // Lazy requires: climateAlerts pulls the notification stack at load time.
    const ClimateDevice = require('../../models/ClimateDevice');
    const { effectiveClimateConfig } = require('../../services/climateAlerts');
    const { collectClimateHistory, formatHistoryCapsule } = require('../../services/climateHistory');

    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id);
    if (!access) return fail('not_found', MSG_CELLAR_NOT_FOUND);

    const cfg = effectiveClimateConfig(access.cellar);
    const devices = await ClimateDevice.find({ cellar: access.cellar._id }).lean();
    const now = Date.now();
    const boundsFor = (type) => (type === 'temperature'
      ? { min: cfg.tempMin, max: cfg.tempMax, unit: '°C' }
      : { min: cfg.rhMin, max: cfg.rhMax, unit: '%' });

    const data = {
      cellar_id: access.cellar._id,
      cellar: access.cellar.name,
      bounds: {
        temperature: { min: cfg.tempMin, max: cfg.tempMax, unit: '°C' },
        humidity: { min: cfg.rhMin, max: cfg.rhMax, unit: '%' },
      },
      devices: devices.map((d) => ({
        name: d.name,
        online: !!d.lastSeenAt && (now - new Date(d.lastSeenAt).getTime()) < cfg.offlineAfterMin * 60 * 1000,
        last_seen_at: d.lastSeenAt,
        channels: (d.channels || []).map((c) => {
          const b = boundsFor(c.type);
          return {
            key: c.key,
            type: c.type,
            label: c.label || null,
            last_value: c.lastValue,
            unit: b.unit,
            last_value_at: c.lastValueAt,
            in_range: c.lastValue == null ? null : (c.lastValue >= b.min && c.lastValue <= b.max),
            alert_state: c.alertState,
          };
        }),
      })),
    };
    const offline = data.devices.filter((d) => !d.online).length;
    const breached = data.devices.flatMap((d) => d.channels).filter((c) => c.alert_state === 'breached').length;
    if (devices.length === 0) {
      return ok(`No climate sensors in "${access.cellar.name}"`, data, {
        warnings: ['This cellar has no climate devices — sensors are added in the web app (Settings → Climate).'],
      });
    }

    // History aggregates (min/max/mean + excursion episodes per 24h/30d/12m
    // window) — computed inside MongoDB, so the response stays a handful of
    // numbers no matter how many readings the year holds.
    const { history, warnings } = await collectClimateHistory({
      deviceIds: devices.map((d) => d._id),
      cfg,
      now: new Date(now),
    });
    data.history = history;

    const capsule = formatHistoryCapsule(history);
    return ok(
      `${devices.length} device(s) in "${access.cellar.name}"${offline ? `, ${offline} offline` : ''}${breached ? `, ${breached} channel(s) OUT OF RANGE` : ' — all readings in range'}${capsule ? ` — ${capsule}` : ''}`,
      data,
      warnings.length > 0 ? { warnings } : {}
    );
  },
});

module.exports = {};
