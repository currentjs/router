import * as http from 'http';
import * as https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import { parse as parseUrl } from 'url';
import { createReadStream, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import { RouteDefinition, HttpMethod, getOwnRoutes, getOwnBasePath, getOwnRenders } from '../decorators/RouteDecorators';
import type { IContext } from '../types/IContext';
import { BaseHttpError } from '../errors/BaseHttpError';
import { BadRequestError, ContentTooLargeError } from '../errors/HttpErrors';
import { extractUserFromRequest, resolveJwtOptions } from '../utils/auth';
import type { JwtOptions } from '../types/jwt';
import { resolveBodyParsers, parseRequestBody } from '../utils/bodyParsing';
import type { BodyParser } from '../utils/bodyParsing';

// Controllers are now passed directly; basePath is derived from @Controller decorator on class

/** Default cap on request body size when `maxBodySize` is not configured (1 MiB). */
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

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
  /**
   * JWT verification options.
   * Set to `false` to disable token extraction entirely (all requests are anonymous).
   * Omit or pass `{}` to use defaults (HS256, `JWT_SECRET` env var, `authToken` cookie).
   */
  jwt?: JwtOptions | false;
  /**
   * Maximum accepted request body size, in bytes. Requests whose declared
   * `Content-Length` exceeds this — or whose actual body exceeds it while
   * streaming — are rejected with `413 Content Too Large` before a handler
   * runs. Defaults to 1 MiB.
   */
  maxBodySize?: number;
  /**
   * Request body parsing behaviour.
   * - Omit or pass `{}` to use the built-in defaults: strict JSON (`400` on
   *   malformed), urlencoded → object, `text/*` → string, `multipart/form-data`
   *   → `415`, anything else (or no `Content-Type`) → raw `Buffer`.
   * - `false` — disable parsing entirely; `ctx.request.body` is always the raw
   *   `Buffer` (empty `Buffer` when there is no body).
   * - Record — per-type overrides merged over the defaults. A `null` value
   *   removes that default entry. Keys may be exact types (`"application/json"`),
   *   structured-syntax suffixes (`"+json"`), or wildcards (`"text/*"`, `"*\/*"`).
   */
  bodyParsers?: false | Record<string, BodyParser | null>;
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

interface RouteTableEntry {
  route: RouteDefinition;
  controllerInstance: any;
  matcher: { regex: RegExp; keys: string[] };
  /** Original insertion index; used as tie-breaker so sort is stable. */
  registrationIndex: number;
}

/**
 * Compare two dynamic (parametric) route entries so that more-specific routes
 * sort earlier.  Ordering rules applied in priority order:
 *   1. Fewer total parameter segments first.
 *   2. Segment-by-segment, left-to-right: a static segment beats a `:param`.
 *   3. Original registration index (first registered wins among equals).
 */
export function compareRouteSpecificity(a: RouteTableEntry, b: RouteTableEntry): number {
  const aSegs = normalizePath(a.route.path).split('/').filter(Boolean);
  const bSegs = normalizePath(b.route.path).split('/').filter(Boolean);
  const aParams = aSegs.filter(s => s.startsWith(':')).length;
  const bParams = bSegs.filter(s => s.startsWith(':')).length;
  if (aParams !== bParams) return aParams - bParams;
  const len = Math.min(aSegs.length, bSegs.length);
  for (let i = 0; i < len; i++) {
    const aIsParam = aSegs[i].startsWith(':');
    const bIsParam = bSegs[i].startsWith(':');
    if (aIsParam !== bIsParam) return aIsParam ? 1 : -1;
  }
  return a.registrationIndex - b.registrationIndex;
}

interface RouteTable {
  /** Fully-static routes (no path parameters), keyed by `METHOD /path`. */
  staticRoutes: Map<string, RouteTableEntry>;
  /** Parametric routes, pre-sorted by specificity (most specific first). */
  dynamicRoutes: RouteTableEntry[];
  /** Static path (method-independent) -> set of methods registered for it. Used for `405`/`OPTIONS`. */
  staticPathMethods: Map<string, Set<HttpMethod>>;
}

/**
 * Collect every HTTP method registered for `path`, across both static and
 * parametric routes, regardless of which method the current request used.
 * An empty set means the path isn't registered by any controller at all
 * (so the caller should fall back to static-file serving / `404`), while a
 * non-empty set that doesn't contain the request's method means `405`.
 */
function getAllowedMethodsForPath(
  path: string,
  staticPathMethods: Map<string, Set<HttpMethod>>,
  dynamicRoutes: RouteTableEntry[]
): Set<HttpMethod> {
  const methods = new Set<HttpMethod>(staticPathMethods.get(path) ?? []);
  for (const entry of dynamicRoutes) {
    if (entry.matcher.regex.test(path)) {
      methods.add(entry.route.method);
    }
  }
  return methods;
}

/** `GET` implies `HEAD` support, and every registered path answers `OPTIONS`. */
function buildAllowHeader(methods: Set<HttpMethod>): string {
  const withImplied = new Set(methods);
  if (withImplied.has('GET')) withImplied.add('HEAD');
  withImplied.add('OPTIONS');
  return Array.from(withImplied).sort().join(', ');
}

/**
 * Ends the response, omitting the body for `HEAD` requests while still
 * reporting the `Content-Length` the equivalent `GET`/etc. response would
 * have had.
 */
function endResponse(res: ServerResponse, body: string, isHeadRequest: boolean): void {
  if (isHeadRequest) {
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end();
  } else {
    res.end(body);
  }
}

/**
 * Walk the prototype chain above `ctor` (excluding Object) and return the
 * first ancestor that owns the given metadata key, or `null` if none do.
 */
function findAncestorWithOwnMeta(ctor: any, key: string): any | null {
  let proto = Object.getPrototypeOf(ctor);
  while (proto && proto !== Function.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, key)) return proto;
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

function warnInheritedMetadata(ctor: any): void {
  const name = ctor.name || '(anonymous)';
  const hasOwnRoutes = Object.prototype.hasOwnProperty.call(ctor, 'routes');
  const hasOwnBase = Object.prototype.hasOwnProperty.call(ctor, 'basePath');

  if (!hasOwnRoutes && findAncestorWithOwnMeta(ctor, 'routes')) {
    console.warn(
      `[router] ${name}: route decorators are not inherited. ` +
      `Re-declare @Get/@Post/… directly on ${name}, or register the base class as a controller instead.`
    );
  }
  if (hasOwnRoutes && !hasOwnBase && findAncestorWithOwnMeta(ctor, 'basePath')) {
    console.warn(
      `[router] ${name}: @Controller is not inherited. ` +
      `Routes on ${name} will be registered without the ancestor's base path prefix. ` +
      `Add @Controller('…') to ${name} to set an explicit prefix.`
    );
  }
}

export function buildRouteTable(controllers: any[]): RouteTable {
  const staticRoutes = new Map<string, RouteTableEntry>();
  const dynamicRoutes: RouteTableEntry[] = [];
  const staticPathMethods = new Map<string, Set<HttpMethod>>();
  let registrationIndex = 0;

  for (const controllerInstance of controllers) {
    const controllerCtor = Object.getPrototypeOf(controllerInstance).constructor;

    warnInheritedMetadata(controllerCtor);

    const routes: RouteDefinition[] = getOwnRoutes(controllerCtor);
    const basePath: string = getOwnBasePath(controllerCtor);
    const renders: Record<string, { template: string; layout?: string }> = getOwnRenders(controllerCtor);

    for (const route of routes) {
      const fullPath = normalizePath(`${normalizePath(basePath)}${normalizePath(route.path)}`.replace(/\/+/, '/'));
      const matcher = compilePathToRegex(fullPath);
      const r = renders[route.handler];
      const routeWithRender: RouteDefinition & { render?: { template: string; layout?: string } } = r
        ? ({ ...route, path: fullPath, render: { template: r.template, layout: r.layout } } as any)
        : ({ ...route, path: fullPath } as any);

      const entry: RouteTableEntry = {
        route: routeWithRender as any,
        controllerInstance,
        matcher,
        registrationIndex: registrationIndex++,
      };

      if (matcher.keys.length === 0) {
        const key = buildRouteKey(route.method, fullPath);
        if (!staticRoutes.has(key)) {
          staticRoutes.set(key, entry);
        }
        if (!staticPathMethods.has(fullPath)) {
          staticPathMethods.set(fullPath, new Set());
        }
        staticPathMethods.get(fullPath)!.add(route.method);
      } else {
        dynamicRoutes.push(entry);
      }
    }
  }

  dynamicRoutes.sort(compareRouteSpecificity);
  return { staticRoutes, dynamicRoutes, staticPathMethods };
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

function isPathInside(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  return childResolved === parentResolved || childResolved.startsWith(parentResolved + sep);
}

async function serveStaticFile(
  rootDir: string, 
  requestPath: string, 
  res: ServerResponse, 
  indexFiles: string[] = ['index.html'],
  isHeadRequest: boolean = false
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
    res.setHeader('Content-Length', stats.size);

    if (isHeadRequest) {
      res.end();
      return true;
    }

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



function generateTraceId(): string {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.random() * 256 | 0;
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function generateTimestamp(): string {
  return new Date().toISOString();
}

export function createWebServer(
  { controllers, webDir }: { controllers: any[], webDir?: string },
  options: WebServerOptions = {}
) {
  const { staticRoutes, dynamicRoutes, staticPathMethods } = buildRouteTable(controllers);
  const jwtOpts = options.jwt !== false ? resolveJwtOptions(options.jwt ?? {}) : false;
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  const resolvedBodyParsers = resolveBodyParsers(options.bodyParsers);

  const requestListener = async (req: IncomingMessage, res: ServerResponse) => {
    const traceId = generateTraceId();
    // Computed unconditionally (ahead of any parsing that might throw) so both the inner
    // and outer catch blocks can still send a bodyless response to a HEAD request.
    const isHeadRequest = (req.method || 'GET').toUpperCase() === 'HEAD';

    try {
      const method = (req.method || 'GET').toUpperCase() as HttpMethod;
      const { pathname = '/', query } = parseUrl(req.url || '/', true);
      let decodedPathname: string;
      try {
        decodedPathname = decodeURIComponent(pathname ?? '/');
      } catch {
        throw new BadRequestError('Malformed URL encoding in request path');
      }
      const path = normalizePath(decodedPathname);

      // A body over the cap short-circuits to a 413 below. The socket is never destroyed
      // mid-stream — killing it here would take the response down with it — instead the
      // oversized bytes are simply never buffered, and the connection is closed once the
      // 413 has actually been flushed to the client (see `Connection: close` below).
      let bodyTooLarge = false;

      const contentLengthHeader = req.headers['content-length'];
      if (contentLengthHeader) {
        const declaredLength = parseInt(contentLengthHeader, 10);
        if (!Number.isNaN(declaredLength) && declaredLength > maxBodySize) {
          bodyTooLarge = true;
        }
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      if (!bodyTooLarge) {
        await new Promise<void>((resolveBody) => {
          req.on('data', (c: Buffer) => {
            if (bodyTooLarge) return;
            receivedBytes += c.length;
            if (receivedBytes > maxBodySize) {
              bodyTooLarge = true;
              chunks.length = 0;
              resolveBody();
              return;
            }
            chunks.push(c);
          });
          req.on('end', () => resolveBody());
        });
      }

      if (bodyTooLarge) {
        res.setHeader('Connection', 'close');
        throw new ContentTooLargeError(`Request body exceeds the maximum allowed size of ${maxBodySize} bytes`);
      }

      const rawBodyBuf = Buffer.concat(chunks);

      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const bodySize = rawBodyBuf.length;
      console.log(JSON.stringify({
        timestamp: generateTimestamp(),
        traceId,
        method,
        path,
        clientIp,
        headers: req.headers,
        bodySize,
      }))

      let matched: MatchedRoute | null = null;

      // HEAD is never declared explicitly on a controller — it reuses whatever GET
      // route is registered for the same path, and the response body is dropped later on.
      const matchMethod: HttpMethod = isHeadRequest ? 'GET' : method;

      // Phase 1: O(1) lookup for fully-static routes (no path parameters).
      const staticEntry = staticRoutes.get(buildRouteKey(matchMethod, path));
      if (staticEntry) {
        matched = { controllerInstance: staticEntry.controllerInstance, route: staticEntry.route, params: {} };
      }

      // Phase 2: scan parametric routes (sorted by specificity, most specific first).
      if (!matched) {
        for (const entry of dynamicRoutes) {
          if (entry.route.method !== matchMethod) continue;
          const match = entry.matcher.regex.exec(path);
          if (match) {
            const params: Record<string, string> = {};
            entry.matcher.keys.forEach((k, i) => (params[k] = match[i + 1]));
            matched = { controllerInstance: entry.controllerInstance, route: entry.route, params };
            break;
          }
        }
      }

      if (!matched) {
        // The path is registered by at least one controller, just not for this method
        // (or, for OPTIONS, at all) — that's a 405/preflight, not a 404.
        const allowedMethods = getAllowedMethodsForPath(path, staticPathMethods, dynamicRoutes);

        if (allowedMethods.size > 0) {
          const allowHeader = buildAllowHeader(allowedMethods);

          if (method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('Allow', allowHeader);
            res.end();
            console.log(JSON.stringify({
              timestamp: generateTimestamp(),
              traceId,
              response: '204 (OPTIONS preflight)'
            }))
            return;
          }

          res.statusCode = 405;
          res.setHeader('Allow', allowHeader);
          res.setHeader('Content-Type', 'application/json');
          endResponse(res, JSON.stringify({ error: 'Method Not Allowed' }), isHeadRequest);
          console.log(JSON.stringify({
            timestamp: generateTimestamp(),
            traceId,
            response: '405 (application/json)'
          }))
          return;
        }

        // Try to serve static files if staticDir is configured (GET/HEAD only — there is
        // no meaningful static-file response to POST/PUT/etc.)
        const staticDir = options.staticDir || webDir;
        if (staticDir && (method === 'GET' || isHeadRequest)) {
          const served = await serveStaticFile(staticDir, path, res, options.indexFiles, isHeadRequest);
          if (served) {
            console.log(JSON.stringify({
              timestamp: generateTimestamp(),
              traceId,
              response: '200 (static file)'
            }))
            return;
          }
        }

        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        endResponse(res, JSON.stringify({ error: 'Not Found' }), isHeadRequest);
        console.log(JSON.stringify({
          timestamp: generateTimestamp(),
          traceId,
          response: '404 (application/json)'
        }))
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
          body: undefined,
          rawBody: rawBodyBuf,
          headers: headers,
          method,
          path,
          user: undefined,
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
        // Extract and verify JWT — throws UnauthorizedError when token is present but invalid,
        // so the error flows through the inner catch and can render an errorTemplate for @Render routes.
        if (jwtOpts !== false) {
          context.request.user = extractUserFromRequest(headers, jwtOpts);
        }

        // Parse the body here, after route matching and JWT, so:
        //   • A bad body on an unregistered path → 404/405 (not 400).
        //   • A bad body on a @Render route → errorTemplate HTML (not bare JSON).
        //   • A 401 always wins over a 400 when both a bad token and a bad body arrive.
        context.request.body = parseRequestBody(rawBodyBuf, headers, resolvedBodyParsers) as any;

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
          endResponse(res, html, isHeadRequest);
          console.log(JSON.stringify({
            timestamp: generateTimestamp(),
            traceId,
            response: '200 (text/html)'
          }))
          return;
        }

        const responseBody = typeof result === 'string' ? result : JSON.stringify(result ?? {});
        const contentType = typeof result === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        endResponse(res, responseBody, isHeadRequest);
        console.log(JSON.stringify({
          timestamp: generateTimestamp(),
          traceId,
          response: `200 ${contentType}`
        }))
      } catch (handlerError: any) {
        const isHttpError = handlerError instanceof BaseHttpError;
        const statusCode = isHttpError ? handlerError.getHTTPCode() : 500;
        // Non-BaseHttpError throws are internal failures (driver errors, bugs, etc.) and must
        // never reach the client verbatim — they may contain schema names, file paths, or other
        // internals. Only a BaseHttpError's message is intentionally client-facing.
        const clientMessage = isHttpError ? handlerError.message : 'Internal Server Error';

        console.log(JSON.stringify({
          timestamp: generateTimestamp(),
          traceId,
          errorCode: statusCode,
          errorMessage: handlerError?.message || 'Unknown error',
          ...(isHttpError ? {} : { stack: handlerError?.stack }),
        }))

        if (isRenderableRoute && options.errorTemplate) {
          try {
            // Check if this is a partial content request (SPA navigation)
            const isPartialRequest = headers['x-partial-content'] === 'true' ||
                                    (Array.isArray(headers['x-partial-content']) && headers['x-partial-content'][0] === 'true');

            // Use layout only if it's not a partial request
            const layoutToUse = isPartialRequest ? undefined : maybeRoute.render.layout;

            const errorData = { error: clientMessage, statusCode };
            const html = await renderer(options.errorTemplate, errorData, layoutToUse);
            res.statusCode = statusCode;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            endResponse(res, html, isHeadRequest);
            return;
          } catch (renderError) {
            console.error('Error template rendering failed:', renderError);
          }
        }

        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json');
        endResponse(res, JSON.stringify({ error: clientMessage }), isHeadRequest);
      }
    } catch (error: any) {
      const isHttpError = error instanceof BaseHttpError;
      const statusCode = isHttpError ? error.getHTTPCode() : 500;
      const clientMessage = isHttpError ? error.message : 'Internal Server Error';

      console.log(JSON.stringify({
        timestamp: generateTimestamp(),
        traceId,
        errorCode: statusCode,
        errorMessage: error?.message || 'Unknown error',
        ...(isHttpError ? {} : { stack: error?.stack }),
      }))

      res.statusCode = statusCode;
      res.setHeader('Content-Type', 'application/json');
      endResponse(res, JSON.stringify({ error: clientMessage }), isHeadRequest);
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

