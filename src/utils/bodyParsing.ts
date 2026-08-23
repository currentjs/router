import { BadRequestError, UnsupportedMediaTypeError } from '../errors/HttpErrors';

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Parsed representation of a `Content-Type` header value.
 */
export interface MediaType {
  /** The lowercased `type/subtype`, e.g. `"application/json"`. Empty string when no header was present. */
  type: string;
  /** The `charset` parameter, lowercased, or `undefined` when not specified. */
  charset: string | undefined;
  /** All media-type parameters, lowercased keys and values. */
  parameters: Record<string, string>;
}

/**
 * A body-parser function.  Receives the raw body bytes and the resolved
 * `MediaType` (so it can read `charset` etc.) and returns the parsed value.
 * Throw a `BaseHttpError` to return an error response to the client.
 */
export type BodyParser = (raw: Buffer, media: MediaType) => unknown;

// ─── Media-type parsing ────────────────────────────────────────────────────

/**
 * Parse the value of a `Content-Type` header (which may be a multi-value
 * array from Node's `IncomingMessage.headers`) into a `MediaType`.
 * Returns `{ type: '', charset: undefined, parameters: {} }` when the
 * header is absent or empty.
 */
export function parseMediaType(header?: string | string[]): MediaType {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return { type: '', charset: undefined, parameters: {} };

  const parts = raw.split(';');
  const type = (parts[0] ?? '').trim().toLowerCase();
  const parameters: Record<string, string> = {};

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim().toLowerCase();
    let value = part.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    parameters[key] = value.toLowerCase();
  }

  return { type, charset: parameters['charset'], parameters };
}

// ─── Charset decoding ──────────────────────────────────────────────────────

const SUPPORTED_CHARSETS: Record<string, BufferEncoding> = {
  'utf-8': 'utf8',
  'utf8': 'utf8',
  'us-ascii': 'ascii',
  'ascii': 'ascii',
  'latin1': 'latin1',
  'iso-8859-1': 'latin1',
  'utf-16le': 'utf16le',
  'ucs-2': 'ucs2',
  'ucs2': 'ucs2',
};

/**
 * Decode `raw` bytes to a string using the given IANA charset name.
 * Defaults to UTF-8 when `charset` is absent.
 * Throws `UnsupportedMediaTypeError` for charsets outside the supported set.
 */
export function decodeWithCharset(raw: Buffer, charset?: string): string {
  if (!charset) return raw.toString('utf8');
  const enc = SUPPORTED_CHARSETS[charset.toLowerCase()];
  if (!enc) {
    throw new UnsupportedMediaTypeError(
      `Unsupported charset: ${charset}. Supported charsets: ${Object.keys(SUPPORTED_CHARSETS).join(', ')}`,
    );
  }
  return raw.toString(enc);
}

// ─── Parser lookup ─────────────────────────────────────────────────────────

/**
 * Look up the appropriate `BodyParser` for `mediaType` from `parsers`.
 *
 * Resolution order (most specific first):
 *   1. Exact `type/subtype`          — `"application/json"`
 *   2. Structured-syntax suffix      — `"application/ld+json"` → `"+json"` entry
 *   3. Wildcard subtype              — `"text/*"`
 *   4. Full wildcard                 — `"*∕*"`
 *   5. Fallback: return `undefined` (caller handles as raw Buffer)
 */
export function lookupParser(
  mediaType: string,
  parsers: Record<string, BodyParser>,
): BodyParser | undefined {
  if (!mediaType) return undefined;

  // 1. Exact match
  if (parsers[mediaType]) return parsers[mediaType];

  // 2. Structured-syntax suffix (e.g. "application/ld+json" → "+json")
  const plusIdx = mediaType.lastIndexOf('+');
  if (plusIdx !== -1) {
    const suffix = '+' + mediaType.slice(plusIdx + 1);
    if (parsers[suffix]) return parsers[suffix];
  }

  // 3. type/* wildcard
  const slashIdx = mediaType.indexOf('/');
  if (slashIdx !== -1) {
    const wildcard = mediaType.slice(0, slashIdx + 1) + '*';
    if (parsers[wildcard]) return parsers[wildcard];
  }

  // 4. */* wildcard
  if (parsers['*/*']) return parsers['*/*'];

  return undefined;
}

// ─── Default parsers ───────────────────────────────────────────────────────

function stripBom(buf: Buffer): Buffer {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3);
  }
  return buf;
}

const jsonParser: BodyParser = (raw, media) => {
  const text = decodeWithCharset(stripBom(raw), media.charset);
  try {
    return JSON.parse(text);
  } catch (e: any) {
    throw new BadRequestError(`Invalid JSON body: ${e.message}`);
  }
};

const urlencodedParser: BodyParser = (raw, media) => {
  const text = decodeWithCharset(raw, media.charset);
  const params = new URLSearchParams(text);
  const result: Record<string, string | string[]> = {};
  for (const key of params.keys()) {
    const values = params.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
};

const textParser: BodyParser = (raw, media) => decodeWithCharset(raw, media.charset);

const multipartParser: BodyParser = () => {
  throw new UnsupportedMediaTypeError(
    'multipart/form-data body parsing is not supported yet. File upload support is planned for a future release.',
  );
};

export const defaultBodyParsers: Record<string, BodyParser> = {
  'application/json': jsonParser,
  '+json': jsonParser,
  'application/x-www-form-urlencoded': urlencodedParser,
  'text/*': textParser,
  'multipart/form-data': multipartParser,
};

// ─── Options resolution ────────────────────────────────────────────────────

/**
 * Merge user-supplied `option` over the `defaultBodyParsers`.
 * - `false`  → no parsing at all; every body arrives as a raw `Buffer`.
 * - `Record` → individual entries override the defaults; a `null` value removes that default.
 * - `undefined` → pure defaults.
 */
export function resolveBodyParsers(
  option: false | Record<string, BodyParser | null> | undefined,
): Record<string, BodyParser> | false {
  if (option === false) return false;
  if (!option) return { ...defaultBodyParsers };

  const merged: Record<string, BodyParser> = { ...defaultBodyParsers };
  for (const [key, value] of Object.entries(option)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Parse `raw` bytes according to the `Content-Type` header.
 *
 * - Empty buffer → `undefined` (regardless of Content-Type).
 * - Parsing disabled (`parsers === false`) → raw `Buffer`.
 * - No matching parser → raw `Buffer`.
 * - Matching parser → parser's return value.
 */
export function parseRequestBody(
  raw: Buffer,
  headers: Record<string, string | string[]>,
  parsers: Record<string, BodyParser> | false,
): unknown {
  if (raw.length === 0) return undefined;
  if (parsers === false) return raw;

  const media = parseMediaType(headers['content-type'] as string | string[] | undefined);
  const parser = lookupParser(media.type, parsers);
  if (!parser) return raw;

  return parser(raw, media);
}
