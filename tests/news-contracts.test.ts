import { expect, it } from 'vitest';
import { canonicalUrl, utcTimestamp } from '../src/news/normalize.js';
import { initialNewsConfig, newsConfigSchema } from '../src/news/config.js';
import { validateObservation, querySchema } from '../src/news/validation.js';
import { now, observation } from './news-fixtures.js';
it('normalizes exact identities without dropping content parameters or merging titles', () => {
  expect(canonicalUrl('https://PUBLISHER.example/story?id=1&utm_source=x&fbclid=y#top')).toBe(
    'https://publisher.example/story?id=1',
  );
  expect(canonicalUrl('http://publisher.example/story?id=1')).not.toBe(
    canonicalUrl('https://publisher.example/story?id=1'),
  );
  expect(canonicalUrl('https://publisher.example/story?id=2')).not.toBe(
    canonicalUrl('https://publisher.example/story?id=1'),
  );
  for (const url of [
    'file:///tmp/a',
    'https://secret@publisher.example/story',
    'http://localhost/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
  ])
    expect(() => canonicalUrl(url)).toThrow();
});
it('parses only explicit UTC/offset dates and rejects invalid calendar values', () => {
  expect(utcTimestamp('2026-10-09T12:00:00Z')).toBe(now);
  expect(utcTimestamp('2026-10-09T05:00:00-07:00')).toBe(now);
  expect(utcTimestamp('2026-10-09T12:00:00', 'marketaux')).toBe(now);
  expect(utcTimestamp('2026-10-09 12:00:00 +0000', 'currents')).toBe(now);
  expect(utcTimestamp('20261009T120000Z', 'gdelt')).toBe(now);
  for (const date of [
    '2026-10-09',
    '2026-10-09T12:00:00',
    '2026-02-30T12:00:00Z',
    '2026-10-09T25:00:00Z',
    '2026-10-09T12:00:00+25:00',
  ])
    expect(() => utcTimestamp(date)).toThrow();
});
it('validates provenance and rejects unsupported content/credential fields', () => {
  expect(validateObservation(observation()).publisherDomain).toBe('publisher.example');
  expect(() => validateObservation(observation({ provider: 'gdelt' }))).toThrow();
  expect(
    validateObservation(
      observation({
        provider: 'gdelt',
        publishedAt: null,
        firstSeenAt: now - 1000,
        timestampBasis: 'provider_first_seen',
        entities: [],
      }),
    ).publishedAt,
  ).toBeNull();
  for (const change of [
    { timestampBasis: 'unknown' },
    { apiToken: 'secret' },
    { fullText: 'text' },
    { ingestedAt: NaN },
  ])
    expect(() => validateObservation(observation(change))).toThrow();
});
it('defaults off, prevents increased quotas, and bounds sanitized queries', () => {
  expect(initialNewsConfig()).toMatchObject({
    enabled: false,
    digest: false,
    alerts: false,
    providers: { marketaux: false, currents: false, gdelt: false },
  });
  expect(() =>
    newsConfigSchema.parse({ dailyCaps: { marketaux: 61, currents: 100, gdelt: 30 } }),
  ).toThrow();
  const q = {
    id: 'q',
    provider: 'currents',
    symbols: [],
    terms: ['Test Company'],
    startAt: now - 1000,
    endAt: now,
    page: 1,
  };
  expect(querySchema.parse(q)).toEqual({ ...q, domains: [] });
  expect(() => querySchema.parse({ ...q, apiKey: 'secret' })).toThrow();
  expect(() => querySchema.parse({ ...q, startAt: now - 2 * 86400000 })).toThrow();
});
