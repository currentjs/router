import { describe, it, expect } from '../lib.js';
import { createHmac } from 'crypto';
import { createWebServer } from '../../src/server/createWebServer.js';
import { Controller, Get, Render } from '../../src/decorators/RouteDecorators.js';
import * as http from 'http';

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signHS256(header: object, payload: object, secret: string) {
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const sig = base64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function makeExpiredToken(secret: string): string {
  const exp = Math.floor(Date.now() / 1000) - 3600;
  return signHS256({ alg: 'HS256', typ: 'JWT' }, { id: '99', role: 'user', exp }, secret);
}

function makeValidToken(secret: string, payload: object = {}): string {
  return signHS256({ alg: 'HS256', typ: 'JWT' }, { id: '1', role: 'user', ...payload }, secret);
}

function request(opts: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; json?: any; contentType: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(opts.url);
    const req = http.request(
      {
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: Number(u.port),
        path: u.pathname + u.search,
        // Connection: close keeps server.close() in the teardown hook from
        // waiting out the keep-alive timeout on an idle socket.
        headers: { Connection: 'close', ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const ct = (res.headers['content-type'] as string) || '';
          const isJson = ct.includes('application/json');
          resolve({
            status: res.statusCode || 0,
            json: isJson ? JSON.parse(text || '{}') : undefined,
            contentType: ct,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Controllers ────────────────────────────────────────────────────────────

@Controller('/auth')
class AuthController {
  @Get('/me')
  async me(ctx: any) {
    return ctx.request.user || null;
  }

  @Get('/public')
  async publicRoute(_ctx: any) {
    return { ok: true };
  }
}

@Controller('/render')
class RenderController {
  @Render('mytemplate', 'mylayout')
  @Get('/page')
  async page(ctx: any) {
    return { user: ctx.request.user };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function withServer(
  opts: Parameters<typeof createWebServer>[1],
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const web = createWebServer({ controllers: [new AuthController()] }, opts);
  const s = await web.listen(0, '127.0.0.1');
  const addr = s.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await web.close();
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('JWT auth extraction', () => {
  it('extracts HS256 JWT from Authorization header when JWT_SECRET is set', async () => {
    const secret = 'testsecret';
    process.env.JWT_SECRET = secret;
    await withServer({}, async (baseUrl) => {
      const token = makeValidToken(secret, { email: 'a@b.c' });
      const res = await request({ url: `${baseUrl}/auth/me`, headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ id: '1', role: 'user', email: 'a@b.c' });
    });
  });

  it('extracts JWT from authToken cookie', async () => {
    const secret = 'cookiesecret';
    process.env.JWT_SECRET = secret;
    await withServer({}, async (baseUrl) => {
      const token = makeValidToken(secret);
      const res = await request({ url: `${baseUrl}/auth/me`, headers: { cookie: `authToken=${token}` } });
      expect(res.status).toBe(200);
      expect(res.json.id).toBe('1');
    });
  });

  it('returns 200 with no user for anonymous request', async () => {
    process.env.JWT_SECRET = 'sec';
    await withServer({}, async (baseUrl) => {
      const res = await request({ url: `${baseUrl}/auth/me` });
      expect(res.status).toBe(200);
      // handler returns `ctx.request.user || null`; server serialises null as {} via `result ?? {}`
      expect(res.json).toEqual({});
    });
  });

  it('returns 401 for expired token', async () => {
    const secret = 'expsecret';
    process.env.JWT_SECRET = secret;
    await withServer({}, async (baseUrl) => {
      const token = makeExpiredToken(secret);
      const res = await request({ url: `${baseUrl}/auth/me`, headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'Token expired' });
    });
  });

  it('returns 401 for tampered signature', async () => {
    const secret = 'tampsecret';
    process.env.JWT_SECRET = secret;
    await withServer({}, async (baseUrl) => {
      const parts = makeValidToken(secret).split('.');
      parts[1] = base64url(JSON.stringify({ id: 'hacker', role: 'admin' }));
      const tampered = parts.join('.');
      const res = await request({ url: `${baseUrl}/auth/me`, headers: { Authorization: `Bearer ${tampered}` } });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'Invalid token' });
    });
  });

  it('uses jwt.secret option even when JWT_SECRET env var is unset', async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const secret = 'options-secret';
    await withServer({ jwt: { secret } }, async (baseUrl) => {
      const token = makeValidToken(secret);
      const res = await request({ url: `${baseUrl}/auth/me`, headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(res.json.id).toBe('1');
    });
    process.env.JWT_SECRET = saved;
  });

  it('rejects token whose secret does not match the env var', async () => {
    process.env.JWT_SECRET = 'correct';
    await withServer({}, async (baseUrl) => {
      const token = makeValidToken('wrong');
      const res = await request({ url: `${baseUrl}/auth/me`, headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
    });
  });
});

describe('JWT with @Render routes and errorTemplate', () => {
  it('returns text/html 401 when token is invalid on a @Render route', async () => {
    const secret = 'rendersecret';
    process.env.JWT_SECRET = secret;

    const renderer = (_template: string, data: any) =>
      `<html><body>Error: ${data.error ?? 'none'}</body></html>`;

    const web = createWebServer(
      { controllers: [new RenderController()] },
      { jwt: { secret }, renderer, errorTemplate: 'error' },
    );
    const s = await web.listen(0, '127.0.0.1');
    const addr = s.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const expiredToken = makeExpiredToken(secret);
      const res = await request({
        url: `${baseUrl}/render/page`,
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      expect(res.status).toBe(401);
      expect(res.contentType).toContain('text/html');
    } finally {
      await web.close();
    }
  });
});
