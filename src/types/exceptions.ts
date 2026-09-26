export class BaseError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BaseError";
  }
}

export class FormatError extends BaseError {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FormatError";
  }
}

export class IntegrityError extends BaseError {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntegrityError";
  }
}
