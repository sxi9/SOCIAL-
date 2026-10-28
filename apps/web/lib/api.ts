// Same-origin REST client (API.md §0). Every mutating call carries the CSRF
// header X-Requested-With: fetch.
import type { ApiError as ApiErrorBody } from '@socialchat/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Wave 1 §1.3: the server's Retry-After (seconds) on a 429, else null. */
  readonly retryAfter: number | null;
  constructor(status: number, code: string, message?: string, retryAfter: number | null = null) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** "try again in 40 s" / "in 3 min" from a 429's Retry-After; `fallback`
 * when the header is absent. Every "try again in a minute" string now
 * tells the truth. */
export function retryIn(err: unknown, fallback = 'in a minute'): string {
  const s = err instanceof ApiError ? err.retryAfter : null;
  if (s === null || !Number.isFinite(s) || s <= 0) return fallback;
  if (s < 90) return `in ${Math.max(1, Math.round(s))} s`;
  return `in ${Math.round(s / 60)} min`;
}

function retryAfterOf(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export class NetworkError extends Error {
  constructor() {
    super('network failure');
    this.name = 'NetworkError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, form?: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch';
  let payload: BodyInit | undefined;
  if (form !== undefined) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new NetworkError();
  }
  let data: unknown = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, err.error ?? `http_${res.status}`, err.message, retryAfterOf(res.headers.get('retry-after')));
  }
  return data as T;
}

/** Multipart upload with byte-level progress (fetch cannot report upload
 * progress; XHR can). Same contract as postForm: CSRF header, same-origin
 * cookies, JSON body back, ApiError on non-2xx, NetworkError on failure.
 * `onProgress` gets 0-100 as the bytes leave the device; the server-side
 * processing after 100% (thumbs, sniff) is covered by the caller's spinner. */
export function uploadForm<T>(
  path: string,
  form: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.responseType = 'text';
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      };
    }
    xhr.onerror = () => reject(new NetworkError());
    xhr.onabort = () => reject(new NetworkError());
    xhr.onload = () => {
      let data: unknown = null;
      if (xhr.status !== 204 && xhr.responseText) {
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const err = (data ?? {}) as Partial<ApiErrorBody>;
        reject(new ApiError(xhr.status, err.error ?? `http_${xhr.status}`, err.message, retryAfterOf(xhr.getResponseHeader('retry-after'))));
        return;
      }
      onProgress?.(100);
      resolve(data as T);
    };
    xhr.send(form);
  });
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  postForm: <T>(path: string, form: FormData) => request<T>('POST', path, undefined, form),
  /** postForm + upload progress (0-100). */
  uploadForm,
  put: <T = unknown>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T = unknown>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Only allow same-site relative redirect targets for ?next=. */
export function safeNext(raw: string | null | undefined): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/';
}
