import { describe, it, expect } from '../lib.js';
import {
  parseMediaType,
  decodeWithCharset,
  lookupParser,
  defaultBodyParsers,
  resolveBodyParsers,
  parseRequestBody,
} from '../../src/utils/bodyParsing.js';
import { BadRequestError, UnsupportedMediaTypeError } from '../../src/errors/HttpErrors.js';

// ─── parseMediaType ───────────────────────────────────────────────────────

describe('parseMediaType', () => {
  it('returns empty MediaType for undefined header', () => {
    const m = parseMediaType(undefined);
    expect(m.type).toBe('');
    expect(m.charset).toBe(undefined);
    expect(m.parameters).toEqual({});
  });

  it('returns empty MediaType for empty string', () => {
    const m = parseMediaType('');
    expect(m.type).toBe('');
  });

  it('parses a simple type with no parameters', () => {
    const m = parseMediaType('application/json');
    expect(m.type).toBe('application/json');
    expect(m.charset).toBe(undefined);
  });

  it('lowercases the type', () => {
    const m = parseMediaType('Application/JSON');
    expect(m.type).toBe('application/json');
  });

  it('parses charset parameter', () => {
    const m = parseMediaType('application/json; charset=UTF-8');
    expect(m.charset).toBe('utf-8');
    expect(m.parameters['charset']).toBe('utf-8');
  });

  it('strips surrounding quotes from parameter values', () => {
    const m = parseMediaType('text/html; charset="utf-8"');
    expect(m.charset).toBe('utf-8');
  });

  it('parses multiple parameters', () => {
    const m = parseMediaType('multipart/form-data; boundary=----boundary; charset=utf-8');
    expect(m.parameters['boundary']).toBe('----boundary');
    expect(m.parameters['charset']).toBe('utf-8');
  });

  it('uses only the first value when given an array header', () => {
    const m = parseMediaType(['application/json; charset=utf-8', 'text/plain']);
    expect(m.type).toBe('application/json');
    expect(m.charset).toBe('utf-8');
  });

  it('handles whitespace around parameters', () => {
    const m = parseMediaType('text/plain ;  charset = iso-8859-1 ');
    expect(m.type).toBe('text/plain');
    expect(m.charset).toBe('iso-8859-1');
  });
});

// ─── decodeWithCharset ────────────────────────────────────────────────────

describe('decodeWithCharset', () => {
  it('defaults to utf-8 when charset is undefined', () => {
    const buf = Buffer.from('hello', 'utf8');
    expect(decodeWithCharset(buf, undefined)).toBe('hello');
  });

  it('decodes utf-8', () => {
    const buf = Buffer.from('héllo', 'utf8');
    expect(decodeWithCharset(buf, 'utf-8')).toBe('héllo');
  });

  it('decodes utf8 alias', () => {
    const buf = Buffer.from('world', 'utf8');
    expect(decodeWithCharset(buf, 'utf8')).toBe('world');
  });

  it('decodes latin1 / iso-8859-1', () => {
    // é in latin1 is 0xe9
    const buf = Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f]);
    expect(decodeWithCharset(buf, 'latin1')).toBe('héllo');
    expect(decodeWithCharset(buf, 'iso-8859-1')).toBe('héllo');
  });

  it('throws UnsupportedMediaTypeError for an unknown charset', () => {
    const buf = Buffer.from('x');
    let thrown = false;
    try {
      decodeWithCharset(buf, 'shift-jis');
    } catch (e) {
      thrown = true;
      expect(e instanceof UnsupportedMediaTypeError).toBeTruthy();
    }
    expect(thrown).toBeTruthy('should have thrown for unsupported charset');
  });
});

// ─── lookupParser ─────────────────────────────────────────────────────────

