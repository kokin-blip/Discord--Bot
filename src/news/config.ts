import { z } from 'zod';
export const NEWS_CAPS = Object.freeze({ marketaux: 60, currents: 100, gdelt: 30 });
export const NEWS_LIMITS = Object.freeze({
  timeoutMs: 8000,
  responseBytes: 512 * 1024,
  queries: 64,
  articleRetentionMs: 7 * 86400000,
  derivedRetentionMs: 30 * 86400000,
  articles: 5000,
  observations: 10000,
  events: 2000,
  cleanupBatch: 100,
  storageBytes: 64 * 1024 * 1024,
  objectStorageBytes: 800000000,
  dailyReads: 100000,
  dailyWrites: 10000,
});
export const newsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    digest: z.boolean().default(false),
    alerts: z.boolean().default(false),
    providers: z
      .object({
        marketaux: z.boolean().default(false),
        currents: z.boolean().default(false),
        gdelt: z.boolean().default(false),
      })
      .strict()
      .default({ marketaux: false, currents: false, gdelt: false }),
    dailyCaps: z
      .object({
        marketaux: z.number().int().min(0).max(60).default(60),
        currents: z.number().int().min(0).max(100).default(100),
        gdelt: z.number().int().min(0).max(30).default(30),
      })
      .strict()
      .default({ ...NEWS_CAPS }),
  })
  .strict();
export type NewsConfig = z.infer<typeof newsConfigSchema>;
export const initialNewsConfig = (): NewsConfig => newsConfigSchema.parse({});
