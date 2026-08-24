export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512';

export interface JwtOptions {
  /** JWT signing secret. Defaults to `process.env.JWT_SECRET` (read lazily). */
  secret?: string | Buffer;
  /**
   * Name of the cookie to check when the `Authorization` header is absent.
   * Set to `false` to disable the cookie fallback entirely.
   * Defaults to `'authToken'`.
   */
  cookieName?: string | false;
  /**
   * Allowed signing algorithms. Only HMAC-SHA variants are supported.
   * Defaults to `['HS256']`.
   */
  algorithms?: JwtAlgorithm[];
  /**
   * Number of seconds of leeway to apply when validating `exp` and `nbf` claims.
   * Defaults to `0`.
   */
  clockToleranceSec?: number;
  /**
   * When `true`, tokens without an `exp` claim are rejected.
   * Defaults to `false`.
   */
  requireExpiration?: boolean;
}

/** Fully-resolved JWT options with all defaults applied. */
export interface ResolvedJwtOptions {
  secret: string | Buffer | undefined;
  cookieName: string | false;
  algorithms: JwtAlgorithm[];
  clockToleranceSec: number;
  requireExpiration: boolean;
}
