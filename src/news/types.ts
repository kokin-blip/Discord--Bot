import type { z } from 'zod';
import type {
  observationSchema,
  providerSchema,
  querySchema,
  pageSchema,
  entitySchema,
} from './validation.js';
export type NewsProvider = z.infer<typeof providerSchema>;
export type NewsObservation = z.infer<typeof observationSchema>;
export type NewsEntity = z.infer<typeof entitySchema>;
export type NewsQuery = z.infer<typeof querySchema>;
export type NewsPage = z.infer<typeof pageSchema>;
/** Exactly one attempt; scheduler owns quota reservations and all retries. */
export interface NewsAdapter {
  readonly provider: NewsProvider;
  fetchPage(query: NewsQuery, signal: AbortSignal): Promise<NewsPage>;
}
