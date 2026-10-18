// Same-origin REST client (API.md §0). Every mutating call carries the CSRF
// header X-Requested-With: fetch.
import type { ApiError as ApiErrorBody } from '@socialchat/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
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
    throw new ApiError(res.status, err.error ?? `http_${res.status}`, err.message);
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
        reject(new ApiError(xhr.status, err.error ?? `http_${xhr.status}`, err.message));
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
