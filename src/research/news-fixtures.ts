import { equity } from '../domain.js';
import { deniedPermissions, type NewsPolicy } from '../news/policies.js';
import { newsReplaySchema } from './news-replay.js';
export const fixtureTime = Date.UTC(2026, 9, 9, 12);
export function syntheticNewsPolicy(
  scope: 'provider' | 'publisher',
  provider: NewsPolicy['provider'],
  time = fixtureTime,
): NewsPolicy {
  return {
    id: `${provider}-${scope}`,
    version: 1,
    provider,
    scope,
    publisherDomain: scope === 'publisher' ? 'publisher.example' : null,
    status: 'approved',
    permissions: {
      ...deniedPermissions(),
      ingest: true,
      retainMetadata: true,
      retainHeadline: true,
      retainDescription: true,
      analyze: true,
      retainDerived: true,
      publishMetadata: true,
      publishDerived: true,
    },
    evidence: 'Synthetic fixture only; never a real license',
    reviewedAt: time - 1000,
    expiresAt: time + 10 * 86400000,
    retentionMs: 7 * 86400000,
    attribution: 'Synthetic publisher',
  };
}
export function syntheticNewsReplay() {
  const instrument = equity('TEST'),
    time = fixtureTime;
  const observation = {
    provider: 'marketaux' as const,
    providerArticleId: 'synthetic-1',
    url: 'https://publisher.example/story?id=1',
    language: 'en',
    attribution: 'Synthetic publisher',
    publishedAt: time - 1000,
    firstSeenAt: null,
    timestampBasis: 'publication' as const,
    ingestedAt: time,
    queryId: 'synthetic',
    attemptId: 'synthetic',
    headline: 'Test Company filed for bankruptcy',
    description: null,
    entities: [
      {
        symbol: 'TEST',
        name: 'Test Company',
        venue: 'NASDAQ',
        matchScore: 1,
        sentimentScore: -0.8,
      },
    ],
    policyVersions: [],
  };
  return newsReplaySchema.parse({
    instruments: [instrument],
    ticks: [time, time + 60000, time + 120000, time + 180000],
    events: [
      {
        kind: 'config',
        at: time,
        value: { enabled: true, providers: { marketaux: true, currents: true, gdelt: true } },
      },
      ...(['marketaux', 'currents', 'gdelt'] as const).flatMap((provider) =>
        (['provider', 'publisher'] as const).map((scope) => ({
          kind: 'policy',
          at: time,
          value: syntheticNewsPolicy(scope, provider),
        })),
      ),
      {
        kind: 'alias',
        at: time,
        value: {
          id: 'synthetic-issuer',
          instrumentId: instrument.id,
          alias: 'Test Company',
          venue: 'NASDAQ',
          reviewedAt: time - 1000,
          expiresAt: time + 86400000,
          evidence: 'Synthetic issuer review',
        },
      },
      { kind: 'observation', at: time, value: observation },
      {
        kind: 'observation',
        at: time + 60000,
        value: {
          ...observation,
          provider: 'currents',
          providerArticleId: 'syndicated',
          ingestedAt: time + 60000,
          entities: [],
        },
      },
      {
        kind: 'observation',
        at: time + 120000,
        value: {
          ...observation,
          provider: 'gdelt',
          providerArticleId: 'first-seen-only',
          url: 'https://publisher.example/story?id=2',
          ingestedAt: time + 120000,
          publishedAt: null,
          firstSeenAt: time + 60000,
          timestampBasis: 'provider_first_seen',
          headline: 'TEST might file for bankruptcy',
          entities: [],
        },
      },
    ],
  });
}
