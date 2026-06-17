import { describe, it, expect } from '../lib.js';
import { createHmac } from 'crypto';
import { createWebServer } from '../../src/server/createWebServer.js';
import { Controller, Get } from '../../src/decorators/RouteDecorators.js';
import * as http from 'http';

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signHS256(header: object, payload: object, secret: string) {
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const sig = createHmac('sha256', secret).update(data).digest();
  const signature = base64url(sig);
  return `${data}.${signature}`;
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; json?: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const ct = res.headers['content-type'] || '';
        const isJson = typeof ct === 'string' && ct.includes('application/json');
        resolve({ status: res.statusCode || 0, json: isJson ? JSON.parse(text || '{}') : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

@Controller('/auth')
class AuthController {
  @Get('/me')
  async me(ctx: any) {
    return ctx.request.user || null;
  }
}

describe('JWT auth extraction', () => {
  it('extracts HS256 JWT from Authorization header when JWT_SECRET is set', async () => {
    const secret = 'testsecret';
    process.env.JWT_SECRET = secret;
    const web = createWebServer({ controllers: [new AuthController()] }, { port: 0 });
    const s = await web.listen(0, '127.0.0.1');
    const addr = s.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const token = signHS256({ alg: 'HS256', typ: 'JWT' }, { id: '123', role: 'admin', email: 'a@b.c' }, secret);
    const res = await get(`${baseUrl}/auth/me`, { Authorization: `Bearer ${token}` });
    await web.close();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: '123', role: 'admin', email: 'a@b.c' });
  });
});
