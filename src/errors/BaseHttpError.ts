export abstract class BaseHttpError extends Error {
  protected constructor(
    private readonly code: number = 500,
    message: string = ''
  ) {
    super(message);
  }
  getHTTPCode(): number {
    return this.code;
  }
}