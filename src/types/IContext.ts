export interface AuthenticatedUser {
  id: string | number;
  role: string;
  email?: string;
  [key: string]: any;
}

export interface IRequestContext {
  url: string;
  /**
   * The request's hostname, derived from the `Host` header with any port
   * stripped (e.g. `example.com`). Empty string if no `Host` header was sent.
   * IPv6 literal hosts keep their brackets (e.g. `[::1]`).
   */
  domain: string;
  parameters: Record<string, string | number>;
  /**
   * Parsed request body. The exact type depends on the `Content-Type`:
   * - `application/json` / `+json`: the decoded JSON value
   * - `application/x-www-form-urlencoded`: a key→value object (repeated keys become arrays)
   * - `text/*`: a decoded string
   * - no/unknown Content-Type or body parsing disabled: a raw `Buffer`
   * - empty body: `undefined`
   */
  body: any;
  /**
   * The raw body bytes exactly as received, before any parsing.
   * Empty `Buffer` when there was no request body.
   */
  rawBody: Buffer;
  user?: AuthenticatedUser;
  headers: Record<string, string | string[]>;
  method: string;
  path: string;
}

export interface IContext {
  request: IRequestContext;
  response: Record<string, any>;
}

export interface IProvider {
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}

