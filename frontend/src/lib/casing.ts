/**
 * Key-casing conversion between the frontend (camelCase) and claude-lb's
 * backend (snake_case JSON). `api-client.ts` applies these to every response
 * body, request body and query string unless a call opts out with `rawKeys`.
 *
 * Only plain-object *keys* are converted; values (including strings that look
 * like identifiers) are never touched. Arrays are walked element by element.
 */

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `primary_used_percent` → `primaryUsedPercent`. Leading/trailing `_` and digits-after-`_` are kept readable. */
export function snakeToCamel(key: string): string {
  if (!key.includes("_")) {
    return key;
  }
  const leading = key.match(/^_+/)?.[0] ?? "";
  const trailing = key.match(/_+$/)?.[0] ?? "";
  const core = key.slice(leading.length, key.length - trailing.length);
  const converted = core.replace(/_+([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
  return `${leading}${converted}${trailing}`;
}

/** `primaryUsedPercent` → `primary_used_percent`. Already-snake keys pass through unchanged. */
export function camelToSnake(key: string): string {
  if (!/[A-Z]/.test(key)) {
    return key;
  }
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function convertKeysDeep(value: unknown, convert: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => convertKeysDeep(item, convert));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: PlainObject = {};
  for (const [key, nested] of Object.entries(value)) {
    result[convert(key)] = convertKeysDeep(nested, convert);
  }
  return result;
}

export function camelizeKeys<T = unknown>(value: unknown): T {
  return convertKeysDeep(value, snakeToCamel) as T;
}

export function snakifyKeys<T = unknown>(value: unknown): T {
  return convertKeysDeep(value, camelToSnake) as T;
}

/** Rewrites the query-string keys of a (possibly relative) URL to snake_case. */
export function snakifyQueryKeys(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) {
    return url;
  }
  const hashStart = url.indexOf("#", queryStart);
  const base = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const hash = hashStart === -1 ? "" : url.slice(hashStart);
  const params = new URLSearchParams(query);
  const converted = new URLSearchParams();
  for (const [key, value] of params) {
    converted.append(camelToSnake(key), value);
  }
  const serialized = converted.toString();
  return `${base}${serialized ? `?${serialized}` : ""}${hash}`;
}
