export type ApiResponse =
  | { success: true; status: number }
  | {
      success: false
      /** 0 = no response (network error, timeout, CORS). */
      status: number
      /** From a `Retry-After` header, in ms. */
      retryAfterMs?: number
      error?: Error
    }

export interface PostOptions {
  headers?: Record<string, string>
  keepalive?: boolean
  timeoutMs: number
}

/** Seconds or an HTTP date → ms from now. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

/**
 * `fetch` that never throws and never reads a body: ingest answers 202 with nothing the
 * tracker needs, and an unread body is one less thing to fail on.
 *
 * `text/plain` keeps the request CORS-simple (no preflight), the same as a beacon, so every
 * send path looks identical to the server. Credentials are never sent.
 */
export class ApiClient {
  async post(url: string, body: string, options: PostOptions): Promise<ApiResponse> {
    if (typeof fetch === 'undefined') {
      return { success: false, status: 0, error: new Error('fetch unavailable') }
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null
    try {
      const response = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...options.headers },
        keepalive: options.keepalive,
        credentials: 'omit',
        signal: controller?.signal,
      })
      if (response.ok) return { success: true, status: response.status }
      return {
        success: false,
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
      }
    } catch (error) {
      return { success: false, status: 0, error: error as Error }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
