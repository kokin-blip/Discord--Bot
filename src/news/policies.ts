import { z } from 'zod';
import { providerSchema, timestampSchema } from './validation.js';
export const capabilities = [
  'ingest',
  'retainMetadata',
  'retainHeadline',
  'retainDescription',
  'analyze',
  'retainDerived',
  'publishMetadata',
  'publishHeadline',
  'publishDerived',
] as const;
export type NewsCapability = (typeof capabilities)[number];
const permissions = z
  .object(
    Object.fromEntries(capabilities.map((key) => [key, z.boolean()])) as Record<
      NewsCapability,
      z.ZodBoolean
    >,
  )
  .strict();
export const policySchema = z
  .object({
    id: z.string().min(1).max(256),
    version: z.number().int().positive(),
    provider: providerSchema,
    scope: z.enum(['provider', 'publisher']),
    publisherDomain: z
      .string()
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      .nullable(),
    status: z.enum(['approved', 'denied', 'revoked']),
    permissions,
    evidence: z.string().trim().min(1).max(2048),
    reviewedAt: timestampSchema,
    expiresAt: timestampSchema,
    retentionMs: z
      .number()
      .int()
      .positive()
      .max(30 * 86400000)
      .nullable(),
    attribution: z.string().max(512),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      (p.scope === 'provider') !== (p.publisherDomain === null) ||
      p.expiresAt <= p.reviewedAt ||
      (p.status === 'approved' &&
        (p.permissions.retainMetadata || p.permissions.retainDerived) &&
        p.retentionMs === null)
    )
      ctx.addIssue({ code: 'custom', message: 'NEWS_INVALID_POLICY' });
  });
export type NewsPolicy = z.infer<typeof policySchema>;
export function deniedPermissions(): NewsPolicy['permissions'] {
  return Object.fromEntries(capabilities.map((key) => [key, false])) as NewsPolicy['permissions'];
}
/** Both layers must explicitly permit use; expired/revoked versions never fall back. */
export function permitted(
  policies: NewsPolicy[],
  provider: NewsPolicy['provider'],
  domain: string,
  capability: NewsCapability,
  now: number,
): boolean {
  const latest = (scope: NewsPolicy['scope']) =>
    policies
      .filter(
        (p) =>
          p.provider === provider &&
          p.scope === scope &&
          (scope === 'provider' || p.publisherDomain === domain),
      )
      .sort((a, b) => b.version - a.version)[0];
  return ['provider', 'publisher'].every((scope) => {
    const p = latest(scope as NewsPolicy['scope']);
    return (
      p?.status === 'approved' &&
      p.reviewedAt <= now &&
      p.expiresAt > now &&
      p.permissions[capability]
    );
  });
}
export function applicablePolicies(
  policies: NewsPolicy[],
  provider: NewsPolicy['provider'],
  domain: string,
): NewsPolicy[] {
  return (['provider', 'publisher'] as const).flatMap((scope) => {
    const p = policies
      .filter(
        (p) =>
          p.provider === provider &&
          p.scope === scope &&
          (scope === 'provider' || p.publisherDomain === domain),
      )
      .sort((a, b) => b.version - a.version)[0];
    return p ? [p] : [];
  });
}
