export class FlockError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FlockError";
    this.code = code;
    this.status = status;
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

