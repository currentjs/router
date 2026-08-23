import { describe, it, expect, beforeAll, afterAll } from '../lib.js';
import { Controller, Get, Post, Render } from '../../src/decorators/RouteDecorators.js';
import { createWebServer } from '../../src/server/createWebServer.js';
import { BaseHttpError } from '../../src/errors/BaseHttpError.js';
import { GatewayTimeoutError, ServiceNotAvailableError, UnprocessableContentError } from '../../src/errors/HttpErrors.js';
import * as http from 'http';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function request(method: string, url: string, body?: any, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json?: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined;
    const req = http.request({ method, hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', ...(headers || {}), ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const ct = res.headers['content-type'] || '';
        const isJson = typeof ct === 'string' && ct.includes('application/json');
        resolve({ status: res.statusCode || 0, text, json: isJson ? JSON.parse(text || '{}') : undefined });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

@Controller('/api')
class ApiController {
  @Get('/hello/:name')
  async hello(ctx: any) {
    return { message: `Hello ${ctx.request.parameters.name}` };
  }

  @Post('/echo')
  async echo(ctx: any) {
    return ctx.request.body;
  }

  @Get('/text')
  async text() {
    return 'plain text';
  }

  @Get('/render')
  @Render('page.html', 'main')
  async render() {
    return { title: 'Hi' };
  }
}

// Controller that intentionally registers the parametric route BEFORE the static one.
@Controller('/items')
class ItemsController {
  @Get('/:id')
  async getById(ctx: any) {
    return { via: 'getById', id: ctx.request.parameters.id };
  }

  @Get('/new')
  async getNew() {
    return { via: 'getNew' };
  }

  // Same param-count conflict: /:id/edit registered before /new/edit.
  @Get('/:id/edit')
  async editById(ctx: any) {
    return { via: 'editById', id: ctx.request.parameters.id };
  }

  @Get('/new/edit')
  async editNew() {
    return { via: 'editNew' };
  }
}

// Catch-all controller registered AFTER ItemsController — its /:slug must not
// swallow /items/new which is a fully-static route in ItemsController.
@Controller('')
class CatchAllController {
  @Get('/:slug')
  async catchAll(ctx: any) {
    return { via: 'catchAll', slug: ctx.request.parameters.slug };
  }
}

class PaymentRequiredByCustomClassError extends BaseHttpError {
  constructor(msg: string) {
    super(402, msg);
  }
}

@Controller('/errors')
class ErrorController {
  @Get('/unprocessable')
  async unprocessable() {
    throw new UnprocessableContentError('Title is required');
  }

  @Get('/unavailable')
  async unavailable() {
    throw new ServiceNotAvailableError('Maintenance');
  }

  @Get('/gateway-timeout')
  async gatewayTimeout() {
    throw new GatewayTimeoutError('Upstream did not answer');
  }

  @Get('/custom')
  async custom() {
    throw new PaymentRequiredByCustomClassError('Subscription expired');
  }

  @Get('/plain')
  async plain() {
    throw new Error('something went wrong');
  }
}

describe('createWebServer functional', () => {
  let server: any;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'router-tests-'));
    writeFileSync(join(tmpDir, 'index.html'), '<html><body>Home</body></html>', 'utf8');
    writeFileSync(join(tmpDir, 'about.html'), '<html><body>About</body></html>', 'utf8');

    const web = createWebServer({ controllers: [new ApiController()], webDir: tmpDir }, {
      port: 0,
      renderer: async (tpl, data, layout) => `<html data-layout="${layout}"><body>${tpl}:${data.title}</body></html>`
    });
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const address = s.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles parameterized route and returns JSON', async () => {
    const res = await request('GET', `${baseUrl}/api/hello/John`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ message: 'Hello John' });
  });

  it('handles POST with JSON body', async () => {
    const res = await request('POST', `${baseUrl}/api/echo`, { ok: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  });

  it('returns plain text when handler returns string', async () => {
    const res = await request('GET', `${baseUrl}/api/text`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('plain text');
  });

  it('renders HTML when Render decorator and renderer provided', async () => {
    const res = await request('GET', `${baseUrl}/api/render`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<html');
    expect(res.text).toContain('page.html:Hi');
  });

  it('serves static files when no route matches', async () => {
    const res = await request('GET', `${baseUrl}/about.html`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('About');
  });

  it('returns 404 for missing route and missing static file', async () => {
    const res = await request('GET', `${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Not Found' });
  });
});

describe('error mapping', () => {
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    const web = createWebServer({ controllers: [new ErrorController()] });
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const address = s.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('maps UnprocessableContentError to 422', async () => {
    const res = await request('GET', `${baseUrl}/errors/unprocessable`);
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ error: 'Title is required' });
  });

  it('maps ServiceNotAvailableError to 503', async () => {
    const res = await request('GET', `${baseUrl}/errors/unavailable`);
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: 'Maintenance' });
  });

  it('maps GatewayTimeoutError to 504', async () => {
    const res = await request('GET', `${baseUrl}/errors/gateway-timeout`);
    expect(res.status).toBe(504);
    expect(res.json).toEqual({ error: 'Upstream did not answer' });
  });

  it('maps a consumer-defined BaseHttpError subclass to its own status', async () => {
    const res = await request('GET', `${baseUrl}/errors/custom`);
    expect(res.status).toBe(402);
    expect(res.json).toEqual({ error: 'Subscription expired' });
  });

  it('maps a non-HTTP error to 500 without leaking the internal error message', async () => {
    const res = await request('GET', `${baseUrl}/errors/plain`);
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'Internal Server Error' });
  });
});

describe('static index.html routing', () => {
  let server: any;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'router-index-tests-'));
    writeFileSync(join(tmpDir, 'index.html'), '<html><body>Root Index</body></html>', 'utf8');
    mkdirSync(join(tmpDir, 'pages'));
    writeFileSync(join(tmpDir, 'pages', 'index.html'), '<html><body>Pages Index</body></html>', 'utf8');

    const web = createWebServer({ controllers: [new ApiController()], webDir: tmpDir }, { port: 0 });
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const address = s.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET / serves root index.html', async () => {
    const res = await request('GET', `${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Root Index');
  });

  it('GET /pages serves pages/index.html', async () => {
    const res = await request('GET', `${baseUrl}/pages`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pages Index');
  });

  it('GET /pages/ (trailing slash) also serves pages/index.html', async () => {
    const res = await request('GET', `${baseUrl}/pages/`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pages Index');
  });

  it('GET /pages/index.html serves the file directly', async () => {
    const res = await request('GET', `${baseUrl}/pages/index.html`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Pages Index');
  });
});

describe('route matching order', () => {
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    const web = createWebServer({
      controllers: [new ItemsController(), new CatchAllController()],
    });
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const address = s.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('static route /items/new wins over parametric /:id registered earlier', async () => {
    const res = await request('GET', `${baseUrl}/items/new`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ via: 'getNew' });
  });

  it('parametric route still works for a real id', async () => {
    const res = await request('GET', `${baseUrl}/items/42`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ via: 'getById', id: '42' });
  });

  it('static /items/new/edit wins over /:id/edit (same param count, static segment first)', async () => {
    const res = await request('GET', `${baseUrl}/items/new/edit`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ via: 'editNew' });
  });

  it('parametric /items/:id/edit still works for a real id', async () => {
    const res = await request('GET', `${baseUrl}/items/99/edit`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ via: 'editById', id: '99' });
  });

  it('catch-all /:slug in a later controller does not shadow static /items/new', async () => {
    const res = await request('GET', `${baseUrl}/items/new`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ via: 'getNew' });
  });

  it('catch-all /:slug works for a path with no other match', async () => {
    const res = await request('GET', `${baseUrl}/something`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ via: 'catchAll', slug: 'something' });
  });
});
