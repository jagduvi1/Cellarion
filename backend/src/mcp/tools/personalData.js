// Personal typed key/value data (issue #986) — full MCP parity with the web
// bottle page: list, add, update, delete. All semantics (visibility, typed
// validation, key match-or-create, caps, discussion ban) live in
// services/personalData.js, shared with routes/personalData.js — the two
// surfaces must not drift.
//
// "Personal" means not published to the shared registry, NOT private: entries
// are visible to everyone who can see the bottle, attributed to their author.
const { z } = require('zod');
const { registerTool } = require('../registry');
const personalData = require('../../services/personalData');
const { logAudit } = require('../../services/audit');
const {
  ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess,
} = require('../toolUtil');
const { logAction, replay } = require('../actionLedger');
const { TYPES } = require('../../utils/personalDataTypes');

// Service codes → MCP fail codes (transport mapping only; messages pass through).
const FAIL_CODE = {
  invalid: 'invalid_input',
  limit: 'invalid_input',
  banned: 'forbidden_scope',
  not_found: 'not_found',
  type_conflict: 'conflict',
};
const svcFail = (result) => fail(FAIL_CODE[result.code] || 'invalid_input', result.message);

// Values arrive as string, number or boolean; the service casts them against
// the key's declared type and rejects mismatches.
const VALUE_SCHEMA = z.union([z.string().max(500), z.number(), z.boolean()]);

const entryOut = (e) => ({
  entry_id: e._id,
  level: e.level,
  key: e.key.name,
  type: e.key.type,
  unit: e.key.unit,
  ...(e.key.enumOptions ? { options: e.key.enumOptions } : {}),
  value: e.value,
  author: e.author.displayName || e.author.username || null,
  author_id: e.author._id,
  updated_at: e.updatedAt,
});

registerTool({
  name: 'list_personal_data',
  title: 'List personal data on a bottle and its wine',
  description:
    'Typed personal key/value entries visible on this bottle: bottle-level entries (true of this bottle alone — ' +
    'provenance, cork condition) plus wine-level entries by members of the bottle\'s cellar (true of every bottle ' +
    'of that wine — ABV, own food pairing). Attributed to their authors; entries by others are read-only context.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { bottle_id: objectId },
  handler: async (args, ctx) => {
    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'viewer');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const result = await personalData.listForBottle(access.bottle, access.cellar);
    const bottle_entries = result.bottleEntries.map(entryOut);
    const wine_entries = result.wineEntries.map(entryOut);
    return ok(
      `${bottle_entries.length} bottle-level and ${wine_entries.length} wine-level entr(y/ies)`,
      { bottle_entries, wine_entries }
    );
  },
});

