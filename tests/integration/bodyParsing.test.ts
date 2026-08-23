import { describe, it, expect, beforeAll, afterAll } from '../lib.js';
import { Controller, Post, Render } from '../../src/decorators/RouteDecorators.js';
import { createWebServer } from '../../src/server/createWebServer.js';
import * as http from 'http';

// ─── Helpers ──────────────────────────────────────────────────────────────

interface Response {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

function rawRequest(
  method: string,
  url: string,
  body: Buffer | string | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body instanceof Buffer ? body : body ? Buffer.from(body) : undefined;
    const reqHeaders: Record<string, string> = { ...headers };
    if (data) reqHeaders['Content-Length'] = String(data.length);

    const req = http.request(
      { method, hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, headers: reqHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function jsonRequest(method: string, url: string, body: any): Promise<Response> {
  return rawRequest(method, url, JSON.stringify(body), { 'Content-Type': 'application/json' });
}

// ─── Controllers ──────────────────────────────────────────────────────────

@Controller('/api')
class EchoController {
  @Post('/echo')
  async echo(ctx: any) {
    const { body, rawBody } = ctx.request;
    // Return special shape so tests can inspect both
    return { body, rawBodyHex: rawBody.toString('hex'), rawBodyLength: rawBody.length };
  }

  @Post('/rawbody')
  async rawBodyOnly(ctx: any) {
    return { hex: ctx.request.rawBody.toString('hex') };
  }
}

@Controller('/web')
class RenderController {
  @Post('/form')
  @Render('form.html', 'layout')
  async form(ctx: any) {
    return { title: ctx.request.body?.title ?? 'no title' };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('body parsing — defaults', () => {
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    const web = createWebServer(
      { controllers: [new EchoController()] },
      {
        port: 0,
        renderer: async (tpl, data) => `<html><body>${tpl}:${data.title}</body></html>`,
      },
    );
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { await server.close(); });

  // --- JSON ---

  it('parses application/json to an object', async () => {
    const res = await jsonRequest('POST', `${baseUrl}/api/echo`, { ok: true });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.body).toEqual({ ok: true });
  });

  it('returns 400 for malformed JSON with Content-Type application/json', async () => {
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, '{bad json}', {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.text);
    expect(parsed.error).toContain('Invalid JSON');
  });

  it('parses application/ld+json via +json suffix lookup', async () => {
    const res = await rawRequest(
      'POST',
      `${baseUrl}/api/echo`,
      '{"@context":"http://schema.org"}',
      { 'Content-Type': 'application/ld+json' },
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.body).toEqual({ '@context': 'http://schema.org' });
  });

  // --- urlencoded ---

  it('parses application/x-www-form-urlencoded to an object', async () => {
    const res = await rawRequest(
      'POST',
      `${baseUrl}/api/echo`,
      'name=Alice&age=30',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.body).toEqual({ name: 'Alice', age: '30' });
  });

  it('converts repeated urlencoded keys to arrays', async () => {
    const res = await rawRequest(
      'POST',
      `${baseUrl}/api/echo`,
      'tag=a&tag=b&tag=c',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.body.tag).toEqual(['a', 'b', 'c']);
  });

  // --- text/* ---

  it('parses text/plain to a string', async () => {
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, 'hello world', {
      'Content-Type': 'text/plain',
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.body).toBe('hello world');
  });

  // --- multipart ---

  it('returns 415 for multipart/form-data', async () => {
    const res = await rawRequest(
      'POST',
      `${baseUrl}/api/echo`,
      '--boundary\r\nContent-Disposition: form-data; name="x"\r\n\r\nvalue\r\n--boundary--',
      { 'Content-Type': 'multipart/form-data; boundary=boundary' },
    );
    expect(res.status).toBe(415);
  });

  // --- unknown / missing Content-Type ---

  it('delivers raw Buffer for unknown content type', async () => {
    const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, data, {
      'Content-Type': 'application/octet-stream',
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.rawBodyHex).toBe(data.toString('hex'));
  });

  it('delivers raw Buffer when Content-Type is absent', async () => {
    const data = Buffer.from('binary data');
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, data);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.rawBodyHex).toBe(data.toString('hex'));
  });

  // --- empty body ---

  it('gives undefined body for an empty body even with Content-Type application/json', async () => {
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, undefined, {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    // JSON.stringify({body: undefined, ...}) omits the key, so parsed.body is undefined (missing key)
    expect(parsed.body === undefined).toBeTruthy('body should be absent/undefined for empty body');
    expect(parsed.rawBodyLength).toBe(0);
  });

  // --- rawBody ---

  it('rawBody contains exact bytes sent', async () => {
    const payload = '{"hello":"world"}';
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, payload, {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.rawBodyHex).toBe(Buffer.from(payload).toString('hex'));
  });

  // --- unregistered path ---

  it('returns 404 (not 400) for malformed JSON sent to an unregistered path', async () => {
    const res = await rawRequest('POST', `${baseUrl}/api/nonexistent`, '{bad json}', {
      'Content-Type': 'application/json',
    });
    // Body is never parsed when the route doesn't match
    expect(res.status).toBe(404);
  });
});

// ─── bodyParsers: false ───────────────────────────────────────────────────

describe('body parsing — bodyParsers: false', () => {
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    const web = createWebServer(
      { controllers: [new EchoController()] },
      { port: 0, bodyParsers: false },
    );
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { await server.close(); });

  it('delivers a raw Buffer even for application/json when bodyParsers is false', async () => {
    const payload = '{"a":1}';
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, payload, {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.rawBodyHex).toBe(Buffer.from(payload).toString('hex'));
    // body itself is a Buffer (JSON.stringify gives {type:'Buffer',data:[...]})
    expect(parsed.body?.type).toBe('Buffer');
  });

  it('does not return 400 for malformed JSON when bodyParsers is false', async () => {
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, '{bad json}', {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(200);
  });
});

// ─── Custom parser ────────────────────────────────────────────────────────

describe('body parsing — custom parser', () => {
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    const web = createWebServer(
      { controllers: [new EchoController()] },
      {
        port: 0,
        bodyParsers: {
          'application/xml': (raw) => ({ xml: raw.toString('utf8').trim() }),
        },
      },
    );
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { await server.close(); });

  it('uses the custom parser for application/xml', async () => {
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, '<root/>', {
      'Content-Type': 'application/xml',
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.body).toEqual({ xml: '<root/>' });
  });

  it('still uses default json parser when not overridden', async () => {
    const res = await jsonRequest('POST', `${baseUrl}/api/echo`, { still: 'json' });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.body).toEqual({ still: 'json' });
  });
});

// ─── Remove default parser via null ──────────────────────────────────────

describe('body parsing — remove default parser with null', () => {
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    const web = createWebServer(
      { controllers: [new EchoController()] },
      {
        port: 0,
        bodyParsers: {
          'application/json': null,
        },
      },
    );
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { await server.close(); });

  it('delivers raw Buffer for application/json when json parser is removed', async () => {
    const payload = '{"a":1}';
    const res = await rawRequest('POST', `${baseUrl}/api/echo`, payload, {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed.body?.type).toBe('Buffer');
  });
});

// ─── @Render route: bad JSON → HTML error page ────────────────────────────

describe('body parsing — malformed JSON on @Render route', () => {
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    const web = createWebServer(
      { controllers: [new RenderController()] },
      {
        port: 0,
        renderer: async (tpl, data, layout) => `<html data-layout="${layout ?? ''}"><body>${tpl}:${(data as any).title ?? (data as any).error}</body></html>`,
        errorTemplate: 'error.html',
      },
    );
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { await server.close(); });

  it('renders the errorTemplate as HTML (not JSON) when JSON body is malformed', async () => {
    const res = await rawRequest('POST', `${baseUrl}/web/form`, '{bad json}', {
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(400);
    const ct = String(res.headers['content-type'] || '');
    expect(ct).toContain('text/html');
    expect(res.text).toContain('error.html');
  });
});
