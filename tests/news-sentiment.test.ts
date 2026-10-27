import { expect, it } from 'vitest';
import { financialSentiment } from '../src/news/sentiment.js';
import { NEWS_ANALYTICS_VERSION } from '../src/news/mapping.js';
it('explains weighted financial phrases and preserves unknown versus neutral', () => {
  expect(financialSentiment('Company beats estimates and raises guidance')).toMatchObject({
    score: 1,
    label: 'positive',
    rulesVersion: NEWS_ANALYTICS_VERSION,
  });
  expect(financialSentiment('Company cuts guidance')).toMatchObject({
    score: -1,
    label: 'negative',
  });
  expect(financialSentiment('Company opens an office')).toMatchObject({
    score: null,
    label: 'unknown',
    confidence: 0,
  });
  expect(financialSentiment('Company unchanged guidance')).toMatchObject({
    score: 0,
    label: 'neutral',
  });
  expect(financialSentiment('Company beats estimates but cuts guidance')).toMatchObject({
    score: 0,
    label: 'neutral',
  });
});
it('records negation and produces deterministic bounded contributions', () => {
  const result = financialSentiment('Company did not beat estimates');
  expect(result).toMatchObject({
    score: -1,
    contributions: [{ rule: 'beat estimates', weight: -2, negated: true, tokenOffset: 3 }],
  });
  expect(financialSentiment('Company denies data breach').score).toBe(1);
  const text = 'beats estimates '.repeat(100);
  expect(financialSentiment(text).contributions).toHaveLength(20);
  expect(financialSentiment(text)).toEqual(financialSentiment(text));
});
