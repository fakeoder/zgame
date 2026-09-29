export const ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  ROOM_CLOSED: "ROOM_CLOSED",
  ROOM_FULL: "ROOM_FULL",
  EXPIRED: "EXPIRED",
  CONFLICT: "CONFLICT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiErrorBody {
  error: ErrorCode;
  message?: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number, message?: string) {
    super(message ?? code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function apiErrorBody(code: ErrorCode, message?: string): ApiErrorBody {
  return message ? { error: code, message } : { error: code };
}
