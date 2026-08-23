import { describe, it, expect, beforeAll, afterAll } from '../lib.js';
import { Controller, Get, Render } from '../../src/decorators/RouteDecorators.js';
import { createWebServer } from '../../src/server/createWebServer.js';
import { NotFoundError } from '../../src/errors/HttpErrors.js';
import * as http from 'http';

interface Response {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * `Connection: close` keeps `server.close()` in the teardown hook from waiting
 * out the keep-alive timeout on an idle socket.
 */
function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const reqHeaders = { Connection: 'close', ...headers };
    const req = http.request({ method, hostname: '127.0.0.1', port, path, headers: reqHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Echoes back whether a layout was supplied, so a full-page render and a bare
 * fragment are distinguishable from the response body alone.
 */
const renderer = (template: string, data: any, layout?: string) => {
  const fragment = `[fragment ${template} ${JSON.stringify(data)}]`;
  return layout === undefined ? fragment : `[layout ${layout}]${fragment}`;
};

const PARTIAL = { 'X-Partial-Content': 'true' };

@Controller('/web')
class PageController {
  @Get('/page')
  @Render('page.html', 'main.html')
  async page() {
    return { title: 'Page' };
  }

  @Get('/bare')
  @Render('bare.html')
  async bare() {
    return { title: 'Bare' };
  }

  @Get('/boom')
  @Render('boom.html', 'main.html')
  async boom(): Promise<never> {
    throw new NotFoundError('No such post');
  }

  @Get('/json')
  async json() {
    return { title: 'Json' };
  }
}

describe('partial content — successful renders', () => {
  let server: any;
  let port: number;

  beforeAll(async () => {
    const web = createWebServer(
      { controllers: [new PageController()] },
      { port: 0, renderer, errorTemplate: 'error.html', jwt: false },
    );
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await server.close();
  });

  it('applies the layout when no X-Partial-Content header is sent', async () => {
    const res = await request(port, '/web/page');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('[layout main.html]');
    expect(res.text).toContain('[fragment page.html');
  });

  it('skips the layout for X-Partial-Content: true', async () => {
    const res = await request(port, '/web/page', PARTIAL);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toNotContain('[layout');
    expect(res.text).toBe('[fragment page.html {"title":"Page"}]');
  });

  it('still reports the skipped layout in X-Layout on a partial response', async () => {
    const res = await request(port, '/web/page', PARTIAL);
    expect(res.headers['x-layout']).toBe('main.html');
  });

  it('reports the applied layout in X-Layout on a full response', async () => {
    const res = await request(port, '/web/page');
    expect(res.headers['x-layout']).toBe('main.html');
  });

  it('treats X-Partial-Content: false as a full-page request', async () => {
    const res = await request(port, '/web/page', { 'X-Partial-Content': 'false' });
    expect(res.text).toContain('[layout main.html]');
  });

  it('requires the exact value "true" — any other value renders the full page', async () => {
    for (const value of ['TRUE', 'True', '1', 'yes', '']) {
      const res = await request(port, '/web/page', { 'X-Partial-Content': value });
      expect(res.text).toContain('[layout main.html]', `value ${JSON.stringify(value)} was treated as partial`);
    }
  });

  it('sends an empty X-Layout for a route declared without a layout', async () => {
    const res = await request(port, '/web/bare');
    expect(res.status).toBe(200);
    expect(res.headers['x-layout']).toBe('');
    expect(res.text).toBe('[fragment bare.html {"title":"Bare"}]');
  });

  it('returns the same body for a layout-less route whether or not the header is sent', async () => {
    const full = await request(port, '/web/bare');
    const partial = await request(port, '/web/bare', PARTIAL);
    expect(partial.text).toBe(full.text);
    expect(partial.headers['x-layout']).toBe('');
  });

  it('answers HEAD on a partial request with no body but the fragment Content-Length', async () => {
    const body = await request(port, '/web/page', PARTIAL);
    const head = await request(port, '/web/page', PARTIAL, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(body.text));
    expect(head.headers['x-layout']).toBe('main.html');
  });

  it('reports a smaller Content-Length for a partial HEAD than a full HEAD', async () => {
    const partial = await request(port, '/web/page', PARTIAL, 'HEAD');
    const full = await request(port, '/web/page', {}, 'HEAD');
    expect(Number(partial.headers['content-length']) < Number(full.headers['content-length'])).toBeTruthy();
  });

  it('ignores the header on a non-rendered route and sets no X-Layout', async () => {
    const res = await request(port, '/web/json', PARTIAL);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.text)).toEqual({ title: 'Json' });
    expect(res.headers['x-layout']).toBe(undefined);
  });
});

describe('partial content — error templates', () => {
  let server: any;
  let port: number;

  beforeAll(async () => {
    const web = createWebServer(
      { controllers: [new PageController()] },
      { port: 0, renderer, errorTemplate: 'error.html', jwt: false },
    );
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await server.close();
  });

  it('renders the error template with the layout on a full request', async () => {
    const res = await request(port, '/web/boom');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('[layout main.html]');
    expect(res.text).toContain('[fragment error.html');
    expect(res.text).toContain('"error":"No such post"');
    expect(res.text).toContain('"statusCode":404');
  });

  it('renders the error template without the layout on a partial request', async () => {
    const res = await request(port, '/web/boom', PARTIAL);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toNotContain('[layout');
    expect(res.text).toContain('[fragment error.html');
  });

  it('does not set X-Layout on error responses', async () => {
    const full = await request(port, '/web/boom');
    const partial = await request(port, '/web/boom', PARTIAL);
    expect(full.headers['x-layout']).toBe(undefined);
    expect(partial.headers['x-layout']).toBe(undefined);
  });
});

describe('partial content — without a renderer', () => {
  let server: any;
  let port: number;

  beforeAll(async () => {
    // No `renderer` option, so @Render metadata cannot be honoured and the
    // handler result is serialised as JSON instead.
    const web = createWebServer({ controllers: [new PageController()] }, { port: 0, jwt: false });
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await server.close();
  });

  it('falls back to JSON and sets no X-Layout, even for a partial request', async () => {
    const res = await request(port, '/web/page', PARTIAL);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.text)).toEqual({ title: 'Page' });
    expect(res.headers['x-layout']).toBe(undefined);
  });
});
