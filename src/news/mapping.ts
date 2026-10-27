import { z } from 'zod';
import type { Instrument } from '../domain.js';
import type { NewsObservation } from './types.js';
import { timestampSchema } from './validation.js';
export const NEWS_ANALYTICS_VERSION = 'news-rules-v1';
export const aliasSchema = z
  .object({
    id: z.string().min(1).max(256),
    instrumentId: z.string().min(1).max(256),
    alias: z.string().trim().min(3).max(256),
    venue: z.string().trim().min(1).max(128).nullable(),
    reviewedAt: timestampSchema,
    expiresAt: timestampSchema,
    evidence: z.string().trim().min(1).max(2048),
    ambiguous: z.boolean().default(false),
    contextTerms: z.array(z.string().trim().min(2).max(64)).max(8).default([]),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.expiresAt <= a.reviewedAt || (a.ambiguous && !a.contextTerms.length))
      ctx.addIssue({ code: 'custom', message: 'NEWS_INVALID_ALIAS' });
  });
export type NewsAlias = z.infer<typeof aliasSchema>;
export interface InstrumentMapping {
  instrumentId: string;
  method: 'provider_entity' | 'reviewed_alias';
  confidence: number;
  aliasId: string | null;
  observationId: string | null;
  entityIndex: number | null;
}
export function words(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/n['’]t\b/g, ' not')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, 1024);
}
export function phrasePositions(tokens: string[], phrase: string[]): number[] {
  if (!phrase.length) return [];
  const found: number[] = [];
  for (let i = 0; i <= tokens.length - phrase.length; i++)
    if (phrase.every((word, j) => tokens[i + j] === word)) found.push(i);
  return found;
}
const venue = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
const sameName = (a: string, b: string) => words(a).join(' ') === words(b).join(' ');
export function mapInstruments(
  observations: { id: string; observation: NewsObservation }[],
  instruments: Instrument[],
  aliases: NewsAlias[],
  now: number,
): InstrumentMapping[] {
  const text = observations
      .map((o) => [o.observation.headline, o.observation.description].filter(Boolean).join(' '))
      .join(' '),
    tokens = words(text);
  const reviewed = aliases.filter((a) => a.reviewedAt <= now && a.expiresAt > now);
  const result: InstrumentMapping[] = [];
  for (const instrument of instruments.slice(0, 100)) {
    const own = reviewed.filter((a) => a.instrumentId === instrument.id);
    let match: InstrumentMapping | null = null;
    for (const item of observations) {
      if (item.observation.provider !== 'marketaux') continue;
      const index = item.observation.entities.findIndex((entity) => {
        if (entity.symbol !== instrument.symbol || !entity.venue) return false;
        const directVenue =
          venue(instrument.venue) === venue(entity.venue) &&
          venue(instrument.venue) !== 'USCONSOLIDATED';
        const reviewedVenue = own.some(
          (a) =>
            a.venue &&
            venue(a.venue) === venue(entity.venue!) &&
            entity.name &&
            sameName(a.alias, entity.name),
        );
        return directVenue || reviewedVenue;
      });
      if (index >= 0) {
        match = {
          instrumentId: instrument.id,
          method: 'provider_entity',
          confidence: 0.95,
          aliasId: null,
          observationId: item.id,
          entityIndex: index,
        };
        break;
      }
    }
    if (!match)
      for (const alias of own) {
        // A ticker is not an issuer name, including short crypto ticker aliases.
        if (
          sameName(alias.alias, instrument.symbol) ||
          sameName(alias.alias, instrument.symbol.split('-')[0]!)
        )
          continue;
        if (
          reviewed.some((a) => a.instrumentId !== instrument.id && sameName(a.alias, alias.alias))
        )
          continue;
        const name = words(alias.alias),
          positions = phrasePositions(tokens, name);
        const contextual = positions.some(
          (position) =>
            !alias.ambiguous ||
            alias.contextTerms.some(
              (term) =>
                phrasePositions(
                  tokens.slice(Math.max(0, position - 12), position + name.length + 12),
                  words(term),
                ).length,
            ),
        );
        if (contextual) {
          match = {
            instrumentId: instrument.id,
            method: 'reviewed_alias',
            confidence: alias.ambiguous ? 0.8 : 0.9,
            aliasId: alias.id,
            observationId: null,
            entityIndex: null,
          };
          break;
        }
      }
    if (match) result.push(match);
  }
  return result.sort((a, b) => a.instrumentId.localeCompare(b.instrumentId)).slice(0, 10);
}
