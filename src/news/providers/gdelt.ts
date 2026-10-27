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
  articles: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().nullable().optional(),
        seendate: z.string().nullable().optional(),
        language: z.string(),
      }),
    )
    .max(20),
});
const date = (value: number) => new Date(value).toISOString().slice(0, 19).replace(/[-:T]/g, '');
export class GdeltNews implements NewsAdapter {
  readonly provider = 'gdelt' as const;
  constructor(readonly transport = new NewsTransport()) {}
  async fetchPage(value: NewsQuery, signal: AbortSignal): Promise<NewsPage> {
    const q = adapterQuery(value, this.provider);
    if (!q.terms.length || q.endAt - q.startAt < 900000) throw new NewsError('NEWS_INVALID_QUERY');
    const params = new URLSearchParams({
      query: `(${q.terms.map(phrase).join(' OR ')}) (${q.domains.map((d) => `domainis:${d}`).join(' OR ')}) sourcelang:english`,
      mode: 'ArtList',
      format: 'json',
      sort: 'DateDesc',
      maxrecords: '20',
      startdatetime: date(q.startAt),
      enddatetime: date(q.endAt),
    });
    const result = await this.transport.json(this.provider, params, {}, signal);
    return decodePage(() => {
      const response = responseSchema.parse(result.data),
        time = this.transport.clock();
      return validatedPage({
        observations: response.articles.map((a) => {
          const firstSeenAt = providerTime(a.seendate, this.provider);
          return {
            ...baseObservation(this.provider, q, time, a.url),
            headline: a.title ?? null,
            language: a.language.toLowerCase() === 'english' ? 'en' : a.language.toLowerCase(),
            firstSeenAt,
            timestampBasis: firstSeenAt === null ? 'unknown' : 'provider_first_seen',
          };
        }),
        pagination: { truncated: response.articles.length === 20, nextPage: null },
        quota: result.quota,
      });
    }, result.quota);
  }
}
