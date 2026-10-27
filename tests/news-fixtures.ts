export const now = Date.UTC(2026, 9, 9, 12);
export const observation = (overrides: Record<string, unknown> = {}) => ({
  provider: 'marketaux',
  providerArticleId: 'synthetic-1',
  url: 'https://publisher.example/story?id=1&utm_source=fixture#fragment',
  language: 'en',
  attribution: 'Synthetic publisher',
  publishedAt: now - 1000,
  firstSeenAt: null,
  timestampBasis: 'publication',
  ingestedAt: now,
  queryId: 'q1',
  attemptId: 'a1',
  headline: 'Synthetic earnings headline',
  description: 'Synthetic description',
  entities: [
    { symbol: 'TEST', name: 'Test Company', venue: 'NASDAQ', matchScore: 1, sentimentScore: 0.4 },
  ],
  policyVersions: [],
  ...overrides,
});

import { deniedPermissions, type NewsPolicy } from '../src/news/policies.js';
export const policy = (
  scope: 'provider' | 'publisher',
  provider: NewsPolicy['provider'] = 'marketaux',
  overrides: Partial<NewsPolicy> = {},
): NewsPolicy => ({
  id: `${provider}-${scope}`,
  version: 1,
  provider,
  scope,
  publisherDomain: scope === 'publisher' ? 'publisher.example' : null,
  status: 'approved',
  permissions: { ...deniedPermissions(), ingest: true, retainMetadata: true },
  evidence: 'Synthetic fixture permission; not a real license',
  reviewedAt: now - 1000,
  expiresAt: now + 86400000,
  retentionMs: 3600000,
  attribution: 'Synthetic publisher',
  ...overrides,
});
