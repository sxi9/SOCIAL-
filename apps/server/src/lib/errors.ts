export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message?: string,
    public readonly retryAfterS?: number,
  ) {
    super(message ?? code);
  }
}

export const unauthenticated = () => new ApiError(401, 'unauthenticated');
export const forbidden = (code = 'forbidden') => new ApiError(403, code);
export const notFound = (code = 'not_found') => new ApiError(404, code);
export const badRequest = (code: string, message?: string) => new ApiError(400, code, message);
export const conflict = (code: string) => new ApiError(409, code);
export const tooLarge = (code = 'too_large') => new ApiError(413, code);
export const unsupportedMedia = (code = 'unsupported_media_type') => new ApiError(415, code);
export const rateLimited = (retryAfterS: number) =>
  new ApiError(429, 'rate_limited', undefined, retryAfterS);
