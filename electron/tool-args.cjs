'use strict';

/**
 * Schema-guided repair of tool arguments.
 *
 * Weak and cheap models send "5" where the schema says integer, "true" where it
 * says boolean, a JSON string where it says array, or one bare value where it
 * says list. Handlers then compare `=== true` or call `.map` and the step fails
 * for a typing mistake instead of a real problem.
 *
 * Repairs only happen where the tool's own JSON Schema names the target type and
 * the conversion is unambiguous. Anything else is left exactly as the model sent
 * it, so a handler can still reject it with its own message.
 */

function schemaTypes(schema, seen = new Set()) {
  const out = [];
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return out;
  seen.add(schema);
  if (typeof schema.type === 'string') out.push(schema.type);
  if (Array.isArray(schema.type)) out.push(...schema.type.filter((t) => typeof t === 'string'));
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (!Array.isArray(schema[key])) continue;
    for (const branch of schema[key]) out.push(...schemaTypes(branch, seen));
  }
  return out;
}

function allowsNull(schema) {
  return schemaTypes(schema).includes('null') || schema.nullable === true;
}

function hasType(schema, kind) {
  return schemaTypes(schema).includes(kind);
}

function coerceScalar(text, expected) {
  const raw = text.trim();
  if (expected === 'integer' || expected === 'number') {
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return text;
    const n = Number(raw);
    if (!Number.isFinite(n)) return text;
    if (expected === 'integer' && !Number.isInteger(n)) return text;
    return n;
  }
  if (expected === 'boolean') {
    const lower = raw.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return text;
  }
  if (expected === 'null') return raw.toLowerCase() === 'null' ? null : text;
  return text;
}

function parseJsonString(value, kind) {
  const raw = value.trim();
  if (kind === 'array' && !raw.startsWith('[')) return undefined;
  if (kind === 'object' && !raw.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (kind === 'array' && Array.isArray(parsed)) return parsed;
    if (kind === 'object' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* not JSON — the original string stays */
  }
  return undefined;
}

/** Parse JSON strings that sit in array/object slots, including nested fields. */
function normalizeNested(value, schema, repairs, path) {
  if (!schema || typeof schema !== 'object') return value;

  if (typeof value === 'string') {
    const expectsArray = hasType(schema, 'array');
    const expectsObject = hasType(schema, 'object');
    let parsed;
    if (expectsArray) parsed = parseJsonString(value, 'array');
    if (parsed === undefined && expectsObject) parsed = parseJsonString(value, 'object');
    if (parsed !== undefined) {
      repairs.push(path);
      value = parsed;
    } else {
      const kinds = schemaTypes(schema);
      if (kinds.length && !kinds.includes('string')) {
        for (const kind of ['integer', 'number', 'boolean']) {
          if (!hasType(schema, kind)) continue;
          const next = coerceScalar(value, kind);
          if (next !== value) {
            repairs.push(path);
            return next;
          }
        }
      }
      return value;
    }
  }

  if (Array.isArray(value)) {
    if (!schema.items || typeof schema.items !== 'object') return value;
    const out = value.map((item, i) => normalizeNested(item, schema.items, repairs, `${path}[${i}]`));
    return out.some((item, i) => item !== value[i]) ? out : value;
  }

  if (value && typeof value === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object') return value;
    let changed = false;
    const out = { ...value };
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in value)) continue;
      const next = normalizeNested(value[key], propSchema, repairs, path ? `${path}.${key}` : key);
      if (next !== value[key]) {
        out[key] = next;
        changed = true;
      }
    }
    return changed ? out : value;
  }

  return value;
}

function coerceProperty(value, schema, repairs, path) {
  if (!schema || typeof schema !== 'object') return value;

  if (typeof value === 'string' && allowsNull(schema) && value.trim().toLowerCase() === 'null') {
    repairs.push(path);
    return null;
  }

  if (hasType(schema, 'array') && value != null && !Array.isArray(value)) {
    if (typeof value === 'string') {
      const parsed = parseJsonString(value, 'array');
      if (parsed !== undefined) {
        repairs.push(path);
        return normalizeNested(parsed, schema, repairs, path);
      }
    }
    repairs.push(path);
    return [value];
  }

  if (hasType(schema, 'object') && typeof value === 'string') {
    const parsed = parseJsonString(value, 'object');
    if (parsed !== undefined) {
      repairs.push(path);
      return normalizeNested(parsed, schema, repairs, path);
    }
    return value;
  }

  if (typeof value === 'string') {
    if (!schemaTypes(schema).length) return value;
    for (const kind of ['integer', 'number', 'boolean']) {
      if (!hasType(schema, kind)) continue;
      const next = coerceScalar(value, kind);
      if (next !== value) {
        repairs.push(path);
        return next;
      }
    }
    return value;
  }

  return normalizeNested(value, schema, repairs, path);
}

/**
 * Repair `args` against one tool definition. Returns a new object only when
 * something actually changed; `repairs` lists the argument paths.
 */
function coerceArgsFor(toolName, args, definitions) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { args, repairs: [] };
  // An unparseable tool call is kept verbatim so the handler can explain it.
  if (Object.prototype.hasOwnProperty.call(args, '_raw')) return { args, repairs: [] };
  const def = Array.isArray(definitions) ? definitions.find((d) => d && d.name === toolName) : null;
  const properties = def && def.parameters && def.parameters.properties;
  if (!properties) return { args, repairs: [] };

  const repairs = [];
  const out = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (!schema) continue;
    const next = coerceProperty(value, schema, repairs, key);
    if (next !== value) out[key] = next;
  }
  return { args: repairs.length ? out : args, repairs };
}

module.exports = { coerceArgsFor };
