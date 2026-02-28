import * as http from 'http';
import * as https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import { parse as parseUrl } from 'url';
import { createHmac, timingSafeEqual } from 'crypto';
import { createReadStream, statSync } from 'fs';
import { join, resolve, normalize, sep } from 'path';
import { RouteDefinition, HttpMethod } from '../decorators/RouteDecorators';
import type { IContext, AuthenticatedUser } from '../types/IContext';

// Controllers are now passed directly; basePath is derived from @Controller decorator on class

export interface WebServerOptions {
  port?: number;
  host?: string;
  https?: {
    key: Buffer | string;
    cert: Buffer | string;
  } | false;
  renderer?: (template: string, data: any, layout?: string) => string | Promise<string>;
  staticDir?: string;
  indexFiles?: string[];
  errorTemplate?: string;
}

interface MatchedRoute {
  controllerInstance: any;
  route: RouteDefinition;
  params: Record<string, string>;
}

function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  if (!pathname.startsWith('/')) return '/' + pathname;
  return pathname.replace(/\/+$/, '') || '/';
}

function buildRouteKey(method: HttpMethod, path: string): string {
  return `${method} ${normalizePath(path)}`;
}

function compilePathToRegex(path: string) {
  const normalized = normalizePath(path);
  const keys: string[] = [];
  const pattern = normalized
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), keys };
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padLength);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function base64UrlToBuffer(input: string): Buffer {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padLength);
  return Buffer.from(padded, 'base64');
}

function isPathInside(parent: string, child: string): boolean {
  const relative = normalize(child).replace(parent, '');
  return resolve(child).startsWith(resolve(parent) + sep);
}

async function serveStaticFile(
  rootDir: string, 
  requestPath: string, 
  res: ServerResponse, 
  indexFiles: string[] = ['index.html']
): Promise<boolean> {
  try {
    const base = resolve(rootDir);
    let target = resolve(join(base, '.' + requestPath));

    if (!isPathInside(base, target)) {
      return false; // Security: path traversal attempt
    }

    let stats: ReturnType<typeof statSync> | null = null;
    try { 
      stats = statSync(target); 
    } catch { 
      stats = null; 
    }

    if (!stats || !stats.isFile()) {
      // Try index files if directory
      for (const idx of indexFiles) {
        const idxPath = resolve(join(target, idx));
        try {
          const s = statSync(idxPath);
          if (s.isFile()) {
            target = idxPath;
            stats = s;
            break;
          }
        } catch {}
      }
    }

    if (!stats || !stats.isFile()) {
      return false; // File not found
    }

    // Determine content type based on file extension
    const ext = target.split('.').pop()?.toLowerCase();
    const contentType = getContentType(ext);
    
    res.setHeader('Content-Type', contentType);
    const stream = createReadStream(target);
    
    return new Promise((resolve) => {
      stream.on('error', () => {
        resolve(false);
      });
      stream.on('end', () => {
        resolve(true);
      });
      stream.pipe(res);
    });
  } catch (e) {
    return false;
  }
}

function getContentType(ext?: string): string {
  const types: Record<string, string> = {
    'html': 'text/html; charset=utf-8',
    'htm': 'text/html; charset=utf-8',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'txt': 'text/plain; charset=utf-8',
    'pdf': 'application/pdf',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject'
  };
  return types[ext || ''] || 'application/octet-stream';
}

function parseCookies(cookieHeader?: string | string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!header || typeof header !== 'string') return cookies;
  
  header.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.split('=');
    if (name && rest.length > 0) {
      cookies[name.trim()] = rest.join('=').trim();
    }
  });
  
  return cookies;
}

