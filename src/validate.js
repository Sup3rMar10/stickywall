// Every inbound WebSocket message goes through validateMessage() before any
// handler sees it: known type, exact key set, per-field type and size limits.

export const COLS = ['well', 'improve', 'actions'];
export const MAX_NOTE_TEXT = 500;
export const MAX_NAME = 30;

// C0/C1 controls except \n, plus bidi overrides that can spoof how text renders.
const BAD_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

export function cleanText(s, { multiline = false } = {}) {
  let out = s.replace(BAD_CHARS, '');
  if (!multiline) out = out.replace(/\n/g, ' ');
  return out.replace(/[ \t]+$/gm, '').trim();
}

const str = (min, max, opts) => ({ kind: 'str', min, max, ...opts });
const int = (min, max) => ({ kind: 'int', min, max });
const num = (min, max) => ({ kind: 'num', min, max });
const oneOf = (values) => ({ kind: 'enum', values });
const bool = () => ({ kind: 'bool' });
const opt = (spec) => ({ ...spec, optional: true });

const SCHEMAS = {
  auth: { session: str(10, 128) },
  note_add: { col: oneOf(COLS), text: str(0, MAX_NOTE_TEXT, { multiline: true }), cid: opt(str(1, 32)) },
  note_edit: { id: int(1, 2 ** 31), text: str(0, MAX_NOTE_TEXT, { multiline: true }) },
  note_move: { id: int(1, 2 ** 31), col: oneOf(COLS), pos: num(-1e9, 1e9) },
  note_del: { id: int(1, 2 ** 31) },
  vote: { id: int(1, 2 ** 31), delta: oneOf([1, -1]) },
  cursor: { x: num(0, 1), y: num(0, 10000) },
  timer: { action: oneOf(['start', 'stop']), seconds: opt(int(1, 3600)) },
  settings: { anonymous: bool() },
};

function checkField(spec, v) {
  switch (spec.kind) {
    case 'str': {
      if (typeof v !== 'string' || v.length > spec.max * 4) return { ok: false };
      const clean = cleanText(v, { multiline: !!spec.multiline });
      if (clean.length < spec.min || clean.length > spec.max) return { ok: false };
      return { ok: true, value: clean };
    }
    case 'int':
      return Number.isInteger(v) && v >= spec.min && v <= spec.max ? { ok: true, value: v } : { ok: false };
    case 'num':
      return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max
        ? { ok: true, value: v }
        : { ok: false };
    case 'enum':
      return spec.values.includes(v) ? { ok: true, value: v } : { ok: false };
    case 'bool':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false };
  }
  return { ok: false };
}

// Returns { ok: true, msg } or { ok: false, reason }. `reason` is for logs,
// never echoed to the client (it could contain attacker-controlled text).
export function validateMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'bad json' };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'not an object' };
  const schema = Object.hasOwn(SCHEMAS, data.t) ? SCHEMAS[data.t] : null;
  if (!schema) return { ok: false, reason: 'unknown type' };

  const msg = { t: data.t };
  for (const key of Object.keys(data)) {
    if (key !== 't' && !Object.hasOwn(schema, key)) return { ok: false, reason: `unexpected key ${key}` };
  }
  for (const [key, spec] of Object.entries(schema)) {
    if (data[key] === undefined) {
      if (spec.optional) continue;
      return { ok: false, reason: `missing ${key}` };
    }
    const r = checkField(spec, data[key]);
    if (!r.ok) return { ok: false, reason: `bad ${key}` };
    msg[key] = r.value;
  }
  return { ok: true, msg };
}
