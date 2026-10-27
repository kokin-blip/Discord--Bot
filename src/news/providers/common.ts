import { newsId, utcTimestamp, publisherDomain, canonicalUrl } from '../normalize.js';
import { pageSchema, querySchema } from '../validation.js';
import { NewsError } from '../transport.js';
import type { NewsObservation, NewsPage, NewsProvider, NewsQuery } from '../types.js';
export function adapterQuery(value: NewsQuery, provider: NewsProvider): NewsQuery {
  const parsed = querySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.provider !== provider ||
    !parsed.data.domains.length ||
    (!parsed.data.terms.length && !parsed.data.symbols.length)
  )
    throw new NewsError('NEWS_INVALID_QUERY');
  return parsed.data;
}
export function phrase(term: string): string {
  return `"${term.replace(/["\\\r\n]/g, ' ')}"`;
}
export function baseObservation(
  provider: NewsProvider,
  query: NewsQuery,
  ingestedAt: number,
  url: string,
): NewsObservation {
  return {
    provider,
    providerArticleId: newsId(canonicalUrl(url)),
    url,
    language: 'en',
    attribution: publisherDomain(url),
    publishedAt: null,
    firstSeenAt: null,
    timestampBasis: 'unknown',
    ingestedAt,
    queryId: query.id,
    attemptId: query.attemptId ?? newsId(provider, query.id, query.endAt),
    headline: null,
    description: null,
    entities: [],
    policyVersions: [],
  };
}
export function providerTime(
  value: string | null | undefined,
  provider: NewsProvider,
): number | null {
  return value ? utcTimestamp(value, provider) : null;
}
export function validatedPage(value: NewsPage): NewsPage {
  const result = pageSchema.safeParse(value);
  if (!result.success) throw new NewsError('NEWS_INVALID_RESPONSE');
  return result.data;
}
export function decodePage<T>(decode: () => T, quota?: NewsPage['quota']): T {
  try {
    return decode();
  } catch (error) {
    throw new NewsError(
      error instanceof NewsError ? error.code : 'NEWS_INVALID_RESPONSE',
      quota?.retryAt ?? null,
      quota?.remaining ?? null,
    );
  }
}
