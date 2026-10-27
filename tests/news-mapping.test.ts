import { expect, it } from 'vitest';
import { equity } from '../src/domain.js';
import { aliasSchema, mapInstruments } from '../src/news/mapping.js';
import { observationSchema } from '../src/news/validation.js';
import { now, observation } from './news-fixtures.js';
const instrument = equity('TEST');
const alias = aliasSchema.parse({
  id: 'issuer',
  instrumentId: instrument.id,
  alias: 'Test Company',
  venue: 'NASDAQ',
  reviewedAt: now - 1,
  expiresAt: now + 1000,
  evidence: 'Synthetic reviewed issuer',
});
const input = (overrides = {}) => [
  { id: 'o', observation: observationSchema.parse(observation(overrides)) },
];
it('requires venue verification for consolidated equities and rejects bare tickers', () => {
  expect(
    mapInstruments(
      input({ headline: 'TEST beats estimates', description: null }),
      [instrument],
      [],
      now,
    ),
  ).toEqual([]);
  expect(
    mapInstruments(
      input({ headline: 'TEST beats estimates', description: null }),
      [instrument],
      [alias],
      now,
    )[0],
  ).toMatchObject({ method: 'provider_entity', entityIndex: 0 });
  expect(
    mapInstruments(
      input({ entities: [], headline: 'TEST beats estimates', description: null }),
      [instrument],
      [{ ...alias, alias: 'TEST' }],
      now,
    ),
  ).toEqual([]);
  expect(
    mapInstruments(
      input({
        headline: 'Unrelated company',
        description: null,
        entities: [
          {
            symbol: 'TEST',
            name: 'Foreign Company',
            venue: 'LSE',
            matchScore: 1,
            sentimentScore: null,
          },
        ],
      }),
      [instrument],
      [alias],
      now,
    ),
  ).toEqual([]);
});
it('uses reviewed names with context and refuses expired or shared aliases', () => {
  const inputs = input({
    entities: [],
    headline: 'Test Company beats estimates',
    description: null,
  });
  expect(mapInstruments(inputs, [instrument], [alias], now)[0]).toMatchObject({
    method: 'reviewed_alias',
    aliasId: 'issuer',
  });
  expect(mapInstruments(inputs, [instrument], [{ ...alias, expiresAt: now }], now)).toEqual([]);
  expect(
    mapInstruments(
      inputs,
      [instrument],
      [alias, { ...alias, id: 'other', instrumentId: equity('OTHER').id }],
      now,
    ),
  ).toEqual([]);
  const ambiguous = { ...alias, ambiguous: true, contextTerms: ['semiconductor'] };
  expect(mapInstruments(inputs, [instrument], [ambiguous], now)).toEqual([]);
  expect(
    mapInstruments(
      input({ entities: [], headline: 'Test Company semiconductor earnings', description: null }),
      [instrument],
      [ambiguous],
      now,
    )[0]?.confidence,
  ).toBe(0.8);
  expect(() => aliasSchema.parse({ ...alias, ambiguous: true, contextTerms: [] })).toThrow();
});
it('accepts an explicit exchange entity match without inventing issuer aliases', () => {
  expect(
    mapInstruments(
      input({ headline: null, description: null }),
      [{ ...instrument, venue: 'NASDAQ' }],
      [],
      now,
    )[0]?.method,
  ).toBe('provider_entity');
  expect(
    mapInstruments(
      input({ provider: 'currents', headline: null, description: null }),
      [{ ...instrument, venue: 'NASDAQ' }],
      [],
      now,
    ),
  ).toEqual([]);
});
