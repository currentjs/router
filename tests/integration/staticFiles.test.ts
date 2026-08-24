import { describe, it, expect, beforeAll, afterAll } from '../lib.js';
import { Controller, Get } from '../../src/decorators/RouteDecorators.js';
import { createWebServer } from '../../src/server/createWebServer.js';
import * as http from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface Response {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Sends `path` verbatim in the request line. `new URL()` and friends resolve
 * `..` segments client-side, which would defeat the point of these tests — the
 * traversal attempt has to reach the server intact.
 *
 * `Connection: close` keeps `server.close()` in the teardown hook from waiting
 * out the keep-alive timeout on an idle socket.
 */
function rawRequest(port: number, path: string, method = 'GET'): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, hostname: '127.0.0.1', port, path, headers: { Connection: 'close' } }, (res) => {
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

const SECRET = 'TOP_SECRET_OUTSIDE_THE_STATIC_ROOT';

@Controller('/api')
class PingController {
  @Get('/ping')
  async ping() {
    return { ok: true };
  }
}

describe('static files — path traversal', () => {
  let server: any;
  let port: number;
  let root: string; // parent directory, holds the file that must stay unreachable

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'router-traversal-'));
    writeFileSync(join(root, 'secret.txt'), SECRET, 'utf8');

    // The directory actually served.
    const webDir = join(root, 'public');
    mkdirSync(webDir);
    writeFileSync(join(webDir, 'index.html'), '<html><body>Public Index</body></html>', 'utf8');
    mkdirSync(join(webDir, 'assets'));
    writeFileSync(join(webDir, 'assets', 'style.css'), 'body{color:red}', 'utf8');
    // A legitimate filename that contains '..', to prove the guard resolves
    // paths rather than substring-matching on dots.
    writeFileSync(join(webDir, 'v..1.txt'), 'dotted name', 'utf8');

    const web = createWebServer({ controllers: [new PingController()], webDir }, { port: 0, jwt: false });
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  // ── paths that must be served ───────────────────────────────────────────

  it('serves a nested file inside the static root', async () => {
    const res = await rawRequest(port, '/assets/style.css');
    expect(res.status).toBe(200);
    expect(res.text).toBe('body{color:red}');
    expect(res.headers['content-type']).toBe('text/css');
  });

  it('serves a filename that itself contains ".."', async () => {
    const res = await rawRequest(port, '/v..1.txt');
    expect(res.status).toBe(200);
    expect(res.text).toBe('dotted name');
  });

  it('serves a path whose ".." resolves back inside the static root', async () => {
    const res = await rawRequest(port, '/assets/../index.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Public Index');
  });

  // ── paths that must be refused ──────────────────────────────────────────

  const escapes: Array<[string, string]> = [
    ['a parent-relative path', '/../secret.txt'],
    ['a repeated parent-relative path', '/../../../../secret.txt'],
    ['an encoded slash after the dot segment', '/..%2fsecret.txt'],
    ['fully encoded dot segments', '/%2e%2e/secret.txt'],
    ['dot segments climbing out of a real subdirectory', '/assets/../../secret.txt'],
    ['a mixed encoded and literal escape', '/assets/%2e%2e/../secret.txt'],
    ['an absolute system path', '/../../../../../../../etc/passwd'],
    ['a traversal onto a directory', '/../'],
  ];

  for (const [label, path] of escapes) {
    it(`refuses ${label} (${path}) with 404 and no file contents`, async () => {
      const res = await rawRequest(port, path);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.text)).toEqual({ error: 'Not Found' });
      expect(res.text).toNotContain(SECRET);
    });
  }

  it('refuses a traversal on HEAD as well, with no body', async () => {
    const res = await rawRequest(port, '/../secret.txt', 'HEAD');
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
  });

  it('returns 404 for a NUL byte in the path instead of crashing the request', async () => {
    const res = await rawRequest(port, '/%00');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: 'Not Found' });
  });

  it('keeps serving routes and files after a rejected traversal', async () => {
    await rawRequest(port, '/../secret.txt');
    const route = await rawRequest(port, '/api/ping');
    expect(route.status).toBe(200);
    expect(JSON.parse(route.text)).toEqual({ ok: true });
    const file = await rawRequest(port, '/assets/style.css');
    expect(file.status).toBe(200);
  });
});

describe('static files — traversal with an explicit staticDir', () => {
  let server: any;
  let port: number;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'router-traversal-static-'));
    writeFileSync(join(root, 'secret.txt'), SECRET, 'utf8');
    const staticDir = join(root, 'assets');
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, 'app.js'), 'console.log(1)', 'utf8');

    const web = createWebServer({ controllers: [new PingController()] }, { port: 0, staticDir, jwt: false });
    const s = await web.listen(0, '127.0.0.1');
    server = web;
    const addr = s.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves a file from staticDir', async () => {
    const res = await rawRequest(port, '/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe('console.log(1)');
  });

  it('refuses to climb out of staticDir', async () => {
    const res = await rawRequest(port, '/../secret.txt');
    expect(res.status).toBe(404);
    expect(res.text).toNotContain(SECRET);
  });
});
