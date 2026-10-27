import { z } from 'zod';
import { NewsError, NewsTransport } from '../transport.js';
import type { NewsAdapter, NewsPage, NewsQuery } from '../types.js';
import {
  adapterQuery,
  baseObservation,
  decodePage,
  phrase,
  providerTime,
  validatedPage,
} from './common.js';
const responseSchema = z.object({
  status: z.literal('ok'),
  news: z
    .array(
      z.object({
        id: z.string().min(1),
        url: z.string(),
        title: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        language: z.string(),
        published: z.string().nullable().optional(),
      }),
    )
    .max(20),
});
export class CurrentsNews implements NewsAdapter {
  readonly provider = 'currents' as const;
  constructor(
    private readonly key: string,
    readonly transport = new NewsTransport(),
  ) {}
  async fetchPage(value: NewsQuery, signal: AbortSignal): Promise<NewsPage> {
    if (!this.key.trim()) throw new NewsError('NEWS_AUTH_FAILED');
    const q = adapterQuery(value, this.provider);
    if (q.domains.length !== 1 || !q.terms.length) throw new NewsError('NEWS_INVALID_QUERY');
    const params = new URLSearchParams({
      query: q.terms.map(phrase).join(' OR '),
      language: 'en',
      domain: q.domains[0]!,
      start_date: new Date(q.startAt).toISOString(),
      end_date: new Date(q.endAt).toISOString(),
      page_number: '1',
      page_size: '20',
    });
    const result = await this.transport.json(
      this.provider,
      params,
      { Authorization: `Bearer ${this.key}` },
      signal,
    );
    return decodePage(() => {
      const response = responseSchema.parse(result.data),
        time = this.transport.clock();
      return validatedPage({
        observations: response.news.map((a) => {
          const publishedAt = providerTime(a.published, this.provider);
          return {
            ...baseObservation(this.provider, q, time, a.url),
            providerArticleId: a.id,
            headline: a.title ?? null,
            description: a.description ?? null,
            language: a.language,
            publishedAt,
            timestampBasis: publishedAt === null ? 'unknown' : 'publication',
          };
        }),
        pagination: {
          truncated: response.news.length === 20,
          nextPage: response.news.length === 20 ? 2 : null,
        },
        quota: result.quota,
      });
    }, result.quota);
  }
}
