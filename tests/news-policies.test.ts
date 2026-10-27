import { expect, it } from 'vitest';
import { permitted, policySchema } from '../src/news/policies.js';
import { now, policy } from './news-fixtures.js';
it('requires current provider and publisher approval for each capability', () => {
  const p = policy('provider'),
    s = policy('publisher');
  expect(permitted([], 'marketaux', 'publisher.example', 'ingest', now)).toBe(false);
  expect(permitted([p], 'marketaux', 'publisher.example', 'ingest', now)).toBe(false);
  expect(permitted([p, s], 'marketaux', 'publisher.example', 'ingest', now)).toBe(true);
  expect(permitted([p, s], 'marketaux', 'other.example', 'ingest', now)).toBe(false);
  expect(permitted([p, s], 'marketaux', 'publisher.example', 'publishDerived', now)).toBe(false);
  for (const replacement of [
    { status: 'revoked' as const },
    { expiresAt: now },
    { reviewedAt: now + 1 },
  ]) {
    expect(
      permitted(
        [p, s, { ...s, version: 2, ...replacement }],
        'marketaux',
        'publisher.example',
        'ingest',
        now,
      ),
    ).toBe(false);
  }
});
it('requires evidence, deadlines, and explicit retention limits', () => {
  for (const change of [
    { evidence: '' },
    { retentionMs: null },
    { expiresAt: now - 1000 },
    { publisherDomain: null },
  ])
    expect(() => policySchema.parse({ ...policy('publisher'), ...change })).toThrow();
});
