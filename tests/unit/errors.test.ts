import { describe, it, expect } from '../lib.js';
import { BaseHttpError } from '../../src/errors/BaseHttpError.js';
import * as errors from '../../src/errors/HttpErrors.js';
import * as router from '../../src/index.js';

const expectedCodes: Array<[keyof typeof errors, number]> = [
  ['BadRequestError', 400],
  ['UnauthorizedError', 401],
  ['PaymentRequiredError', 402],
  ['ForbiddenError', 403],
  ['NotFoundError', 404],
  ['MethodNotAllowedError', 405],
  ['NotAcceptableError', 406],
  ['RequestTimeoutError', 408],
  ['ConflictError', 409],
  ['GoneError', 410],
  ['PreconditionFailedError', 412],
  ['ContentTooLargeError', 413],
  ['UriTooLongError', 414],
  ['UnsupportedMediaTypeError', 415],
  ['ExpectationFailedError', 417],
  ['UnprocessableContentError', 422],
  ['TooEarlyError', 425],
  ['UpgradeRequiredError', 426],
  ['PreconditionRequiredError', 428],
  ['TooManyRequestsError', 429],
  ['RequestHeaderFieldsTooLargeError', 431],
  ['UnavailableForLegalReasonsError', 451],
  ['InternalServerErrorError', 500],
  ['NotImplementedError', 501],
  ['BadGatewayError', 502],
  ['ServiceNotAvailableError', 503],
  ['GatewayTimeoutError', 504],
  ['HttpVersionNotSupportedError', 505],
];

class ImATeapotError extends BaseHttpError {
  constructor(msg: string) {
    super(418, msg);
  }
}

describe('HttpErrors', () => {
  for (const [name, code] of expectedCodes) {
    it(`${String(name)} maps to ${code}`, () => {
      const ErrorClass = errors[name] as new (msg: string) => BaseHttpError;
      const error = new ErrorClass('boom');
      expect(error.getHTTPCode()).toBe(code);
      expect(error.message).toBe('boom');
      expect(error instanceof BaseHttpError).toBeTruthy();
      expect(error instanceof Error).toBeTruthy();
    });
  }

  it('exposes the concrete class name on the error', () => {
    expect(new errors.NotFoundError('x').name).toBe('NotFoundError');
    expect(new errors.UnprocessableContentError('x').name).toBe('UnprocessableContentError');
  });

  it('covers every exported error class and re-exports them all', () => {
    const exported = Object.keys(errors).sort();
    expect(exported).toEqual(expectedCodes.map(([name]) => String(name)).sort());
    for (const name of exported) {
      expect((router as any)[name]).toBe((errors as any)[name], `${name} is not re-exported`);
    }
  });
});

describe('BaseHttpError', () => {
  it('is exported from the package entry point', () => {
    expect(router.BaseHttpError).toBe(BaseHttpError);
  });

  it('can be extended with a custom status code', () => {
    const error = new ImATeapotError('no coffee here');
    expect(error.getHTTPCode()).toBe(418);
    expect(error.name).toBe('ImATeapotError');
    expect(error instanceof BaseHttpError).toBeTruthy();
  });
});
