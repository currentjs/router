import {BaseHttpError} from "./BaseHttpError";

// to choose the right one,
// see the https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status#client_error_responses

export class BadRequestError extends BaseHttpError {
  constructor(msg: string) {
    super(400, msg);
  }
}

export class UnauthorizedError extends BaseHttpError {
  constructor(msg: string) {
    super(401, msg);
  }
}

export class PaymentRequiredError extends BaseHttpError {
  constructor(msg: string) {
    super(402, msg);
  }
}

export class ForbiddenError extends BaseHttpError {
  constructor(msg: string) {
    super(403, msg);
  }
}

export class NotFoundError extends BaseHttpError {
  constructor(msg: string) {
    super(404, msg);
  }
}

export class MethodNotAllowedError extends BaseHttpError {
  constructor(msg: string) {
    super(405, msg);
  }
}

export class NotAcceptableError extends BaseHttpError {
  constructor(msg: string) {
    super(406, msg);
  }
}

export class RequestTimeoutError extends BaseHttpError {
  constructor(msg: string) {
    super(408, msg);
  }
}

export class ConflictError extends BaseHttpError {
  constructor(msg: string) {
    super(409, msg);
  }
}

export class GoneError extends BaseHttpError {
  constructor(msg: string) {
    super(410, msg);
  }
}

export class ContentTooLargeError extends BaseHttpError {
  constructor(msg: string) {
    super(413, msg);
  }
}

export class UriTooLongError extends BaseHttpError {
  constructor(msg: string) {
    super(414, msg);
  }
}

export class UnsupportedMediaTypeError extends BaseHttpError {
  constructor(msg: string) {
    super(415, msg);
  }
}

export class TooEarlyError extends BaseHttpError {
  constructor(msg: string) {
    super(425, msg);
  }
}

export class UpgradeRequiredError extends BaseHttpError {
  constructor(msg: string) {
    super(426, msg);
  }
}

export class TooManyRequestsError extends BaseHttpError {
  constructor(msg: string) {
    super(429, msg);
  }
}

export class UnavailableForLegalReasonsError extends BaseHttpError {
  constructor(msg: string) {
    super(451, msg);
  }
}

export class InternalServerErrorError extends BaseHttpError {
  constructor(msg: string) {
    super(500, msg);
  }
}

export class NotImplementedError extends BaseHttpError {
  constructor(msg: string) {
    super(501, msg);
  }
}

export class ServiceNotAvailableError extends BaseHttpError {
  constructor(msg: string) {
    super(503, msg);
  }
}