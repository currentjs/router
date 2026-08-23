import { AuthenticatedUser } from "../types/IContext";
import { createHmac, timingSafeEqual } from "crypto";
import { parseCookies } from "./cookies";
import { base64UrlDecode, base64UrlToBuffer } from "./base64";

const PREFIX = 'Bearer ';
const PREFIX_LENGTH = PREFIX.length;

export function extractUserFromAuthorizationHeader(headers: Record<string, string | string[]>): AuthenticatedUser | undefined {
  try {
    let token: string | undefined;

    // First, try to get token from Authorization header
    const raw = headers['authorization'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (header && typeof header === 'string' && header.toLowerCase().startsWith(PREFIX.toLowerCase())) {
      token = header.slice(PREFIX_LENGTH).trim();
    }

    // If no token in Authorization header, check cookies
    if (!token) {
      const cookies = parseCookies(headers['cookie']);
      token = cookies['authToken'];
    }

    // If still no token, return undefined
    if (!token) return undefined;

    const parts = token.split('.');
    if (parts.length !== 3) return undefined;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature using HS256 and JWT_SECRET
    const secret = process.env.JWT_SECRET;
    if (!secret) return undefined;

    const headerJson = base64UrlDecode(headerB64);
    const headerObj = JSON.parse(headerJson);
    if (headerObj.alg !== 'HS256' || headerObj.typ !== 'JWT') return undefined;

    const data = `${headerB64}.${payloadB64}`;
    const expected = createHmac('sha256', secret).update(data).digest();
    const provided = base64UrlToBuffer(signatureB64);
    if (provided.length !== expected.length) return undefined;
    if (!timingSafeEqual(expected, provided)) return undefined;

    const payloadJson = base64UrlDecode(payloadB64);
    const payload = JSON.parse(payloadJson);

    const user: AuthenticatedUser = {
      id: payload.id ?? payload.sub,
      role: payload.role ?? 'user',
      email: payload.email,
      ...payload
    };
    return user;
  } catch {
    return undefined;
  }
}
