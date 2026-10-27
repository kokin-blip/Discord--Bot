import { expect, it } from 'vitest';
import {
  classifyEvent,
  canCluster,
  freshness,
  independentPublishers,
  titleTokens,
  similarity,
  type ClusterEvidence,
  type NewsCluster,
} from '../src/news/clustering.js';
import { NEWS_ANALYTICS_VERSION } from '../src/news/mapping.js';
import { now } from './news-fixtures.js';
const evidence = (overrides: Partial<ClusterEvidence> = {}): ClusterEvidence => ({
  articleId: 'a',
  observations: [
    {
      id: 'o',
      provider: 'marketaux',
      providerArticleId: 'p',
      policyVersions: ['fixture@1'],
      expiresAt: now + 10000,
    },
  ],
  titleTokens: titleTokens('Test Company quarterly earnings beats estimates'),
  anchorTime: now,
  publishedAt: now,
  firstSeenAt: null,
  publicationConflict: false,
  ingestedAt: now,
  expiresAt: now + 10000,
  classification: classifyEvent('Test Company quarterly earnings beats estimates'),
  mapping: null,
  mappingConfidence: 0,
  publisherDomain: 'publisher.example',
  publisherGroup: null,
  ...overrides,
});
const cluster = (e = evidence()): NewsCluster => ({
  version: NEWS_ANALYTICS_VERSION,
  topic: 'TEST',
  eventClass: e.classification.eventClass,
  contextKey: e.classification.contextKey,
  evidence: [e],
});
it('distinguishes confirmed severe events from rumors and routine mentions', () => {
  for (const [text, eventClass] of [
    ['Company filed for bankruptcy', 'bankruptcy'],
    ['Company confirmed material data breach', 'security_outage'],
    ['Company fined material final penalty', 'legal_regulatory'],
    ['Federal Reserve cuts interest rates', 'macro_policy'],
  ] as const) {
    expect(classifyEvent(text)).toMatchObject({ eventClass, severity: 'high', uncertain: false });
    expect(classifyEvent('Rumor ' + text)).toMatchObject({
      eventClass,
      severity: 'low',
      uncertain: true,
    });
  }
  expect(classifyEvent('Company outage').severity).toBe('medium');
  expect(classifyEvent('Company acquires Beta')).toMatchObject({ eventClass: 'acquisition' });
  expect(classifyEvent('Company earnings Q1 2026').contextKey).not.toBe(
    classifyEvent('Company earnings Q2 2026').contextKey,
  );
});
it('bounds clustering by title similarity, period, capacity and a 24-hour window', () => {
  expect(
    similarity(
      titleTokens('Test Company quarterly earnings beats estimates'),
      titleTokens('Test Company quarterly earnings beats estimates today'),
    ),
  ).toBeGreaterThanOrEqual(0.75);
  expect(canCluster(cluster(), evidence({ articleId: 'b' }))).toBe(true);
  expect(canCluster(cluster(), evidence({ articleId: 'b', anchorTime: now + 86400001 }))).toBe(
    false,
  );
  expect(
    canCluster(
      cluster(),
      evidence({ articleId: 'b', titleTokens: titleTokens('Test Company opens new offices') }),
    ),
  ).toBe(false);
  expect(
    canCluster(
      cluster(),
      evidence({ articleId: 'b', classification: classifyEvent('Test Company bankruptcy') }),
    ),
  ).toBe(false);
  const full = {
    ...cluster(),
    evidence: Array.from({ length: 20 }, (_, i) => evidence({ articleId: String(i) })),
  };
  expect(canCluster(full, evidence({ articleId: 'new' }))).toBe(false);
  expect(canCluster(full, evidence({ articleId: '1' }))).toBe(true);
});
it('counts reviewed independent publishers conservatively, excluding syndicated copies', () => {
  const group = (groupId: string) => ({
    domain: 'publisher.example',
    groupId,
    reviewedAt: now - 1,
    expiresAt: now + 1000,
    evidence: 'Synthetic review',
    firstParty: false,
  });
  const a = evidence({ publisherGroup: group('owner-a') });
  expect(
    independentPublishers([a, evidence({ articleId: 'b', publisherGroup: group('owner-b') })], now),
  ).toBe(1);
  const b = evidence({
    articleId: 'b',
    publisherGroup: group('owner-b'),
    titleTokens: titleTokens('Test Company quarterly earnings beats estimates today'),
  });
  expect(independentPublishers([a, b], now)).toBe(2);
  expect(independentPublishers([a, { ...b, publisherGroup: group('owner-a') }], now)).toBe(1);
  expect(independentPublishers([evidence()], now)).toBe(0);
  expect(independentPublishers([a], now + 1000)).toBe(0);
});
it('never substitutes provider first-seen times for publication freshness', () => {
  expect(freshness(evidence({ publishedAt: null, firstSeenAt: now }), now)).toBe('unknown');
  expect(freshness(evidence({ publicationConflict: true }), now)).toBe('unknown');
  expect(freshness(evidence({ publishedAt: now + 1 }), now)).toBe('future');
  expect(freshness(evidence({ publishedAt: now - 7200001 }), now)).toBe('stale');
  expect(freshness(evidence(), now)).toBe('fresh');
});
