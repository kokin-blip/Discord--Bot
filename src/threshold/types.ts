import type { Direction, Instrument, Provenance } from '../domain.js';

export interface ThresholdConfig {
  enabled: boolean;
  ideas: boolean;
  contracts: boolean;
  hours: number;
  progressAtr: number;
  contractLossPercent: number;
  ideaLossR: number;
}
export const thresholdDefaults: ThresholdConfig = {
  enabled: false,
  ideas: false,
  contracts: false,
  hours: 4,
  progressAtr: 0.25,
  contractLossPercent: 5,
  ideaLossR: 0.05,
};
export interface OptionQuote {
  contract: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  asOf: number;
  feed: 'indicative';
}
export interface ThresholdObservation {
  evaluatedAt: number;
  marketTime: number;
  close: number;
  elapsedHours: number;
  eligible: boolean;
  reason: string;
  returnPercent?: number;
  rMultiple?: number;
  estimatedNet?: number;
  peakPercent?: number;
  contractionRatio?: number;
  quote?: OptionQuote;
  provenance: Provenance;
}
export interface ThresholdMonitor {
  id: string;
  mode: 'idea' | 'contract';
  owner?: string;
  ideaId?: string;
  instrument: Instrument;
  direction: Direction;
  status: 'active' | 'suspended' | 'stopped' | 'expired';
  contract?: string;
  expiry?: string;
  entry: number;
  quantity: number;
  fees?: number;
  stop?: number;
  risk?: number;
  createdAt: number;
  startedAt: number;
  lastEvaluated: number;
  lastBar: number;
  checkpoint: number;
  frozenAtr: number;
  progressAt: number;
  revision: string;
  rules: ThresholdConfig;
  needsReset: boolean;
  episode: number;
  allowance: number;
  deliveredAllowance: number;
  attempt: number;
  snoozedAt?: number;
  pendingId?: string;
  peakPercent?: number;
  observation?: ThresholdObservation;
}
export interface ThresholdAlert {
  monitorId: string;
  episode: number;
  allowance: number;
  revision: string;
  expiresAt: number;
  monitor: ThresholdMonitor;
  observation: ThresholdObservation;
}
export interface ThresholdReview {
  eventId: string;
  monitorId: string;
  alert: ThresholdAlert;
  deliveredAt: number;
  oneHour?: { at: number; returnPercent?: number; reason: string };
  fourHours?: { at: number; returnPercent?: number; reason: string };
}
