import { describe, it, expect } from '../lib.js';
import { createHmac } from 'crypto';
import {
  resolveJwtOptions,
  extractToken,
  verifyJwt,
  validateClaims,
  extractUserFromRequest,
} from '../../src/utils/auth.js';
import { ResolvedJwtOptions } from '../../src/types/jwt.js';
import { UnauthorizedError } from '../../src/errors/HttpErrors.js';

// ── helpers ────────────────────────────────────────────────────────────────

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeToken(
  header: object,
  payload: object,
  secret: string,
  hashAlg: string = 'sha256',
): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac(hashAlg, secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

function validToken(secret = 'secret', extraPayload: object = {}): string {
  return makeToken({ alg: 'HS256', typ: 'JWT' }, { id: '1', role: 'user', ...extraPayload }, secret);
}

function defaultOpts(overrides: Partial<ResolvedJwtOptions> = {}): ResolvedJwtOptions {
  return {
    secret: 'secret',
    cookieName: 'authToken',
    algorithms: ['HS256'],
    clockToleranceSec: 0,
    requireExpiration: false,
    ...overrides,
  };
}

function throws401(fn: () => unknown, expectedMsg?: string): void {
  let threw = false;
  try { fn(); } catch (e: any) {
    threw = true;
    expect(e instanceof UnauthorizedError).toBeTruthy(`expected UnauthorizedError, got ${e?.constructor?.name}`);
    if (expectedMsg) expect(e.message).toBe(expectedMsg);
  }
  if (!threw) throw new Error('Expected UnauthorizedError to be thrown');
}

// ── resolveJwtOptions ──────────────────────────────────────────────────────

describe('resolveJwtOptions', () => {
  it('applies all defaults', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const opts = resolveJwtOptions({});
    expect(opts.secret).toBe(undefined);
    expect(opts.cookieName).toBe('authToken');
    expect(opts.algorithms).toEqual(['HS256']);
    expect(opts.clockToleranceSec).toBe(0);
    expect(opts.requireExpiration).toBe(false);
    process.env.JWT_SECRET = saved;
  });

  it('uses JWT_SECRET env var when no secret provided', () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'from-env';
    const opts = resolveJwtOptions({});
    expect(opts.secret).toBe('from-env');
    process.env.JWT_SECRET = saved;
  });

  it('explicit secret takes precedence over JWT_SECRET env var', () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'from-env';
    const opts = resolveJwtOptions({ secret: 'explicit' });
    expect(opts.secret).toBe('explicit');
    process.env.JWT_SECRET = saved;
  });

  it('respects custom algorithms', () => {
    const opts = resolveJwtOptions({ algorithms: ['HS384', 'HS512'] });
    expect(opts.algorithms).toEqual(['HS384', 'HS512']);
  });

  it('cookieName: false is preserved', () => {
    const opts = resolveJwtOptions({ cookieName: false });
    expect(opts.cookieName).toBe(false);
  });

  it('custom cookieName is preserved', () => {
    const opts = resolveJwtOptions({ cookieName: 'myToken' });
    expect(opts.cookieName).toBe('myToken');
  });
});

// ── extractToken ──────────────────────────────────────────────────────────

describe('extractToken', () => {
  it('extracts from Authorization: Bearer header', () => {
    const t = extractToken({ authorization: 'Bearer abc.def.ghi' }, 'authToken');
    expect(t).toBe('abc.def.ghi');
  });

  it('header matching is case-insensitive', () => {
    const t = extractToken({ authorization: 'BEARER abc.def.ghi' }, 'authToken');
    expect(t).toBe('abc.def.ghi');
  });

  it('falls back to cookie when no Authorization header', () => {
    const t = extractToken({ cookie: 'authToken=tok.en.here' }, 'authToken');
    expect(t).toBe('tok.en.here');
  });

  it('header takes precedence over cookie', () => {
    const t = extractToken(
      { authorization: 'Bearer from-header', cookie: 'authToken=from-cookie' },
      'authToken',
    );
    expect(t).toBe('from-header');
  });

  it('returns undefined when no token present', () => {
    const t = extractToken({}, 'authToken');
    expect(t).toBe(undefined);
  });

  it('returns undefined when cookieName: false and no header', () => {
    const t = extractToken({ cookie: 'authToken=from-cookie' }, false);
    expect(t).toBe(undefined);
  });

  it('uses custom cookieName', () => {
    const t = extractToken({ cookie: 'myToken=val.ue.here' }, 'myToken');
    expect(t).toBe('val.ue.here');
  });

  it('returns undefined for Bearer header with no token', () => {
    const t = extractToken({ authorization: 'Bearer ' }, 'authToken');
    expect(t).toBe(undefined);
  });
});

// ── verifyJwt ─────────────────────────────────────────────────────────────

