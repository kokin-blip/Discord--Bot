import { z } from 'zod';
export const strategySchema = z
  .object({
    weeklyPeriod: z.number().int().min(10).max(52).default(30),
    slopeWeeks: z.number().int().min(1).max(8).default(4),
    flatSlope: z.number().min(0).max(0.03).default(0.005),
    baseWeeks: z.number().int().min(4).max(16).default(8),
    maxBaseWidth: z.number().min(0.03).max(0.5).default(0.2),
    atrPeriod: z.number().int().min(5).max(30).default(14),
    volumePeriod: z.number().int().min(10).max(50).default(20),
    breakoutBuffer: z.number().min(0).max(1).default(0.1),
    breakoutVolume: z.number().min(1).max(5).default(1.5),
    retestBars: z.number().int().min(1).max(20).default(10),
    retestTolerance: z.number().min(0.1).max(2).default(0.5),
    retestVolume: z.number().min(0.1).max(1).default(0.8),
    rsPeriod: z.number().int().min(10).max(50).default(20),
    marketPeriod: z.number().int().min(20).max(100).default(50),
    confirmationSessions: z.number().int().min(1).max(5).default(2),
    minChase: z.number().min(0.01).max(0.5).default(0.1),
    maxChase: z.number().min(0.5).max(2).default(1),
    minimumRR: z.number().min(2).max(10).default(3),
    pivotLookback: z.number().int().min(100).max(500).default(252),
    exitSessions: z.number().int().min(2).max(30).default(10),
  })
  .strict()
  .refine((c) => c.minChase < c.maxChase, 'minChase must be less than maxChase');
export type StrategyConfig = z.infer<typeof strategySchema>;
export const defaults = strategySchema.parse({});
export const routes = [
  'equity_ideas',
  'crypto_ideas',
  'updates',
  'watchlist',
  'summaries',
  'operations',
] as const;
export type Route = (typeof routes)[number];
export interface Settings {
  paused: boolean;
  managerRole?: string;
  channels: Partial<Record<Route, string>>;
  alerts: boolean;
  options: boolean;
  rangeExpansion: boolean;
  rangeMultiplier: number;
  volumeSpikes: boolean;
  reversals: boolean;
  volumeMultiplier: number;
}
export const initialSettings: Settings = {
  paused: false,
  channels: {},
  alerts: true,
  options: true,
  rangeExpansion: true,
  rangeMultiplier: 3,
  volumeSpikes: true,
  reversals: true,
  volumeMultiplier: 2,
};
