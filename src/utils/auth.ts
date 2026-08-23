import { AuthenticatedUser } from '../types/IContext';
import { JwtOptions, ResolvedJwtOptions, JwtAlgorithm } from '../types/jwt';
import { createHmac, timingSafeEqual } from 'crypto';
import { parseCookies } from './cookies';
import { base64UrlDecode, base64UrlToBuffer } from './base64';
import { UnauthorizedError } from '../errors/HttpErrors';

const ALG_TO_HASH: Record<JwtAlgorithm, string> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
};

let _warnedMissingSecret = false;

export function resolveJwtOptions(options?: JwtOptions): ResolvedJwtOptions {
  return {
    secret: options?.secret ?? process.env.JWT_SECRET,
    cookieName: options?.cookieName !== undefined ? options.cookieName : 'authToken',
    algorithms: options?.algorithms ?? ['HS256'],
    clockToleranceSec: options?.clockToleranceSec ?? 0,
    requireExpiration: options?.requireExpiration ?? false,
  };
}

export function extractToken(
  headers: Record<string, string | string[]>,
  cookieName: string | false,
): string | undefined {
  const raw = headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header && typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice('bearer '.length).trim();
    if (token) return token;
  }

  if (cookieName !== false) {
    const cookies = parseCookies(headers['cookie']);
    const fromCookie = cookies[cookieName];
    if (fromCookie) return fromCookie;
  }

  return undefined;
}

/**
 * Verifies a JWT token and returns its payload.
 * Throws `UnauthorizedError` for any verification failure.
 */
export function verifyJwt(
  token: string,
  opts: ResolvedJwtOptions,
): Record<string, any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedError('Invalid token');

  const [headerB64, payloadB64, signatureB64] = parts;

  let headerObj: Record<string, any>;
  let payload: Record<string, any>;
  try {
    headerObj = JSON.parse(base64UrlDecode(headerB64));
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw new UnauthorizedError('Invalid token');
  }

  // Allow tokens that omit `typ`; reject those that set it to something other than 'JWT'
  if (headerObj.typ !== undefined && headerObj.typ !== 'JWT') {
    throw new UnauthorizedError('Invalid token');
  }

  const alg: string = headerObj.alg;
  if (!alg || !(opts.algorithms as string[]).includes(alg)) {
    throw new UnauthorizedError('Invalid token');
  }

  const hashAlg = ALG_TO_HASH[alg as JwtAlgorithm];

  if (!opts.secret) {
    if (!_warnedMissingSecret) {
      _warnedMissingSecret = true;
      console.warn(
        '[currentjs/router] JWT_SECRET is not set and no secret was provided via options. ' +
        'All tokens will be rejected.',
      );
    }
    throw new UnauthorizedError('Invalid token');
  }

  let provided: Buffer;
  try {
    provided = base64UrlToBuffer(signatureB64);
  } catch {
    throw new UnauthorizedError('Invalid token');
  }

  const data = `${headerB64}.${payloadB64}`;
  const expected = createHmac(hashAlg, opts.secret).update(data).digest();

  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    throw new UnauthorizedError('Invalid token');
  }

  validateClaims(payload, opts);

  return payload;
}

export function validateClaims(
  payload: Record<string, any>,
  opts: ResolvedJwtOptions,
): void {
  const now = Math.floor(Date.now() / 1000);
  const tol = opts.clockToleranceSec;

  if (opts.requireExpiration && payload.exp === undefined) {
    throw new UnauthorizedError('Invalid token');
  }

  if (payload.exp !== undefined) {
    if (typeof payload.exp !== 'number') throw new UnauthorizedError('Invalid token');
    if (now > payload.exp + tol) throw new UnauthorizedError('Token expired');
  }

  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number') throw new UnauthorizedError('Invalid token');
    if (now < payload.nbf - tol) throw new UnauthorizedError('Invalid token');
  }

  if (payload.iat !== undefined) {
    if (typeof payload.iat !== 'number') throw new UnauthorizedError('Invalid token');
    // A token issued significantly in the future is suspicious
    if (payload.iat - tol > now) throw new UnauthorizedError('Invalid token');
  }
}

/**
 * Extract and verify a JWT from request headers using the given options.
 * Returns `undefined` when no token is present.
 * Throws `UnauthorizedError` when a token is present but invalid.
 */
export function extractUserFromRequest(
  headers: Record<string, string | string[]>,
  opts: ResolvedJwtOptions,
): AuthenticatedUser | undefined {
  const token = extractToken(headers, opts.cookieName);
  if (!token) return undefined;

  const payload = verifyJwt(token, opts);

  const user: AuthenticatedUser = {
    id: payload.id ?? payload.sub,
    role: payload.role ?? 'user',
    email: payload.email,
    ...payload,
  };
  return user;
}