describe('verifyJwt — valid tokens', () => {
  it('accepts a valid HS256 token', () => {
    const token = validToken('s3cr3t');
    const payload = verifyJwt(token, defaultOpts({ secret: 's3cr3t' }));
    expect(payload.id).toBe('1');
    expect(payload.role).toBe('user');
  });

  it('accepts a valid HS384 token when HS384 is in algorithms', () => {
    const token = makeToken({ alg: 'HS384', typ: 'JWT' }, { id: '2' }, 'sec', 'sha384');
    const payload = verifyJwt(token, defaultOpts({ algorithms: ['HS384'], secret: 'sec' }));
    expect(payload.id).toBe('2');
  });

  it('accepts a valid HS512 token when HS512 is in algorithms', () => {
    const token = makeToken({ alg: 'HS512', typ: 'JWT' }, { id: '3' }, 'sec', 'sha512');
    const payload = verifyJwt(token, defaultOpts({ algorithms: ['HS512'], secret: 'sec' }));
    expect(payload.id).toBe('3');
  });

  it('accepts token with typ absent', () => {
    const token = makeToken({ alg: 'HS256' }, { id: '4' }, 'sec');
    const payload = verifyJwt(token, defaultOpts({ secret: 'sec' }));
    expect(payload.id).toBe('4');
  });
});

