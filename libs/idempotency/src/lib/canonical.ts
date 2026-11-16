import { createHash } from 'crypto';

/**
 * JSON with object keys sorted at every level, so two requests with the same arguments hash the
 * same whatever their key order. `bigint` and `Date` get unambiguous tagged forms.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { $bigint: value.toString() };
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : normalize(v)));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = normalize(v);
      }
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) of the canonical JSON of a request's arguments. */
export function hashRequest(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

/**
 * A handler's response as JSON that `decodeResponse` turns back into the same values, `bigint`s
 * and `Date`s included (plain JSON would throw on the first and flatten the second).
 */
export function encodeResponse(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value, function (key, v) {
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Date) {
      return { $date: raw.toISOString() };
    }
    if (typeof v === 'bigint') {
      return { $bigint: v.toString() };
    }
    return v;
  });
}

export function decodeResponse(json: string): unknown {
  return JSON.parse(json, (_, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && typeof v.$bigint === 'string') {
        return BigInt(v.$bigint);
      }
      if (keys.length === 1 && typeof v.$date === 'string') {
        return new Date(v.$date);
      }
    }
    return v;
  });
}
