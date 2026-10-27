import { z } from 'zod';
import { Store } from '../storage.js';
import { NewsStore } from '../news/store.js';
import { NewsIntelligence } from '../news/intelligence.js';
import { aliasSchema, NEWS_ANALYTICS_VERSION } from '../news/mapping.js';
import { publisherGroupSchema } from '../news/clustering.js';
import { policySchema } from '../news/policies.js';
import { newsConfigSchema } from '../news/config.js';
import { observationSchema, timestampSchema } from '../news/validation.js';
import { newsId } from '../news/normalize.js';
const timed = <T extends z.ZodType>(kind: string, value: T) =>
  z.object({ kind: z.literal(kind), at: timestampSchema, value }).strict();
export const newsReplaySchema = z
  .object({
    instruments: z
      .array(
        z
          .object({
            id: z.string().min(1),
            symbol: z.string().min(1),
            market: z.enum(['equity', 'crypto']),
            venue: z.string().min(1),
            sector: z.string().optional(),
          })
          .strict(),
      )
      .max(100),
    ticks: z.array(timestampSchema).min(1).max(2000),
    events: z
      .array(
        z.union([
          timed('config', newsConfigSchema),
          timed('policy', policySchema),
          timed('alias', aliasSchema),
          timed('publisher', publisherGroupSchema),
          timed('observation', observationSchema),
        ]),
      )
      .max(20000),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.ticks.some((t, i) => i > 0 && t <= input.ticks[i - 1]!))
      ctx.addIssue({ code: 'custom', message: 'NEWS_REPLAY_TICKS_ORDER' });
    if (new Set(input.instruments.map((i) => i.id)).size !== input.instruments.length)
      ctx.addIssue({ code: 'custom', message: 'NEWS_REPLAY_DUPLICATE_INSTRUMENT' });
    for (const event of input.events) {
      const availableAt =
        'ingestedAt' in event.value
          ? event.value.ingestedAt
          : 'reviewedAt' in event.value
            ? event.value.reviewedAt
            : event.at;
      if (availableAt > event.at)
        ctx.addIssue({ code: 'custom', message: 'NEWS_REPLAY_FUTURE_INPUT' });
    }
  });
/** Isolated, offline research. Never enqueues news, sends messages or touches trading state. */
export function replayNews(value: unknown) {
  const input = newsReplaySchema.parse(value),
    store = new Store(':memory:');
  try {
    const news = new NewsStore(store, input.ticks[0]!),
      engine = new NewsIntelligence(news);
    for (const instrument of input.instruments) store.pin(instrument);
    // Reviews/configuration become available before observations at the same timestamp.
    const priority: Record<string, number> = {
      config: 0,
      policy: 1,
      alias: 2,
      publisher: 3,
      observation: 4,
    };
    const events = [...input.events].sort(
      (a, b) =>
        a.at - b.at || priority[a.kind]! - priority[b.kind]! || newsId(a).localeCompare(newsId(b)),
    );
    let cursor = 0;
    const snapshots = input.ticks.map((now) => {
      let suppressed = 0;
      while (cursor < events.length && events[cursor]!.at <= now) {
        const event = events[cursor++]!;
        switch (event.kind) {
          case 'config':
            news.saveConfig(event.value);
            break;
          case 'policy':
            news.savePolicy(event.value);
            break;
          case 'alias':
            news.saveAlias(event.value);
            break;
          case 'publisher':
            news.savePublisherGroup(event.value);
            break;
          case 'observation':
            try {
              news.saveObservation(event.value, now);
            } catch (error) {
              if (
                error instanceof Error &&
                [
                  'NEWS_STORAGE_DENIED',
                  'NEWS_RETENTION_EXPIRED',
                  'NEWS_IDENTITY_CONFLICT',
                ].includes(error.message)
              )
                suppressed++;
              else throw error;
            }
        }
      }
      news.cleanup(now);
      const analysis = news.config().enabled ? engine.process(now) : { processed: 0, failed: 0 };
      const ids = store.db
        .prepare('SELECT id FROM news_events WHERE expires_at>? ORDER BY id LIMIT 2000')
        .all(now) as { id: string }[];
      const clusters = ids.flatMap(({ id }) => {
        const event = engine.event(id, now);
        return event
          ? [
              {
                id,
                topic: event.cluster.topic,
                eventClass: event.cluster.eventClass,
                severity: event.summary.severity,
                summary: event.summary,
              },
            ]
          : [];
      });
      const sentiments = [...input.instruments.map((i) => i.id), null].flatMap((id) =>
        engine.sentiments(id, now).map((s) => ({ instrumentId: id, ...s })),
      );
      return { at: now, suppressed, analysis, clusters, sentiments };
    });
    return { analyticsVersion: NEWS_ANALYTICS_VERSION, productionEligible: false, snapshots };
  } finally {
    store.close();
  }
}