registerTool({
  name: 'add_personal_data',
  title: 'Add a personal data entry to a bottle or its wine',
  description:
    'Adds one typed key/value entry the user owns. level "bottle" = true of this bottle alone; level "wine" = true ' +
    'of every bottle of this wine. Keys are the user\'s own vocabulary: reusing a key name keeps its stored type; a ' +
    'NEW key needs key_type (and enum_options for enum keys, optionally unit for numeric ones). The value is ' +
    'validated against the key\'s type. Entries are visible to everyone who can see the bottle, attributed to the ' +
    'user. Reversible via undo_last. Pass an idempotency_key when retrying.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId,
    level: z.enum(['wine', 'bottle']),
    key: z.string().trim().min(1).max(60).describe('Key name, e.g. "ABV" or "Cork condition"'),
    key_type: z.enum(TYPES).optional().describe('Required only when the key is new to this user'),
    unit: z.string().max(20).optional().describe('For new integer/decimal keys: unit on the KEY (e.g. "%", "°C")'),
    enum_options: z.array(z.string().max(40)).min(2).max(20).optional().describe('For new enum keys: the allowed values'),
    value: VALUE_SCHEMA,
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'add_personal_data');
    if (replayed) return replayed;

    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'viewer');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);

    const result = await personalData.createEntry(ctx.user.id, access.bottle, {
      level: args.level,
      newKey: {
        name: args.key,
        // When the key already exists its stored type wins; for a NEW key a
        // missing key_type fails validation with a clear message.
        type: args.key_type,
        unit: args.unit,
        enumOptions: args.enum_options,
      },
      value: args.value,
    });
    if (!result.ok) {
      if (result.code === 'invalid' && !args.key_type) {
        return svcFail({ ...result, message: `${result.message}. If "${args.key}" is a new key, pass key_type (${TYPES.join(' | ')}).` });
      }
      return svcFail(result);
    }

    logAudit(ctx.req, 'personal_data.entry_create',
      { type: args.level, id: result.entry._id, cellarId: access.cellar._id },
      { key: result.entry.key.name, keyCreated: result.keyCreated, via: 'mcp' });

    const envelope = {
      summary: `Added ${args.level}-level "${result.entry.key.name}" = ${JSON.stringify(result.entry.value)}${result.entry.key.unit ? ' ' + result.entry.key.unit : ''}`,
      data: {
        entry: entryOut(result.entry),
        key_created: result.keyCreated,
        undo: 'undo_last removes this entry again if it was a mistake',
      },
    };
    await logAction(ctx, {
      tool: 'add_personal_data',
      action: 'personal_data',
      bottle: access.bottle._id,
      cellar: access.cellar._id,
      detail: { op: 'create', entryId: String(result.entry._id), key: result.entry.key.name },
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'update_personal_data',
  title: 'Update one of the user\'s own personal data entries',
  description:
    'Changes the value of an entry the user authored (entry_id from list_personal_data). The new value is validated ' +
    'against the key\'s stored type. Other people\'s entries cannot be edited. Reversible via undo_last.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    entry_id: objectId,
    value: VALUE_SCHEMA,
  },
  handler: async (args, ctx) => {
    const result = await personalData.updateEntry(ctx.user.id, args.entry_id, args.value);
    if (!result.ok) return svcFail(result);

    logAudit(ctx.req, 'personal_data.entry_update',
      { type: result.entry.level, id: result.entry._id },
      { key: result.entry.key.name, via: 'mcp' });

    const envelope = {
      summary: `Updated "${result.entry.key.name}" to ${JSON.stringify(result.entry.value)}`,
      data: { entry: entryOut(result.entry), undo: 'undo_last restores the previous value' },
    };
    await logAction(ctx, {
      tool: 'update_personal_data',
      action: 'personal_data',
      detail: { op: 'update', entryId: String(result.entry._id), key: result.entry.key.name },
      prev: { value: result.prevValue },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'delete_personal_data',
  title: 'Delete one of the user\'s own personal data entries',
  description:
    'Deletes an entry the user authored (entry_id from list_personal_data). Other people\'s entries cannot be ' +
    'deleted. Reversible via undo_last, which recreates the entry.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: { entry_id: objectId },
  handler: async (args, ctx) => {
    const result = await personalData.deleteEntry(ctx.user.id, args.entry_id);
    if (!result.ok) return svcFail(result);
    const e = result.entry;

    logAudit(ctx.req, 'personal_data.entry_delete',
      { type: e.level, id: e._id },
      { key: e.key.name, via: 'mcp' });

    const envelope = {
      summary: `Deleted ${e.level}-level "${e.key.name}"`,
      data: { deleted: true, undo: 'undo_last recreates this entry' },
    };
    await logAction(ctx, {
      tool: 'delete_personal_data',
      action: 'personal_data',
      bottle: result.target.bottle || undefined,
      detail: { op: 'delete', entryId: String(e._id), key: e.key.name },
      // Full snapshot to recreate on undo (key id survives — keys are never
      // deleted in this feature).
      prev: {
        keyId: String(e.key._id),
        level: e.level,
        value: e.value,
        wineDefinition: result.target.wineDefinition ? String(result.target.wineDefinition) : null,
        bottle: result.target.bottle ? String(result.target.bottle) : null,
      },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = {};