describe('verifyJwt — algorithm rejection', () => {
  it('rejects HS384 when only HS256 is allowed', () => {
    const token = makeToken({ alg: 'HS384', typ: 'JWT' }, { id: '2' }, 'sec', 'sha384');
    throws401(() => verifyJwt(token, defaultOpts({ algorithms: ['HS256'], secret: 'sec' })), 'Invalid token');
  });

  it('rejects alg: none', () => {
    const token = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify({ id: '1' }))}.`;
    throws401(() => verifyJwt(token, defaultOpts()), 'Invalid token');
  });

  it('rejects token without alg field', () => {
    const token = makeToken({ typ: 'JWT' }, { id: '1' }, 'sec');
    throws401(() => verifyJwt(token, defaultOpts({ secret: 'sec' })), 'Invalid token');
  });

  it('rejects typ: XX', () => {
    const token = makeToken({ alg: 'HS256', typ: 'XX' }, { id: '1' }, 'sec');
    throws401(() => verifyJwt(token, defaultOpts({ secret: 'sec' })), 'Invalid token');
  });
});

describe('verifyJwt — structural failures', () => {
  it('rejects a 2-part token', () => {
    throws401(() => verifyJwt('a.b', defaultOpts()), 'Invalid token');
  });

  it('rejects a 4-part token', () => {
    throws401(() => verifyJwt('a.b.c.d', defaultOpts()), 'Invalid token');
  });

  it('rejects non-base64 header segment', () => {
    throws401(() => verifyJwt('!!invalid!!.e30.sig', defaultOpts()), 'Invalid token');
  });

  it('rejects non-JSON header', () => {
    const badHeader = b64url('not-json');
    const payload = b64url(JSON.stringify({ id: '1' }));
    throws401(() => verifyJwt(`${badHeader}.${payload}.sig`, defaultOpts()), 'Invalid token');
  });

  it('rejects non-JSON payload', () => {
    const h = b64url(JSON.stringify({ alg: 'HS256' }));
    const badPayload = b64url('not-json');
    throws401(() => verifyJwt(`${h}.${badPayload}.sig`, defaultOpts()), 'Invalid token');
  });
});

describe('verifyJwt — signature failures', () => {
  it('rejects bad signature', () => {
    const token = validToken('correct-secret');
    throws401(() => verifyJwt(token, defaultOpts({ secret: 'wrong-secret' })), 'Invalid token');
  });

  it('rejects tampered payload', () => {
    const parts = validToken('sec').split('.');
    parts[1] = b64url(JSON.stringify({ id: 'tampered', role: 'admin' }));
    throws401(() => verifyJwt(parts.join('.'), defaultOpts({ secret: 'sec' })), 'Invalid token');
  });

  it('rejects wrong-length signature', () => {
    const parts = validToken('sec').split('.');
    parts[2] = b64url(Buffer.from('short'));
    throws401(() => verifyJwt(parts.join('.'), defaultOpts({ secret: 'sec' })), 'Invalid token');
  });
});

describe('verifyJwt — no secret', () => {
  it('rejects token when no secret configured', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const opts = resolveJwtOptions({});
    throws401(() => verifyJwt(validToken('any'), opts), 'Invalid token');
    process.env.JWT_SECRET = saved;
  });
});

// ── validateClaims ────────────────────────────────────────────────────────

describe('validateClaims — exp', () => {
  const now = Math.floor(Date.now() / 1000);

  it('accepts a token with no exp (default)', () => {
    validateClaims({ id: '1' }, defaultOpts());
  });

  it('accepts a valid exp in the future', () => {
    validateClaims({ exp: now + 3600 }, defaultOpts());
  });

  it('rejects an expired token', () => {
    throws401(() => validateClaims({ exp: now - 10 }, defaultOpts()), 'Token expired');
  });

  it('accepts exp within clockToleranceSec window', () => {
    validateClaims({ exp: now - 5 }, defaultOpts({ clockToleranceSec: 10 }));
  });

  it('rejects exp just outside clockToleranceSec window', () => {
    throws401(
      () => validateClaims({ exp: now - 11 }, defaultOpts({ clockToleranceSec: 10 })),
      'Token expired',
    );
  });

  it('rejects non-numeric exp', () => {
    throws401(() => validateClaims({ exp: 'never' }, defaultOpts()), 'Invalid token');
  });

  it('rejects token with no exp when requireExpiration: true', () => {
    throws401(() => validateClaims({ id: '1' }, defaultOpts({ requireExpiration: true })), 'Invalid token');
  });

  it('accepts token with exp when requireExpiration: true', () => {
    validateClaims({ exp: now + 3600 }, defaultOpts({ requireExpiration: true }));
  });
});

describe('validateClaims — nbf', () => {
  const now = Math.floor(Date.now() / 1000);

  it('accepts nbf in the past', () => {
    validateClaims({ nbf: now - 60 }, defaultOpts());
  });

  it('rejects nbf in the future', () => {
    throws401(() => validateClaims({ nbf: now + 60 }, defaultOpts()), 'Invalid token');
  });

  it('accepts nbf within clockToleranceSec window', () => {
    validateClaims({ nbf: now + 5 }, defaultOpts({ clockToleranceSec: 10 }));
  });

  it('rejects non-numeric nbf', () => {
    throws401(() => validateClaims({ nbf: 'soon' }, defaultOpts()), 'Invalid token');
  });
});

describe('validateClaims — iat', () => {
  const now = Math.floor(Date.now() / 1000);

  it('accepts iat in the past', () => {
    validateClaims({ iat: now - 60 }, defaultOpts());
  });

  it('accepts iat equal to now', () => {
    validateClaims({ iat: now }, defaultOpts());
  });

  it('rejects iat significantly in the future (beyond tolerance)', () => {
    throws401(() => validateClaims({ iat: now + 10 }, defaultOpts({ clockToleranceSec: 0 })), 'Invalid token');
  });

  it('accepts iat in the future within tolerance', () => {
    validateClaims({ iat: now + 5 }, defaultOpts({ clockToleranceSec: 10 }));
  });

  it('rejects non-numeric iat', () => {
    throws401(() => validateClaims({ iat: 'now' }, defaultOpts()), 'Invalid token');
  });
});

// ── extractUserFromRequest ────────────────────────────────────────────────

describe('extractUserFromRequest', () => {
  it('returns undefined when no token present', () => {
    const user = extractUserFromRequest({}, defaultOpts());
    expect(user).toBe(undefined);
  });

  it('returns the parsed user for a valid token', () => {
    const token = validToken('sec');
    const user = extractUserFromRequest(
      { authorization: `Bearer ${token}` },
      defaultOpts({ secret: 'sec' }),
    );
    expect(user?.id).toBe('1');
    expect(user?.role).toBe('user');
  });

  it('maps sub to id when id is absent', () => {
    const token = makeToken({ alg: 'HS256' }, { sub: 'u42', role: 'admin' }, 'sec');
    const user = extractUserFromRequest(
      { authorization: `Bearer ${token}` },
      defaultOpts({ secret: 'sec' }),
    );
    expect(user?.id).toBe('u42');
  });

  it('defaults role to "user" when role is absent', () => {
    const token = makeToken({ alg: 'HS256' }, { id: '5' }, 'sec');
    const user = extractUserFromRequest(
      { authorization: `Bearer ${token}` },
      defaultOpts({ secret: 'sec' }),
    );
    expect(user?.role).toBe('user');
  });

  it('throws UnauthorizedError when token is present but invalid', () => {
    throws401(() =>
      extractUserFromRequest(
        { authorization: 'Bearer bad.token.here' },
        defaultOpts({ secret: 'sec' }),
      ),
    );
  });

  it('throws when token is expired', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({ alg: 'HS256' }, { id: '1', exp: now - 60 }, 'sec');
    throws401(
      () => extractUserFromRequest({ authorization: `Bearer ${token}` }, defaultOpts({ secret: 'sec' })),
      'Token expired',
    );
  });

  it('extracts user from cookie when header absent', () => {
    const token = validToken('sec');
    const user = extractUserFromRequest(
      { cookie: `authToken=${token}` },
      defaultOpts({ secret: 'sec' }),
    );
    expect(user?.id).toBe('1');
  });

  it('does not check cookies when cookieName: false', () => {
    const token = validToken('sec');
    const user = extractUserFromRequest(
      { cookie: `authToken=${token}` },
      defaultOpts({ secret: 'sec', cookieName: false }),
    );
    expect(user).toBe(undefined);
  });
});
