'use strict';
// Minimal JSON-Schema subset validator (F1 capability schema). Zero-dependency on purpose --
// we only need enough to enforce agent capability contracts (type / required / properties / enum /
// items), not full draft-2020-12. Returns { ok:true } or { ok:false, errors:[...] }.
// Anything we don't understand is treated permissively (ignored), so an unknown keyword never
// wrongly rejects a valid payload.
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // 'string' | 'number' | 'boolean' | 'object'
}
function matchesType(v, t) {
  if (!t) return true;
  const types = Array.isArray(t) ? t : [t];
  const actual = typeOf(v);
  return types.some(x => x === actual || (x === 'number' && actual === 'integer') || (x === 'integer' && actual === 'number' && Number.isInteger(v)));
}
function validate(schema, value, pathPrefix = '') {
  const errors = [];
  function walk(sch, val, path) {
    if (!sch || typeof sch !== 'object') return;
    if (sch.type && !matchesType(val, sch.type)) {
      errors.push(`${path || '(root)'}: expected type ${JSON.stringify(sch.type)}, got ${typeOf(val)}`);
      return; // type wrong -> deeper checks are noise
    }
    if (Array.isArray(sch.enum) && !sch.enum.some(e => JSON.stringify(e) === JSON.stringify(val))) {
      errors.push(`${path || '(root)'}: value not in enum`);
    }
    if (typeOf(val) === 'object') {
      if (Array.isArray(sch.required)) {
        for (const k of sch.required) if (!(k in val)) errors.push(`${path ? path + '.' : ''}${k}: required`);
      }
      if (sch.properties && typeof sch.properties === 'object') {
        for (const [k, subsch] of Object.entries(sch.properties)) {
          if (k in val) walk(subsch, val[k], path ? `${path}.${k}` : k);
        }
      }
    }
    if (typeOf(val) === 'array' && sch.items) {
      val.forEach((item, i) => walk(sch.items, item, `${path}[${i}]`));
    }
  }
  walk(schema, value, pathPrefix);
  return { ok: errors.length === 0, errors };
}
// Normalize a capability entry (string legacy form or structured object) to its canonical name.
function capName(cap) {
  if (typeof cap === 'string') return cap;
  if (cap && typeof cap === 'object' && typeof cap.name === 'string') return cap.name;
  return '';
}
module.exports = { validate, capName };
