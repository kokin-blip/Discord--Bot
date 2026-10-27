import { words, phrasePositions, NEWS_ANALYTICS_VERSION } from './mapping.js';
export interface SentimentContribution {
  rule: string;
  weight: number;
  negated: boolean;
  tokenOffset: number;
}
export interface LocalSentiment {
  score: number | null;
  label: 'positive' | 'negative' | 'neutral' | 'unknown';
  confidence: number;
  contributions: SentimentContribution[];
  rulesVersion: string;
}
const lexicon = [
  ['beats estimates', 2],
  ['beat estimates', 2],
  ['raises guidance', 2],
  ['raised guidance', 2],
  ['record profit', 1.5],
  ['earnings growth', 1],
  ['upgrade', 1],
  ['misses estimates', -2],
  ['missed estimates', -2],
  ['cuts guidance', -2],
  ['cut guidance', -2],
  ['lowered guidance', -2],
  ['profit warning', -2],
  ['bankruptcy', -3],
  ['data breach', -2],
  ['ransomware', -2],
  ['downgrade', -1],
  ['unchanged guidance', 0],
] as const;
const negators = new Set(['no', 'not', 'never', 'without', 'denies', 'denied']);
/** Confidence measures rule coverage, not a calibrated probability or prediction. */
export function financialSentiment(text: string): LocalSentiment {
  const tokens = words(text),
    contributions: SentimentContribution[] = [],
    used = new Set<number>();
  for (const [rule, weight] of lexicon) {
    const phrase = words(rule);
    for (const offset of phrasePositions(tokens, phrase)) {
      if (contributions.length >= 20 || phrase.some((_, i) => used.has(offset + i))) continue;
      const negated = tokens
        .slice(Math.max(0, offset - 3), offset)
        .some((word) => negators.has(word));
      contributions.push({
        rule,
        weight: negated ? -weight : weight,
        negated,
        tokenOffset: offset,
      });
      phrase.forEach((_, i) => used.add(offset + i));
    }
  }
  if (!contributions.length)
    return {
      score: null,
      label: 'unknown',
      confidence: 0,
      contributions: [],
      rulesVersion: NEWS_ANALYTICS_VERSION,
    };
  const total = contributions.reduce((sum, c) => sum + c.weight, 0),
    magnitude = contributions.reduce((sum, c) => sum + Math.abs(c.weight), 0);
  const score = magnitude ? Math.round((total / magnitude) * 1000) / 1000 : 0;
  return {
    score,
    label: score > 0.1 ? 'positive' : score < -0.1 ? 'negative' : 'neutral',
    confidence:
      Math.round(Math.min(0.9, contributions.length / (contributions.length + 2)) * 1000) / 1000,
    contributions,
    rulesVersion: NEWS_ANALYTICS_VERSION,
  };
}
