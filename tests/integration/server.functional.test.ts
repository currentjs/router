import { describe, it, expect, beforeAll, afterAll } from '../lib.js';
import { Controller, Get, Post, Render } from '../../src/decorators/RouteDecorators.js';
import { createWebServer } from '../../src/server/createWebServer.js';
import * as http from 'http';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
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
