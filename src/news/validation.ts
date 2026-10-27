import { z } from 'zod';
import { canonicalUrl, publisherDomain } from './normalize.js';
export const providerSchema = z.enum(['marketaux', 'currents', 'gdelt']);
export const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const linkSchema = z
  .string()
  .max(4096)
  .transform((value, ctx) => {
    try {
      return canonicalUrl(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'NEWS_INVALID_URL' });
      return z.NEVER;
    }
  });
const id = z.string().trim().min(1).max(256);
export const entitySchema = z
  .object({
    symbol: id,
    name: z.string().max(256).nullable(),
    venue: id.nullable(),
    matchScore: z.number().finite().nullable(),
    sentimentScore: z.number().min(-1).max(1).nullable(),
  })
  .strict();
export const observationSchema = z
  .object({
    provider: providerSchema,
    providerArticleId: id,
    url: linkSchema,
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2})?$/),
    attribution: z.string().max(512),
    publishedAt: timestampSchema.nullable(),
    firstSeenAt: timestampSchema.nullable(),
    timestampBasis: z.enum(['publication', 'provider_first_seen', 'unknown']),
    ingestedAt: timestampSchema,
    queryId: id,
    attemptId: id,
    headline: z.string().max(2048).nullable(),
    description: z.string().max(8192).nullable(),
    entities: z.array(entitySchema).max(100),
    policyVersions: z.array(id).max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.timestampBasis === 'publication' && value.publishedAt === null) ||
      (value.timestampBasis === 'provider_first_seen' && value.firstSeenAt === null) ||
      (value.timestampBasis === 'unknown' &&
        (value.publishedAt !== null || value.firstSeenAt !== null)) ||
      (value.provider === 'gdelt' && value.publishedAt !== null)
    )
      ctx.addIssue({ code: 'custom', message: 'NEWS_INVALID_PROVENANCE' });
  });
export function validateObservation(value: unknown) {
  const observation = observationSchema.parse(value);
  return { ...observation, publisherDomain: publisherDomain(observation.url) };
}
export const querySchema = z
  .object({
    id,
    provider: providerSchema,
    domains: z
      .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/))
      .max(20)
      .default([]),
    attemptId: id.optional(),
    symbols: z.array(z.string().regex(/^[A-Z0-9.-]{1,32}$/)).max(20),
    terms: z.array(z.string().trim().min(1).max(256)).max(20),
    startAt: timestampSchema,
    endAt: timestampSchema,
    page: z.literal(1),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.endAt <= q.startAt || q.endAt - q.startAt > 24 * 60 * 60 * 1000)
      ctx.addIssue({ code: 'custom', message: 'NEWS_INVALID_WINDOW' });
  });
export const pageSchema = z
  .object({
    observations: z.array(observationSchema).max(20),
    pagination: z
      .object({ truncated: z.boolean(), nextPage: z.number().int().positive().nullable() })
      .strict(),
    quota: z
      .object({
        remaining: z.number().int().nonnegative().nullable(),
        retryAt: timestampSchema.nullable(),
        exhausted: z.boolean(),
      })
      .strict(),
  })
  .strict();
