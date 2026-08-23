# @currentjs/router Roadmap

## Current State

Two structural gaps still shape most of the work below:

1. **No response control.** `IContext.response` is declared and initialized, but never read by the
  server. Handlers cannot set a status code, a header, or a cookie. Success is always `200`, and the
   content type is inferred solely from `typeof result`. This is why `@currentjs/gen` implements
   redirects and cookie-setting in client-side `web/app.js` instead of on the server.
2. **No middleware or guards.** There is no place to put CORS, rate limiting, security headers, or
  auth checks, so every generated controller method re-emits the same authentication preamble

## Roadmap


| Feature                            | Release | Size | Notes                                                                                                         |
| ---------------------------------- | ------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| ✅ `authToken` cookie fallback      | 0.1.2   | S    | JWT also accepted from the `authToken` cookie when `Authorization` is absent                                  |
| ✅ `X-Layout` header                | 0.1.3   | S    | Set on rendered responses (still unconditional — see Known Issues)                                            |
| ✅ HTTP error handling              | 0.2.0   | M    | Error classes + `BaseHttpError` mapping in the server; used by the generator                                  |
| ✅ Request logging                  | 0.2.0   | M    | Structured JSON per request (`traceId`, method, path, headers, bodySize)                                      |
| ✅ First test suite                 | 0.2.1   | M    | Unit tests for routing/decorators; integration tests for the server and JWT happy path                        |
| ✅ Route specificity matching       | 0.2.2   | M    | Static-first O(1) lookup, then params sorted by specificity — route declaration order no longer matters       |
| ✅ Directory index as `/`           | 0.2.2   | S    | `index.html` (and `indexFiles`) served for `/` and directory paths                                            |
| ✅ README catch-up                  | 0.2.2   | S    | Error classes, matching rules, and index-file resolution documented                                           |
| ✅ Complete the error API           | 0.3.0   | S    | `BaseHttpError` exported; `412`, `417`, `422`, `428`, `431`, `502`, `504`, `505` added                        |
| ✅ Remaining README gaps            | 0.3.0   | S    | `authToken` cookie fallback and the `X-Layout` / `X-Partial-Content` handshake documented                     |
| ✅ JWT expiry validation            | 0.3.0   | S    | **Security.** `exp`/`nbf`/`iat` validated; present-but-invalid token now throws 401                          |
| ✅ Stop leaking internals           | 0.3.0   | S    | **Security.** Non-`BaseHttpError` throws now respond with a generic `Internal Server Error`; the real message and stack are logged      |
| ✅ Body size limit                  | 0.3.0   | S    | **Security.** `maxBodySize` option (default 1 MiB); over-limit requests get `413` before the handler runs    |
| Decorator metadata isolation       | 0.3.0   | S    | Routes/`basePath` leak across a class hierarchy via the prototype chain — see Known Issues                    |
| URL decoding                       | 0.3.0   | S    | Path params and static paths are never decoded (`%40`, `%20` reach handlers/`fs` encoded)                     |
| `405` / `HEAD` / `OPTIONS`         | 0.3.0   | M    | A method mismatch currently returns `404`; no preflight is possible                                           |
| Content-type-aware body parsing    | 0.3.0   | M    | Strict JSON → `400`; `urlencoded` → object; otherwise `Buffer`. Today everything becomes a UTF-8 string       |
| ✅ JWT configuration                | 0.3.0   | S    | Secret / cookie name / HMAC algorithm allowlist / clock tolerance as `jwt` option on `createWebServer`        |
| Configurable logging               | 0.3.1   | S    | Levels + on/off; **redact `authorization` and `cookie`** (currently logged in plaintext)                      |
| Request lifecycle robustness       | 0.3.2   | S    | Handle `req` `error`/`aborted`; `listen()` must reject instead of crashing on `EADDRINUSE`                    |
| Graceful shutdown + timeouts       | 0.3.2   | S    | `closeIdleConnections` + drain timeout; expose `requestTimeout`/`headersTimeout`                              |
| Static file overhaul               | 0.3.3   | L    | See Known Issues — caching, `Content-Length`, async `fs`, dotfile denial, MIME gaps, header-sent guard        |
| Test coverage                      | 0.3.0   | L    | Backfill traversal, JWT rejection/`exp`, error mapping, partial content, body parsing; add coverage reporting |
| **Response API**                   | 0.4.0   | L    | Make `context.response` real: `status`, `headers`, `cookies`, `redirect()`, `Buffer`/`Stream` returns         |
| gen alignment for responses        | 0.4.0   | M    | Lets `gen` emit `201 Location`, `204`, server-side redirects, and `Set-Cookie`; removes the client-side hack  |
| Middleware / hook pipeline         | 0.5 ?   | L    | [ under rethinking ] `onRequest` / `preHandler` / `onSend` / `onError`, per-controller and per-route          |
| CORS, security headers, rate limit | 0.5.0   | M    | First-party opt-in middleware built on the pipeline                                                           |
| File uploads                       | 0.6     | L    | Multipart + streaming                                                                                         |
| Structured validation errors       | 0.6     | S    | `details` payload on errors so DTO field errors reach the client                                              |
| WebSocket support                  | 0.7     | L    | Requires exposing the underlying `http.Server` for `upgrade`                                                  |
| Dual ESM/CJS + `exports` map       | 1.0     | M    | CJS-only today, while generated apps are `"type": "module"`                                                   |
| Stage-3 decorator support          | 1.0     | M    | `tsconfig.json` omits `experimentalDecorators`, so shipped types are legacy 3-arg signatures                  |
| Expose `server` / `address()`      | 1.0     | S    | Prerequisite for WebSockets and cleaner testing                                                               |
| Move `IProvider` out               | 1.0     | S    | [ can be rethought ] Belongs in `@currentjs/provider`, not here                                               |


