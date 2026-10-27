import { z } from 'zod';
import { words, NEWS_ANALYTICS_VERSION } from './mapping.js';
import { newsId } from './normalize.js';
import { timestampSchema, providerSchema } from './validation.js';
export const eventClassSchema = z.enum([
  'earnings_guidance',
  'acquisition',
  'legal_regulatory',
  'bankruptcy',
  'security_outage',
  'macro_policy',
  'other',
]);
export type EventClass = z.infer<typeof eventClassSchema>;
export type Severity = 'low' | 'medium' | 'high';
export interface Classification {
  eventClass: EventClass;
  severity: Severity;
  uncertain: boolean;
  rule: string;
  contextKey: string | null;
}
export const publisherGroupSchema = z
  .object({
    domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
    groupId: z.string().min(1).max(128),
    reviewedAt: timestampSchema,
    expiresAt: timestampSchema,
    evidence: z.string().trim().min(1).max(2048),
    firstParty: z.boolean().default(false),
    firstPartyTopics: z.array(z.string().min(1).max(256)).max(100).optional(),
  })
  .strict()
  .refine((p) => p.expiresAt > p.reviewedAt, { message: 'NEWS_INVALID_PUBLISHER_REVIEW' });
export type PublisherGroup = z.infer<typeof publisherGroupSchema>;
const textPattern = (text: string) => words(text).join(' ');
export function classifyEvent(text: string): Classification {
  const t = textPattern(text),
    uncertain =
      /\b(rumou?r|reportedly|may|might|could|considering|talks|alleged|unconfirmed|expected|preview|scheduled|plans|denies|denied|not|never)\b/.test(
        t,
      );
  let eventClass: EventClass = 'other',
    severity: Severity = 'low',
    rule = 'no_event_rule';
  if (/\b(bankruptcy|bankrupt|chapter 11)\b/.test(t)) {
    eventClass = 'bankruptcy';
    rule = 'bankruptcy_mention';
    if (/\b(file[ds] for bankruptcy|filed chapter 11|declared bankrupt)\b/.test(t)) {
      severity = 'high';
      rule = 'bankruptcy_filing';
    }
  } else if (/\b(data breach|hack|hacked|ransomware|outage)\b/.test(t)) {
    eventClass = 'security_outage';
    severity = 'medium';
    rule = 'security_or_outage';
    if (
      /\b(confirmed|disclosed)\b/.test(t) &&
      /\b(material|major)\b/.test(t) &&
      /\b(data breach|hack|ransomware)\b/.test(t)
    ) {
      severity = 'high';
      rule = 'material_security_incident';
    }
  } else if (/\b(lawsuit|regulator|regulatory|fined|penalty|court|ruling)\b/.test(t)) {
    eventClass = 'legal_regulatory';
    severity = 'medium';
    rule = 'legal_or_regulatory';
    if (/\bmaterial\b/.test(t) && /\b(final ruling|final penalty)\b/.test(t)) {
      severity = 'high';
      rule = 'final_material_legal_action';
    }
  } else if (/\b(federal reserve|central bank|ecb|interest rates|rate decision)\b/.test(t)) {
    eventClass = 'macro_policy';
    severity = 'medium';
    rule = 'macro_policy_mention';
    if (
      /\b(federal reserve|central bank|ecb)\b/.test(t) &&
      /\b(raises interest rates|cuts interest rates|announced rate hike|announced rate cut)\b/.test(
        t,
      )
    ) {
      severity = 'high';
      rule = 'announced_rate_decision';
    }
  } else if (/\b(acqui[rs]|acquisition|merger|takeover)/.test(t)) {
    eventClass = 'acquisition';
    severity = 'medium';
    rule = 'acquisition_or_merger';
  } else if (/\b(earnings|guidance|quarterly|estimates|profit warning)\b/.test(t)) {
    eventClass = 'earnings_guidance';
    severity = 'medium';
    rule = 'earnings_or_guidance';
  }
  if (uncertain) severity = 'low';
  const period =
    t.match(/\b(q[1-4]|first quarter|second quarter|third quarter|fourth quarter)\b/)?.[0] ?? null;
  const year = t.match(/\b20\d\d\b/)?.[0] ?? '';
  const target =
    eventClass === 'acquisition'
      ? t.match(/\b(?:acquires|acquire|acquired|buy|buys) ([a-z0-9]+(?: [a-z0-9]+)?)/)?.[1]
      : null;
  return {
    eventClass,
    severity,
    uncertain,
    rule,
    contextKey: period ? `${period}:${year}` : target ? newsId(target) : null,
  };
}
const stop = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'by',
  'at',
]);
export function titleTokens(title: string | null): string[] {
  return [
    ...new Set(
      words(title ?? '')
        .filter((word) => !stop.has(word))
        .map((word) => newsId(word)),
    ),
  ]
    .sort()
    .slice(0, 128);
}
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const aa = new Set(a),
    bb = new Set(b),
    intersection = [...aa].filter((word) => bb.has(word)).length;
  return intersection / (aa.size + bb.size - intersection);
}
export const observationEvidenceSchema = z
  .object({
    id: z.string(),
    provider: providerSchema,
    providerArticleId: z.string(),
    policyVersions: z.array(z.string()),
    expiresAt: timestampSchema,
  })
  .strict();
