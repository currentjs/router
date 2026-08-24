import { describe, it, expect, beforeAll, afterAll } from '../lib.js';
import { Controller, Get, Post, Render } from '../../src/decorators/RouteDecorators.js';
import { createWebServer } from '../../src/server/createWebServer.js';
import * as http from 'http';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function request(
  method: string,
  url: string
): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Connection: close keeps server.close() in the teardown hook from waiting
    // out the keep-alive timeout on an idle socket.
    const req = http.request({ method, hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, headers: { Connection: 'close' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

@Controller('/api')
class MethodController {
  @Get('/items')
  async list() {
    return { items: [1, 2, 3] };
  }

  @Post('/items')
  async create() {
    return { created: true };
  }

  @Get('/items/:id')
  async getById(ctx: any) {
    return { id: ctx.request.parameters.id };
  }

  @Get('/page')
  @Render('page.html', 'layout')
  async page() {
    return { title: 'Hi' };
  }

  @Post('/onlypost')
  async onlyPost() {
    return { ok: true };
  }
}

describe('405 / HEAD / OPTIONS', () => {
  let server: any;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'router-method-tests-'));
    writeFileSync(join(tmpDir, 'about.html'), '<html><body>About Page</body></html>', 'utf8');

    const web = createWebServer({ controllers: [new MethodController()], webDir: tmpDir }, {
      port: 0,
      renderer: async (tpl, data, layout) => `<html data-layout="${layout}"><body>${tpl}:${data.title}</body></html>`,
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

  // --- 405 ---

  it('returns 405 with an Allow header when the path exists but not for this method', async () => {
    const res = await request('DELETE', `${baseUrl}/api/items`);
    expect(res.status).toBe(405);
    expect(JSON.parse(res.text)).toEqual({ error: 'Method Not Allowed' });
    expect(res.headers['allow']).toBeDefined();
    const allowed = String(res.headers['allow']).split(', ');
    expect(allowed.includes('GET')).toBeTruthy();
    expect(allowed.includes('POST')).toBeTruthy();
    expect(allowed.includes('HEAD')).toBeTruthy();
    expect(allowed.includes('OPTIONS')).toBeTruthy();
    expect(allowed.includes('DELETE')).toBeFalsy();
  });

  it('returns 405 for a parametric route requested with an unregistered method', async () => {
    const res = await request('PUT', `${baseUrl}/api/items/42`);
    expect(res.status).toBe(405);
    const allowed = String(res.headers['allow']).split(', ');
    expect(allowed.includes('GET')).toBeTruthy();
    expect(allowed.includes('PUT')).toBeFalsy();
  });

  it('still returns 404 for a path that matches no route at all', async () => {
    const res = await request('DELETE', `${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers['allow']).toBeFalsy();
  });

  // --- OPTIONS ---

  it('answers OPTIONS with 204, an empty body, and an Allow header listing every registered method', async () => {
    const res = await request('OPTIONS', `${baseUrl}/api/items`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const allowed = String(res.headers['allow']).split(', ');
    expect(allowed.includes('GET')).toBeTruthy();
    expect(allowed.includes('POST')).toBeTruthy();
    expect(allowed.includes('HEAD')).toBeTruthy();
    expect(allowed.includes('OPTIONS')).toBeTruthy();
  });

  it('answers OPTIONS on a parametric route the same way', async () => {
    const res = await request('OPTIONS', `${baseUrl}/api/items/42`);
    expect(res.status).toBe(204);
    const allowed = String(res.headers['allow']).split(', ');
    expect(allowed.includes('GET')).toBeTruthy();
  });

  it('returns 404 for OPTIONS on a path with no route at all', async () => {
    const res = await request('OPTIONS', `${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
  });

  // --- HEAD ---

  it('answers HEAD on a GET JSON route with an empty body but a matching Content-Length', async () => {
    const getRes = await request('GET', `${baseUrl}/api/items`);
    const headRes = await request('HEAD', `${baseUrl}/api/items`);
    expect(headRes.status).toBe(200);
    expect(headRes.text).toBe('');
    expect(headRes.headers['content-type']).toBe(getRes.headers['content-type']);
    expect(Number(headRes.headers['content-length'])).toBe(Buffer.byteLength(getRes.text));
  });

  it('answers HEAD on a rendered (HTML) GET route with an empty body but a matching Content-Length', async () => {
    const getRes = await request('GET', `${baseUrl}/api/page`);
    const headRes = await request('HEAD', `${baseUrl}/api/page`);
    expect(headRes.status).toBe(200);
    expect(headRes.text).toBe('');
    expect(Number(headRes.headers['content-length'])).toBe(Buffer.byteLength(getRes.text));
  });

  it('answers HEAD on a parametric GET route with an empty body', async () => {
    const res = await request('HEAD', `${baseUrl}/api/items/7`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });

  it('answers HEAD on a static file with an empty body but a matching Content-Length', async () => {
    const getRes = await request('GET', `${baseUrl}/about.html`);
    const headRes = await request('HEAD', `${baseUrl}/about.html`);
    expect(headRes.status).toBe(200);
    expect(headRes.text).toBe('');
    expect(Number(headRes.headers['content-length'])).toBe(Buffer.byteLength(getRes.text));
  });

  it('returns 404 for HEAD on a path with no GET route and no static file', async () => {
    const res = await request('HEAD', `${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
  });

  it('returns 405 for HEAD when the path has routes but none of them is GET', async () => {
    const res = await request('HEAD', `${baseUrl}/api/onlypost`);
    expect(res.status).toBe(405);
    const allowed = String(res.headers['allow']).split(', ');
    expect(allowed.includes('POST')).toBeTruthy();
    expect(allowed.includes('GET')).toBeFalsy();
  });
});