describe('lookupParser', () => {
  const parsers = { ...defaultBodyParsers };

  it('finds exact match for application/json', () => {
    expect(lookupParser('application/json', parsers)).toBeDefined();
  });

  it('finds +json suffix for application/ld+json', () => {
    expect(lookupParser('application/ld+json', parsers)).toBeDefined();
    // Should be the same parser as plain json
    expect(lookupParser('application/ld+json', parsers)).toBe(parsers['+json']);
  });

  it('finds text/* wildcard for text/plain', () => {
    expect(lookupParser('text/plain', parsers)).toBeDefined();
  });

  it('finds text/* wildcard for text/csv', () => {
    expect(lookupParser('text/csv', parsers)).toBeDefined();
  });

  it('returns undefined for an unknown type with no wildcard fallback', () => {
    const limited: Record<string, any> = { 'application/json': parsers['application/json'] };
    expect(lookupParser('image/png', limited)).toBe(undefined);
  });

  it('exact match beats wildcard', () => {
    const specialJson = () => 'special';
    const custom = { ...parsers, 'application/json': specialJson as any };
    expect(lookupParser('application/json', custom)).toBe(specialJson);
  });

  it('suffix match beats wildcard', () => {
    const suffixParser = () => 'suffix';
    const custom = { ...parsers, '+json': suffixParser as any };
    expect(lookupParser('application/vnd.api+json', custom)).toBe(suffixParser);
  });

  it('falls back to */* when present', () => {
    const catchAll = () => 'all';
    const custom = { '*/*': catchAll as any };
    expect(lookupParser('image/jpeg', custom)).toBe(catchAll);
  });

  it('returns undefined for empty media type', () => {
    expect(lookupParser('', parsers)).toBe(undefined);
  });
});

// ─── default json parser ──────────────────────────────────────────────────

describe('defaultBodyParsers: application/json', () => {
  const jsonParser = defaultBodyParsers['application/json'];
  const media = parseMediaType('application/json');

  it('parses valid JSON', () => {
    const buf = Buffer.from('{"a":1}');
    expect(jsonParser(buf, media)).toEqual({ a: 1 });
  });

  it('parses JSON arrays', () => {
    const buf = Buffer.from('[1,2,3]');
    expect(jsonParser(buf, media)).toEqual([1, 2, 3]);
  });

  it('throws BadRequestError for invalid JSON', () => {
    const buf = Buffer.from('{bad json}');
    let thrown = false;
    try {
      jsonParser(buf, media);
    } catch (e) {
      thrown = true;
      expect(e instanceof BadRequestError).toBeTruthy();
    }
    expect(thrown).toBeTruthy('should throw for malformed JSON');
  });

  it('strips a UTF-8 BOM before parsing', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const json = Buffer.from('{"bom":true}');
    const buf = Buffer.concat([bom, json]);
    expect(jsonParser(buf, media)).toEqual({ bom: true });
  });
});

// ─── default urlencoded parser ────────────────────────────────────────────

describe('defaultBodyParsers: application/x-www-form-urlencoded', () => {
  const parser = defaultBodyParsers['application/x-www-form-urlencoded'];
  const media = parseMediaType('application/x-www-form-urlencoded');

  it('parses simple key=value pairs', () => {
    const buf = Buffer.from('name=John&age=30');
    expect(parser(buf, media)).toEqual({ name: 'John', age: '30' });
  });

  it('URL-decodes values', () => {
    const buf = Buffer.from('email=john%40doe.com');
    expect(parser(buf, media)).toEqual({ email: 'john@doe.com' });
  });

  it('converts repeated keys to arrays', () => {
    const buf = Buffer.from('tag=a&tag=b&tag=c');
    const result = parser(buf, media) as any;
    expect(result.tag).toEqual(['a', 'b', 'c']);
  });

  it('leaves single-occurrence keys as strings, not arrays', () => {
    const buf = Buffer.from('name=Alice');
    const result = parser(buf, media) as any;
    expect(result.name).toBe('Alice');
  });

  it('handles empty value', () => {
    const buf = Buffer.from('key=');
    const result = parser(buf, media) as any;
    expect(result.key).toBe('');
  });
});

// ─── default text/* parser ────────────────────────────────────────────────

describe('defaultBodyParsers: text/*', () => {
  const parser = defaultBodyParsers['text/*'];

  it('decodes text/plain as a string', () => {
    const media = parseMediaType('text/plain');
    const buf = Buffer.from('hello world', 'utf8');
    expect(parser(buf, media)).toBe('hello world');
  });

  it('respects charset parameter', () => {
    const media = parseMediaType('text/plain; charset=latin1');
    const buf = Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f]); // héllo in latin1
    expect(parser(buf, media)).toBe('héllo');
  });
});

