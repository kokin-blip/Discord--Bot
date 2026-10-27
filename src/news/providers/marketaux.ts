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
  meta: z.object({
    found: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    page: z.literal(1),
  }),
  data: z
    .array(
      z.object({
        uuid: z.string().min(1),
        url: z.string(),
        title: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        language: z.string(),
        published_at: z.string().nullable().optional(),
        source: z.string(),
        entities: z
          .array(
            z.object({
              symbol: z.string(),
              name: z.string().nullable().optional(),
              exchange: z.string().nullable().optional(),
              match_score: z.number().nullable().optional(),
              sentiment_score: z.number().min(-1).max(1).nullable().optional(),
            }),
          )
          .max(100)
          .default([]),
      }),
    )
    .max(3),
});
export class MarketauxNews implements NewsAdapter {
  readonly provider = 'marketaux' as const;
  constructor(
    private readonly token: string,
    readonly transport = new NewsTransport(),
  ) {}
  async fetchPage(value: NewsQuery, signal: AbortSignal): Promise<NewsPage> {
    if (!this.token.trim()) throw new NewsError('NEWS_AUTH_FAILED');
    const q = adapterQuery(value, this.provider);
    const params = new URLSearchParams({
      api_token: this.token,
      language: 'en',
      domains: q.domains.join(','),
      filter_entities: 'true',
      group_similar: 'false',
      published_after: new Date(q.startAt).toISOString().slice(0, 19),
      published_before: new Date(q.endAt).toISOString().slice(0, 19),
      page: '1',
      limit: '3',
      sort: 'published_at',
    });
    if (q.symbols.length) {
      params.set('symbols', q.symbols.join(','));
      params.set('must_have_entities', 'true');
    } else params.set('search', q.terms.map(phrase).join(' | '));
    const result = await this.transport.json(this.provider, params, {}, signal);
    return decodePage(() => {
      const response = responseSchema.parse(result.data),
        time = this.transport.clock();
      if (response.meta.returned !== response.data.length) throw new Error('invalid count');
      return validatedPage({
        observations: response.data.map((a) => {
          const publishedAt = providerTime(a.published_at, this.provider);
          return {
            ...baseObservation(this.provider, q, time, a.url),
            providerArticleId: a.uuid,
            headline: a.title ?? null,
            description: a.description ?? null,
            language: a.language,
            publishedAt,
            timestampBasis: publishedAt === null ? 'unknown' : 'publication',
            entities: a.entities.map((e) => ({
              symbol: e.symbol,
              name: e.name ?? null,
              venue: e.exchange ?? null,
              matchScore: e.match_score ?? null,
              sentimentScore: e.sentiment_score ?? null,
            })),
          };
        }),
        pagination: {
          truncated: response.meta.found > response.data.length,
          nextPage: response.meta.found > response.data.length ? 2 : null,
        },
        quota: result.quota,
      });
    }, result.quota);
  }
}
