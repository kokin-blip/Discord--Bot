import { NEWS_LIMITS } from './config.js';
import type { NewsProvider } from './types.js';
export const newsErrorCodes = [
  'NEWS_TIMEOUT',
  'NEWS_NETWORK_FAILED',
  'NEWS_RESPONSE_TOO_LARGE',
  'NEWS_INVALID_RESPONSE',
  'NEWS_AUTH_FAILED',
  'NEWS_ACCESS_DENIED',
  'NEWS_INVALID_QUERY',
  'NEWS_PROVIDER_EXHAUSTED',
  'NEWS_RATE_LIMITED',
  'NEWS_PROVIDER_UNAVAILABLE',
  'NEWS_STORAGE_FAILED',
  'NEWS_RUNTIME_FAILED',
  'NEWS_STORAGE_LIMIT',
  'NEWS_STORAGE_DENIED',
  'NEWS_RETENTION_EXPIRED',
  'NEWS_IDENTITY_CONFLICT',
  'NEWS_CREDENTIAL_MISSING',
  'NEWS_RESOURCE_PAUSED',
  'NEWS_INITIALIZATION_FAILED',
  'NEWS_ANALYSIS_FAILED',
] as const;
export type NewsErrorCode = (typeof newsErrorCodes)[number];
export class NewsError extends Error {
  constructor(
    readonly code: NewsErrorCode,
    readonly retryAt: number | null = null,
    readonly remaining: number | null = null,
  ) {
    super(code);
  }
}
export function newsDiagnostic(error: unknown): NewsErrorCode {
  if (error instanceof NewsError) return error.code;
  if (error instanceof Error && newsErrorCodes.includes(error.message as NewsErrorCode))
    return error.message as NewsErrorCode;
  return 'NEWS_RUNTIME_FAILED';
}
const endpoints: Record<NewsProvider, string> = {
  marketaux: 'https://api.marketaux.com/v1/news/all',
  currents: 'https://api.currentsapi.services/v1/search',
  gdelt: 'https://api.gdeltproject.org/api/v2/doc/doc',
};
export type NewsFetch = (input: string, init: RequestInit) => Promise<Response>;
export function retryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const result = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(result) && result >= now && result <= 8640000000000000
    ? result
    : null;
}
export function quotaHeaders(headers: Headers, now: number) {
  // A *-Limit header is not assumed to mean remaining quota.
  const raw = headers.get('x-usagelimit-remaining') ?? headers.get('x-ratelimit-remaining');
  const remaining =
    raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  return {
    remaining,
    retryAt: retryAfter(headers.get('retry-after'), now),
    exhausted: remaining === 0,
  };
}
export class NewsTransport {
  constructor(
    readonly fetcher: NewsFetch = fetch,
    readonly clock: () => number = Date.now,
    readonly timeoutMs: number = NEWS_LIMITS.timeoutMs,
  ) {}
  async json(
    provider: NewsProvider,
    params: URLSearchParams,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ data: unknown; quota: ReturnType<typeof quotaHeaders> }> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const feedback: { value: ReturnType<typeof quotaHeaders> | null } = { value: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => {
        controller.abort();
        reject(new NewsError('NEWS_TIMEOUT'));
      };
      signal.addEventListener('abort', abortListener, { once: true });
      timer = setTimeout(abortListener, Math.min(this.timeoutMs, NEWS_LIMITS.timeoutMs));
      if (signal.aborted) abortListener();
    });
    const request = async () => {
      if (controller.signal.aborted) throw new NewsError('NEWS_TIMEOUT');
      const response = await this.fetcher(`${endpoints[provider]}?${params}`, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new NewsError('NEWS_TIMEOUT');
      }
      const quota = quotaHeaders(response.headers, this.clock());
      feedback.value = quota;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code: NewsErrorCode =
          response.status === 401
            ? 'NEWS_AUTH_FAILED'
            : response.status === 403
              ? 'NEWS_ACCESS_DENIED'
              : response.status === 402
                ? 'NEWS_PROVIDER_EXHAUSTED'
                : response.status === 429
                  ? 'NEWS_RATE_LIMITED'
                  : response.status >= 400 && response.status < 500
                    ? 'NEWS_INVALID_QUERY'
                    : 'NEWS_PROVIDER_UNAVAILABLE';
        throw new NewsError(code, quota.retryAt, quota.remaining);
      }
      const length = response.headers.get('content-length');
      if (length && Number(length) > NEWS_LIMITS.responseBytes) {
        void response.body?.cancel().catch(() => {});
        throw new NewsError('NEWS_RESPONSE_TOO_LARGE');
      }
      if (!response.body) throw new NewsError('NEWS_INVALID_RESPONSE');
      reader = response.body.getReader();
      let bytes = 0,
        text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > NEWS_LIMITS.responseBytes) throw new NewsError('NEWS_RESPONSE_TOO_LARGE');
        try {
          text += decoder.decode(part.value, { stream: true });
        } catch {
          throw new NewsError('NEWS_INVALID_RESPONSE');
        }
      }
      try {
        text += decoder.decode();
      } catch {
        throw new NewsError('NEWS_INVALID_RESPONSE');
      }
      try {
        return { data: JSON.parse(text) as unknown, quota };
      } catch {
        throw new NewsError('NEWS_INVALID_RESPONSE');
      }
    };
    try {
      return await Promise.race([request(), aborted]);
    } catch (error) {
      if (error instanceof NewsError)
        throw new NewsError(
          error.code,
          error.retryAt ?? feedback.value?.retryAt ?? null,
          error.remaining ?? feedback.value?.remaining ?? null,
        );
      throw new NewsError(controller.signal.aborted ? 'NEWS_TIMEOUT' : 'NEWS_NETWORK_FAILED');
    } finally {
      clearTimeout(timer);
      if (abortListener) signal.removeEventListener('abort', abortListener);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
}