export const clusterEvidenceSchema = z
  .object({
    articleId: z.string(),
    observations: z.array(observationEvidenceSchema).min(1).max(20),
    titleTokens: z.array(z.string()).max(128),
    anchorTime: timestampSchema,
    publishedAt: timestampSchema.nullable(),
    firstSeenAt: timestampSchema.nullable(),
    publicationConflict: z.boolean(),
    ingestedAt: timestampSchema,
    expiresAt: timestampSchema,
    classification: z
      .object({
        eventClass: eventClassSchema,
        severity: z.enum(['low', 'medium', 'high']),
        uncertain: z.boolean(),
        rule: z.string(),
        contextKey: z.string().nullable(),
      })
      .strict(),
    mapping: z
      .object({
        instrumentId: z.string(),
        method: z.enum(['provider_entity', 'reviewed_alias']),
        confidence: z.number().min(0).max(1),
        aliasId: z.string().nullable(),
        observationId: z.string().nullable(),
        entityIndex: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    mappingConfidence: z.number().min(0).max(1),
    publisherDomain: z.string(),
    publisherGroup: publisherGroupSchema.nullable(),
  })
  .strict();
export type ClusterEvidence = z.infer<typeof clusterEvidenceSchema>;
export const clusterSchema = z
  .object({
    version: z.literal(NEWS_ANALYTICS_VERSION),
    topic: z.string(),
    eventClass: eventClassSchema,
    contextKey: z.string().nullable(),
    evidence: z.array(clusterEvidenceSchema).min(1).max(20),
  })
  .strict();
export type NewsCluster = z.infer<typeof clusterSchema>;
export function canCluster(cluster: NewsCluster, evidence: ClusterEvidence): boolean {
  if (
    cluster.eventClass !== evidence.classification.eventClass ||
    cluster.contextKey !== evidence.classification.contextKey
  )
    return false;
  if (cluster.evidence.some((existing) => existing.articleId === evidence.articleId)) return true;
  if (cluster.evidence.length >= 20) return false;
  if (
    !cluster.evidence.every(
      (existing) => Math.abs(existing.anchorTime - evidence.anchorTime) <= 86400000,
    )
  )
    return false;
  return cluster.evidence.some(
    (existing) =>
      Math.abs(existing.anchorTime - evidence.anchorTime) <= 86400000 &&
      similarity(existing.titleTokens, evidence.titleTokens) >= 0.75,
  );
}
export function independentPublishers(evidence: ClusterEvidence[], now: number): number {
  const groups: { groupId: string; tokens: string[] }[] = [];
  for (const e of [...evidence].sort((a, b) => a.articleId.localeCompare(b.articleId))) {
    const review = e.publisherGroup;
    if (!review || review.reviewedAt > now || review.expiresAt <= now) continue;
    if (
      groups.some((g) => g.groupId === review.groupId || similarity(g.tokens, e.titleTokens) >= 0.9)
    )
      continue;
    groups.push({ groupId: review.groupId, tokens: e.titleTokens });
  }
  return groups.length;
}
export function freshness(
  e: Pick<ClusterEvidence, 'publishedAt' | 'publicationConflict'>,
  now: number,
): 'fresh' | 'stale' | 'unknown' | 'future' {
  if (e.publishedAt === null || e.publicationConflict) return 'unknown';
  if (e.publishedAt > now) return 'future';
  return now - e.publishedAt <= 7200000 ? 'fresh' : 'stale';
}
export function clusterSummary(cluster: NewsCluster, now: number) {
  const evidence = cluster.evidence,
    rank = { low: 0, medium: 1, high: 2 };
  return {
    severity: [...evidence].sort(
      (a, b) => rank[b.classification.severity] - rank[a.classification.severity],
    )[0]!.classification.severity,
    expiresAt: Math.min(...evidence.map((e) => e.expiresAt)),
    independentPublishers: independentPublishers(evidence, now),
    freshness: evidence.some((e) => freshness(e, now) === 'fresh')
      ? 'fresh'
      : evidence.some((e) => freshness(e, now) === 'unknown')
        ? 'unknown'
        : evidence.some((e) => freshness(e, now) === 'future')
          ? 'future'
          : 'stale',
    mappingConfidence: Math.min(...evidence.map((e) => e.mappingConfidence)),
    uncertain: evidence.every((e) => e.classification.uncertain),
  };
}
