/**
 * Base class of every error the server maps to an HTTP status code.
 *
 * Anything thrown from a handler that is an `instanceof BaseHttpError` is
 * answered with its `getHTTPCode()`; everything else becomes a 500. Extend it
 * to cover a status that has no built-in class:
 *
 * ```ts
 * class ImATeapotError extends BaseHttpError {
 *   constructor(msg: string) {
 *     super(418, msg);
 *   }
 * }
 * ```
 */
export abstract class BaseHttpError extends Error {
  protected constructor(
    private readonly code: number = 500,
    message: string = ''
  ) {
    super(message);
    this.name = new.target.name;
  }
  getHTTPCode(): number {
    return this.code;
  }
}
