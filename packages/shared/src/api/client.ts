/**
 * API Client - Shared fetch wrapper for Android (React Native) and web
 *
 * Handles:
 * - Base URL configuration (env-based)
 * - Session identity: myalgodesk.in authenticates with a session cookie, so every
 *   request sends and receives cookies on native as well as web
 * - Optional bearer header from the configured token storage
 * - Error normalization
 * - WebSocket connection management
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiConfig {
  baseUrl: string;
  wsUrl: string;
  getToken: () => Promise<string | null>;
  setToken: (token: string | null) => Promise<void>;
  clearToken: () => Promise<void>;
}

export interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  timeout?: number;
}

export interface ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

function buildUrl(baseUrl: string, path: string, params?: RequestOptions["params"]): string {
  const url = new URL(path, baseUrl);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });
  }
  return url.toString();
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof Error && "status" in error;
}

export function createApiClient(config: ApiConfig) {
  async function getAuthHeader(): Promise<Record<string, string>> {
    const token = await config.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { params, signal, timeout = 30_000, headers, ...init } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const anySignal = (signals: AbortSignal[]): AbortSignal => {
      const AbortSignalAny = AbortSignal as any;
      if (typeof AbortSignalAny.any === "function") {
        return AbortSignalAny.any(signals);
      }
      const controller = new AbortController();
      signals.forEach(s => {
        if (s.aborted) {
          controller.abort();
        } else {
          s.addEventListener("abort", () => controller.abort(), { once: true });
        }
      });
      return controller.signal;
    };

    const finalSignal = signal ? anySignal([signal, controller.signal]) : controller.signal;

    try {
      const authHeaders = await getAuthHeader();
      const url = buildUrl(config.baseUrl, path, params);

      const response = await fetch(url, {
        ...init,
        signal: finalSignal,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          ...headers,
        },
        // myalgodesk.in keeps identity in a session cookie, so the native cookie jars
        // must store and replay it; "omit" makes every native request sign-out.
        credentials: "include",
      });

      if (!response.ok) {
        // One read of the body, parsed when it happens to be JSON. `json()` consumes the stream, so the
        // text fallback that used to follow it threw on a plain-text 502 — and that second error, not the
        // server's own words, is what reached the screen, status along with it.
        const body = await response.text();
        let details: unknown = body;
        try {
          details = JSON.parse(body);
        } catch {
          // Prod and the proxy both answer some failures in prose, and the prose is the reason.
        }
        const apiError = new Error(
          typeof details === "object" && details !== null && "message" in details
            ? String((details as Record<string, unknown>).message)
            : `HTTP ${response.status}: ${response.statusText}`
        ) as ApiError;
        apiError.status = response.status;
        apiError.code = typeof details === "object" && details !== null && "code" in details
          ? String((details as Record<string, unknown>).code)
          : undefined;
        apiError.details = details;
        throw apiError;
      }

      if (response.status === 204 || response.headers.get("content-length") === "0") {
        return undefined as T;
      }

      return JSON.parse(await response.text()) as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        const timeoutError = new Error("Request timeout") as ApiError;
        timeoutError.status = 408;
        timeoutError.code = "TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      // Held until the body is in rather than released the moment headers arrive: a server that answers
      // and then stalls mid-body is exactly the hang this timer exists to bound.
      clearTimeout(timeoutId);
    }
  }

  return {
    get: <T>(path: string, options?: RequestOptions) =>
      request<T>(path, { ...options, method: "GET" }),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: "POST", body: JSON.stringify(body) }),
    put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: "PUT", body: JSON.stringify(body) }),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: "PATCH", body: JSON.stringify(body) }),
    delete: <T>(path: string, options?: RequestOptions) =>
      request<T>(path, { ...options, method: "DELETE" }),

    createWebSocket: (path: string, protocols?: string | string[]) => {
      const wsUrl = `${config.wsUrl}${path}`;
      return new WebSocket(wsUrl, protocols);
    },

    rawFetch: async (path: string, options?: RequestOptions) => {
      const authHeaders = await getAuthHeader();
      return fetch(buildUrl(config.baseUrl, path, options?.params), {
        ...options,
        headers: {
          ...authHeaders,
          ...options?.headers,
        },
        credentials: "include",
      });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;