function extractUserFromAuthorizationHeader(headers: Record<string, string | string[]>): AuthenticatedUser | undefined {
  try {
    let token: string | undefined;
    
    // First, try to get token from Authorization header
    const raw = headers['authorization'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (header && typeof header === 'string' && header.startsWith('Bearer ')) {
      token = header.slice(7).trim();
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

export function createWebServer(
  { controllers, webDir }: { controllers: any[], webDir?: string },
  options: WebServerOptions = {}
) {
  const routeTable: Array<{ route: RouteDefinition; controllerInstance: any; matcher: { regex: RegExp; keys: string[] } }> = [];

  for (const controllerInstance of controllers) {
    const controllerCtor = Object.getPrototypeOf(controllerInstance).constructor;
    const routes: RouteDefinition[] = controllerCtor.routes || [];
    const basePath: string = controllerCtor.basePath || '';
    const renders: Record<string, { template: string; layout?: string }> = controllerCtor.renders || {};
    for (const route of routes) {
      const fullPath = normalizePath(`${normalizePath(basePath)}${normalizePath(route.path)}`.replace(/\/+/, '/'));
      const matcher = compilePathToRegex(fullPath);
      // Attach any render metadata to the route object for downstream use
      const r = renders[route.handler];
      const routeWithRender: RouteDefinition & { render?: { template: string; layout?: string } } = r
        ? ({ ...route, path: fullPath, render: { template: r.template, layout: r.layout } } as any)
        : ({ ...route, path: fullPath } as any);
      routeTable.push({ route: routeWithRender as any, controllerInstance, matcher });
    }
  }

  const requestListener = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = (req.method || 'GET').toUpperCase() as HttpMethod;
      const { pathname = '/', query } = parseUrl(req.url || '/', true);
      const path = normalizePath(pathname ?? '/');

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      await new Promise<void>((resolve) => req.on('end', () => resolve()));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: any = undefined;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }

      let matched: MatchedRoute | null = null;
      for (const entry of routeTable) {
        if (entry.route.method !== method) continue;
        const match = entry.matcher.regex.exec(path);
        if (match) {
          const params: Record<string, string> = {};
          entry.matcher.keys.forEach((k, i) => (params[k] = match[i + 1]));
          matched = { controllerInstance: entry.controllerInstance, route: entry.route, params };
          break;
        }
      }

      if (!matched) {
        // Try to serve static files if staticDir is configured
        const staticDir = options.staticDir || webDir;
        if (staticDir) {
          const served = await serveStaticFile(staticDir, path, res, options.indexFiles);
          if (served) return;
        }
        
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'undefined') continue;
        headers[k] = v as any;
      }

      const context: IContext = {
        request: {
          url: req.url || '/',
          parameters: { ...(query as Record<string, any>), ...matched.params },
          body,
          headers: headers,
          method,
          path,
          user: extractUserFromAuthorizationHeader(headers)
        },
        response: {}
      };

      const handlerName = matched.route.handler;
      const handler = matched.controllerInstance[handlerName]?.bind(matched.controllerInstance);
      if (typeof handler !== 'function') {
        throw new Error(`Handler ${handlerName} is not a function on controller`);
      }

      // Get route and renderer info before execution for error handling
      const maybeRoute: any = matched.route as any;
      const renderer = options.renderer;
      const isRenderableRoute = maybeRoute && maybeRoute.render && typeof renderer === 'function';

      try {
        const result = await handler(context);

        // If route has render metadata and a renderer exists in options, render HTML here
        if (isRenderableRoute) {
          // Check if this is a partial content request (SPA navigation)
          const isPartialRequest = headers['x-partial-content'] === 'true' || 
                                  (Array.isArray(headers['x-partial-content']) && headers['x-partial-content'][0] === 'true');
          
          // Use layout only if it's not a partial request
          const layoutToUse = isPartialRequest ? undefined : maybeRoute.render.layout;
          
          const html = await renderer(maybeRoute.render.template, result ?? {}, layoutToUse);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('X-Layout', maybeRoute.render.layout || '');
          res.end(html);
          return;
        }

        const responseBody = typeof result === 'string' ? result : JSON.stringify(result ?? {});
        const contentType = typeof result === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.end(responseBody);
      } catch (handlerError: any) {
        // If this is a renderable route and we have an error template, render error page
        if (isRenderableRoute && options.errorTemplate) {
          try {
            // Check if this is a partial content request (SPA navigation)
            const isPartialRequest = headers['x-partial-content'] === 'true' || 
                                    (Array.isArray(headers['x-partial-content']) && headers['x-partial-content'][0] === 'true');
            
            // Use layout only if it's not a partial request
            const layoutToUse = isPartialRequest ? undefined : maybeRoute.render.layout;
            
            const errorData = {
              error: handlerError?.message || 'An error occurred',
              statusCode: 500
            };
            const html = await renderer(options.errorTemplate, errorData, layoutToUse);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
            return;
          } catch (renderError) {
            // If error template rendering fails, fall back to JSON error
            console.error('Error template rendering failed:', renderError);
          }
        }
        
        // Default JSON error response (for non-renderable routes or when error template fails)
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: handlerError?.message || 'Internal Server Error' }));
      }
    } catch (error: any) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error?.message || 'Internal Server Error' }));
    }
  };

  const server = options.https
    ? https.createServer({ key: options.https.key, cert: options.https.cert }, requestListener)
    : http.createServer(requestListener);

  return {
    listen(port = options.port ?? 3000, host = options.host ?? '0.0.0.0') {
      return new Promise<ReturnType<typeof server.listen>>((resolve) => {
        server.listen(port, host, () => resolve(server));
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

