/**
 * Validates real answers against the public API document (openapi/document.js)
 * with Ajv's JSON Schema 2020-12 dialect, the one OpenAPI 3.1 uses. For the
 * contract and document tests only; nothing at runtime loads it.
 */
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const SCHEMA_ID = 'cellarion-openapi';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Point the document's component refs at the registered schema bundle. */
function rewriteRefs(value) {
  return JSON.parse(JSON.stringify(value).replace(/"#\/components\/schemas\//g, `"${SCHEMA_ID}#/$defs/`));
}

function createValidator(doc) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  addFormats(ajv);
  // OpenAPI annotations Ajv does not know but must accept inside schemas.
  ajv.addKeyword('example');
  ajv.addSchema({ $id: SCHEMA_ID, $defs: rewriteRefs(doc.components.schemas) });

  const resolve = (obj) => {
    let o = obj;
    while (o && o.$ref) {
      const [, kind, name] = o.$ref.match(/^#\/components\/(\w+)\/(.+)$/) || [];
      o = kind ? doc.components[kind][name] : null;
    }
    return o;
  };

  /** Every documented operation: { operationId, method, path, scopes, statuses, op }. */
  function operations() {
    const out = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const security = op.security || doc.security || [];
        out.push({
          operationId: op.operationId,
          method: method.toUpperCase(),
          path,
          // [] = no token; [[]] = any token; [['read']] = that scope.
          scopes: security.map((req) => req.apiToken).filter(Boolean),
          statuses: Object.keys(op.responses),
          op,
        });
      }
    }
    return out;
  }

  const cache = new Map();
  function compiled(schema) {
    const key = JSON.stringify(schema);
    if (!cache.has(key)) cache.set(key, ajv.compile(rewriteRefs(schema)));
    return cache.get(key);
  }

  /** Errors (strings) for one schema and value; [] when valid. */
  function check(schema, value, where) {
    const validate = compiled(schema);
    if (validate(value)) return [];
    return validate.errors.map((e) => `${where}${e.instancePath || ''} ${e.message}${e.params && e.params.allowedValues ? ` ${JSON.stringify(e.params.allowedValues)}` : ''}`);
  }

  /**
   * Validate one answer: its status is documented, its body matches that
   * status's schema for its content type, and every documented header that
   * the answer carries has the documented type. Returns error strings.
   */
  function validateResponse(operationId, { status, contentType, body, headers = {} }) {
    const entry = operations().find((o) => o.operationId === operationId);
    if (!entry) return [`${operationId}: not in the document`];
    const response = resolve(entry.op.responses[String(status)]);
    if (!response) return [`${operationId}: status ${status} is not documented`];
    const errors = [];
    const media = response.content || null;
    if (!media) {
      if (body !== null && body !== undefined && body !== '') errors.push(`${operationId} ${status}: documented without a body, got one`);
    } else {
      const type = String(contentType || '').split(';')[0].trim();
      const m = media[type];
      if (!m) {
        errors.push(`${operationId} ${status}: content type "${type}" is not documented (${Object.keys(media).join(', ')})`);
      } else if (type === 'application/json') {
        errors.push(...check(m.schema, body, `${operationId} ${status} body`));
      }
    }
    for (const [name, h] of Object.entries(response.headers || {})) {
      const header = resolve(h);
      const raw = headers[name.toLowerCase()];
      if (raw === undefined || raw === null) continue;
      const schema = header.schema || {};
      const value = schema.type === 'integer' && /^-?\d+$/.test(raw) ? Number(raw) : raw;
      errors.push(...check(schema, value, `${operationId} ${status} header ${name}`));
    }
    return errors;
  }

  return { ajv, operations, validateResponse, check, resolve };
}

module.exports = { createValidator, rewriteRefs, SCHEMA_ID };