// ─── default multipart parser ─────────────────────────────────────────────

describe('defaultBodyParsers: multipart/form-data', () => {
  it('throws UnsupportedMediaTypeError', () => {
    const parser = defaultBodyParsers['multipart/form-data'];
    const media = parseMediaType('multipart/form-data; boundary=x');
    let thrown = false;
    try {
      parser(Buffer.from('x'), media);
    } catch (e) {
      thrown = true;
      expect(e instanceof UnsupportedMediaTypeError).toBeTruthy();
    }
    expect(thrown).toBeTruthy('should throw for multipart');
  });
});

// ─── resolveBodyParsers ───────────────────────────────────────────────────

describe('resolveBodyParsers', () => {
  it('returns defaults when option is undefined', () => {
    const resolved = resolveBodyParsers(undefined);
    expect(resolved).toBeDefined();
    expect((resolved as any)['application/json']).toBeDefined();
  });

  it('returns false when option is false', () => {
    expect(resolveBodyParsers(false)).toBe(false);
  });

  it('overrides a default with a custom parser', () => {
    const custom = () => 'custom';
    const resolved = resolveBodyParsers({ 'application/json': custom as any });
    expect((resolved as any)['application/json']).toBe(custom);
  });

  it('adds a new media type without disturbing defaults', () => {
    const custom = () => 'xml';
    const resolved = resolveBodyParsers({ 'application/xml': custom as any }) as Record<string, any>;
    expect(resolved['application/xml']).toBe(custom);
    expect(resolved['application/json']).toBeDefined();
  });

  it('removes a default when its value is null', () => {
    const resolved = resolveBodyParsers({ 'application/json': null }) as Record<string, any>;
    expect(resolved['application/json']).toBe(undefined);
    expect(resolved['application/x-www-form-urlencoded']).toBeDefined();
  });
});

// ─── parseRequestBody ─────────────────────────────────────────────────────

describe('parseRequestBody', () => {
  const parsers = resolveBodyParsers(undefined) as Record<string, any>;

  it('returns undefined for an empty buffer', () => {
    const result = parseRequestBody(Buffer.alloc(0), { 'content-type': 'application/json' }, parsers);
    expect(result).toBe(undefined);
  });

  it('returns a Buffer when parsers is false', () => {
    const buf = Buffer.from('{"a":1}');
    const result = parseRequestBody(buf, { 'content-type': 'application/json' }, false);
    expect(result instanceof Buffer).toBeTruthy();
  });

  it('parses application/json to an object', () => {
    const buf = Buffer.from('{"x":42}');
    const result = parseRequestBody(buf, { 'content-type': 'application/json' }, parsers);
    expect(result).toEqual({ x: 42 });
  });

  it('returns a Buffer when no Content-Type header is present', () => {
    const buf = Buffer.from('some data');
    const result = parseRequestBody(buf, {}, parsers);
    expect(result instanceof Buffer).toBeTruthy();
  });

  it('returns a Buffer for an unrecognised content type', () => {
    const buf = Buffer.from('\x89PNG');
    const result = parseRequestBody(buf, { 'content-type': 'image/png' }, parsers);
    expect(result instanceof Buffer).toBeTruthy();
  });

  it('throws BadRequestError for malformed JSON', () => {
    const buf = Buffer.from('{broken}');
    let thrown = false;
    try {
      parseRequestBody(buf, { 'content-type': 'application/json' }, parsers);
    } catch (e) {
      thrown = true;
      expect(e instanceof BadRequestError).toBeTruthy();
    }
    expect(thrown).toBeTruthy('should throw for bad JSON');
  });

  it('parses application/ld+json via +json suffix lookup', () => {
    const buf = Buffer.from('{"@context":"http://schema.org"}');
    const result = parseRequestBody(buf, { 'content-type': 'application/ld+json' }, parsers);
    expect(result).toEqual({ '@context': 'http://schema.org' });
  });
});