---

**Size Legend:** S = Small, M = Medium, L = Large, XL = Extra Large

---

## Known Issues

Each item is tagged with the release that is planned to fix it.

### Security

- **Tokens are logged in plaintext.** *(0.3.1)*
The per-request log writes `req.headers` wholesale, which includes `authorization` and `cookie`.
- ✅ **Internal error messages reach clients.** *(0.3.0 — fixed)*
A driver error such as `ER_BAD_FIELD_ERROR: Unknown column 'x'` used to be returned verbatim with
a 500. Non-`BaseHttpError` throws now respond with a generic `Internal Server Error` message, and
the original message + stack are written to the request log instead.
- ✅ **Unbounded request body.** *(0.3.0 size cap — fixed; 0.3.2 `error`/`aborted`)*
A `maxBodySize` option (default 1 MiB) now caps request bodies; over-limit requests are rejected
with `413` before a handler runs, either from `Content-Length` alone or once the streamed bytes
cross the limit. Still no `error`/`aborted` handler on `req`, so a client that disconnects
mid-upload (within the size cap) leaves the body promise pending forever — tracked for 0.3.2.
- **Dotfiles are served** from the static directory. *(0.3.3)*
- No `requestTimeout` / `headersTimeout` configuration (slowloris exposure). *(0.3.2)*

### Correctness

- **Decorator metadata leaks across a class hierarchy.** *(0.3.0)*
`defineRoute` tests `if (!target.constructor.routes)`, which resolves the base class's array
through the prototype chain and pushes into it. Two sibling controllers extending a common base
each end up serving all of the hierarchy's routes. `@Controller`'s `basePath` is inherited the
same way, so a subclass without the decorator silently adopts its parent's prefix. Fix with
own-property checks and copy-on-write.
- `**listen()` never handles the server's `error` event.** *(0.3.2)*
A port collision emits an unhandled `'error'` and crashes the process instead of rejecting the
promise.
- **Static-file errors after headers are sent.** *(0.3.3)*
`serveStaticFile` resolves `false` on a stream error even though it may already have piped into
`res`; the caller then sets `statusCode = 404` and throws `ERR_HTTP_HEADERS_SENT`, and the outer
catch throws again on the retry.
- **A catch-all route disables static serving.** *(0.3.3)*
Static files are only attempted after the route table misses, so any controller declaring
`@Get('/:slug')` swallows every asset request.
- **Multi-slash paths are not normalized.** *(0.3.0)*
The path join uses a non-global regex, so only the first run of slashes collapses; `@Get('//dup')`
under `/api` registers as `GET /api//dup`.
- `**statSync` blocks the event loop** on the request path, several times during index resolution.
*(0.3.3)*
- **Path params are never URL-decoded.** *(0.3.0)*
`/users/john%40doe.com` yields the encoded string, and static files with spaces or unicode in
their names are unreachable.

### Static files

*(0.3.3)* No `Content-Length`, `ETag`, `Last-Modified`, `Cache-Control`, or conditional-request
(`304`) support — every asset is fully re-downloaded on every page load. No `Range` requests and no
precompressed serving. The MIME map is missing `.mjs`, `.webp`, `.avif`, `.wasm`, `.map`, `.xml`,
and `.webmanifest`, so browser ESM modules are served as `application/octet-stream`.

### API surface

- `parameters` is typed `Record<string, string | number>`, but path params are always strings and
repeated query params are arrays. *(0.3.0)*
- `HttpMethod` omits `HEAD` and `OPTIONS`. *(0.3.0)*
- `traceId` uses `Math.random()`, is not returned as a response header, and is not exposed on the
context, so handlers cannot correlate their own logs with it. *(0.3.1)*
- `X-Layout` is set unconditionally on rendered responses, exposing internal template names.
*(0.4.0)*
- `close()` does not drop keep-alive sockets, so the `SIGTERM` handler in generated apps can hang.
*(0.3.2)*

## Coordination Notes

Generated `package.json` pins `'@currentjs/router': 'latest'`. Every change here ships into every
existing app with no semver protection — switch to a caret range in `@currentjs/gen` before landing
behavioral changes.

The 0.3.0 change that rejects present-but-invalid tokens has an interaction with generated apps:
`@currentjs/gen` stores the JWT in an `authToken` cookie with `max-age=31536000`. Once a token
expires the cookie keeps being sent, causing 401s on every request — including public routes — until
the cookie is cleared. Two follow-ups are needed:

- **`web/app.js` in gen** — clear `authToken` (localStorage + cookie) whenever any response is 401.
- **Switch gen's router pin** from `'latest'` to `'^0.3.0'` (see Coordination Note above).

The 0.4 and 0.5 releases are the ones that let `gen` **delete** code rather than accumulate more
workarounds:

- 0.4 (response API) removes the client-side redirect strategy and the JavaScript cookie write on
login. It also fixes the existing mismatch where templates emit `data-redirect` but
`handleFormSuccess` reads `data-base-path`.
- 0.5 (guards) replaces the five-line auth preamble currently inlined into every generated handler,
and closes the gap where `auth: owner` on a custom action only checks authentication.

