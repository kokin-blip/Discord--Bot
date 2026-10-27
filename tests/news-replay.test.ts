import { expect, it } from 'vitest';
import { replayNews } from '../src/research/news-replay.js';
import {
  fixtureTime as now,
  syntheticNewsReplay,
  syntheticNewsPolicy,
} from '../src/research/news-fixtures.js';
it('replays delayed evidence without future leakage and is deterministic under input reordering', () => {
  const fixture = syntheticNewsReplay(),
    full = replayNews(fixture);
  expect(full.productionEligible).toBe(false);
  expect(full.snapshots[0]!.clusters).toHaveLength(1);
  expect(full.snapshots[2]!.clusters.filter((c) => c.topic.startsWith('instrument:'))).toHaveLength(
    1,
  ); // ambiguous bare ticker remains unassigned
  expect(full).toEqual(replayNews({ ...fixture, events: [...fixture.events].reverse() }));
  expect(full.snapshots.slice(0, 2)).toEqual(
    replayNews({
      ...fixture,
      ticks: fixture.ticks.slice(0, 2),
      events: fixture.events.filter((e) => e.at <= now + 60000),
    }).snapshots,
  );
  expect(full.snapshots[0]!.sentiments.map((s) => s.origin).sort()).toEqual(['local', 'marketaux']);
});
it('does not preload future reviews, rejects misleading availability times and respects revocation', () => {
  const fixture = syntheticNewsReplay();
  const delayed = {
    ...fixture,
    events: fixture.events.map((e) => (e.kind === 'alias' ? { ...e, at: now + 60000 } : e)),
  };
  expect(
    replayNews(delayed).snapshots[0]!.clusters.filter((c) => c.topic.startsWith('instrument:')),
  ).toHaveLength(0);
  const future = structuredClone(fixture);
  const observation = future.events.find((e) => e.kind === 'observation')!;
  if ('ingestedAt' in observation.value) observation.value.ingestedAt = now + 1;
  expect(() => replayNews(future)).toThrow('NEWS_REPLAY_FUTURE_INPUT');
  const revoked = {
    ...syntheticNewsPolicy('publisher', 'marketaux'),
    version: 2,
    id: 'revoked',
    status: 'revoked',
    reviewedAt: now + 60000,
  };
  const output = replayNews({
    ...fixture,
    events: [...fixture.events, { kind: 'policy', at: now + 60000, value: revoked }],
  });
  expect(output.snapshots[1]!.sentiments.some((s) => s.origin === 'marketaux')).toBe(false);
  expect(() => replayNews({ ...fixture, ticks: [now, now] })).toThrow('NEWS_REPLAY_TICKS_ORDER');
});
it('unknown publication time stays unknown; future publication is not fresh', () => {
  const fixture = syntheticNewsReplay();
  const observation = fixture.events.find((e) => e.kind === 'observation')!;
  const value = {
    ...observation.value,
    provider: 'gdelt',
    providerArticleId: 'unknown',
    publishedAt: null,
    firstSeenAt: now - 1000,
    timestampBasis: 'provider_first_seen',
    entities: [],
  };
  const result = replayNews({
    ...fixture,
    events: [
      ...fixture.events.filter((e) => e.kind !== 'observation'),
      { kind: 'observation', at: now, value },
    ],
  });
  expect(JSON.stringify(result.snapshots[0]!.clusters)).toContain('unknown');
});
