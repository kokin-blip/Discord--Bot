export type Direction = 'bullish' | 'bearish';
export type Market = 'equity' | 'crypto';
export type Interval = '1d' | '15m';
export interface Instrument {
  id: string;
  symbol: string;
  market: Market;
  venue: string;
  sector?: string;
}
export interface Bar {
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface Session {
  date: string;
  open: number;
  close: number;
}
export interface Provenance {
  provider: string;
  feed: string;
  delayMinutes: number;
  asOf: number;
}
export interface Dataset {
  instrument: Instrument;
  daily: Bar[];
  weekly: Bar[];
  intraday: Bar[];
  benchmark: Bar[];
  sessions: Session[];
  provenance: Provenance;
}
export type State =
  | 'watching'
  | 'setup_ready'
  | 'entry_triggered'
  | 'target_1'
  | 'target_2'
  | 'final_target'
  | 'invalidated'
  | 'expired'
  | 'time_exit';
export const terminalStates = new Set<State>([
  'final_target',
  'invalidated',
  'expired',
  'time_exit',
]);
export interface Candidate {
  id: string;
  instrument: Instrument;
  direction: Direction;
  strategyVersion: string;
  breakout: Bar;
  level: number;
  baseHigh: number;
  baseLow: number;
  atr: number;
  relativeStrength: number;
  relativeVolume: number;
  provisionalRR: number;
  retest?: Bar;
  entry?: number;
  target?: number;
  targets?: number[];
  confirmedAt?: number;
  reasons: string[];
}
export interface SignalEvent {
  debug?: boolean;
  performance?: {
    referencePrice: number;
    changePercent: number;
    rMultiple: number;
    reachedTargets: number[];
    basis: 'completed_close';
    ambiguous: boolean;
  };
  kind?:
    | 'lifecycle'
    | 'setup_snapshot'
    | 'watch_tracker'
    | 'learning_review'
    | 'learning_report'
    | 'announcement';
  announcement?: { title: string; body: string };
  learning?: LearningFeatures;
  learningText?: string;
  sourceEventId?: string;
  tracker?: TrackerDetails;
  setupContext?: { entryBand: [number, number]; remainingSessions: number; totalSessions: number };
  id: string;
  ideaId: string;
  instrument: Instrument;
  direction: Direction;
  state: State;
  marketTime: number;
  recordedAt: number;
  strategyVersion: string;
  reasons: string[];
  candidate: Candidate;
  provenance: Provenance;
  observations?: string[];
  recovery?: boolean;
}
export interface Idea {
  candidate: Candidate;
  state: State;
  lastBar: number;
  milestones: number[];
  createdAt: number;
}
export interface OptionsContext {
  contract: string;
  expiry: string;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  asOf?: number;
}
export interface MarketDataProvider {
  discover(now: number): Promise<Instrument[]>;
  bars(
    instruments: Instrument[],
    interval: Interval,
    start: number,
    now: number,
  ): Promise<Map<string, Bar[]>>;
  calendar(start: number, end: number): Promise<Session[]>;
  options?(instrument: Instrument): Promise<OptionsContext[]>;
}
export interface Publisher {
  deliver(event: SignalEvent, destination: string): Promise<void>;
}
export const equity = (symbol: string): Instrument => ({
  id: `alpaca:us_equity:${symbol}`,
  symbol,
  market: 'equity',
  venue: 'US consolidated',
});
export const crypto = (symbol: string): Instrument => ({
  id: `coinbase:spot:${symbol}`,
  symbol,
  market: 'crypto',
  venue: 'Coinbase',
});
export const benchmarkFor = (i: Instrument): Instrument =>
  i.market === 'crypto' ? crypto('BTC-USD') : equity(i.symbol === 'SPY' ? 'QQQ' : 'SPY');

export type TrackerDetails =
  | {
      type: 'range';
      timeframe: Interval;
      candleDirection: 'upward' | 'downward' | 'neutral';
      range: number;
      baseline: number;
      relativeRange: number;
      multiplier: number;
      baselineDays: number;
      bodyPercent: number;
      closeLocationPercent: number;
      close: number;
      priceChange: number;
      priceChangePercent: number;
      volume?: number;
      volumeBaseline?: number;
      relativeVolume?: number;
      combinedVolume?: boolean;
      volumeMultiplier?: number;
    }
  | {
      type: 'volume';
      pressure: 'buying' | 'selling' | 'neutral';
      pressureBasis: 'candle_direction';
      timeframe: Interval;
      volume: number;
      baseline: number;
      relativeVolume: number;
      close: number;
      priceChange: number;
      priceChangePercent: number;
      baselineDays: number;
      multiplier: number;
    }
  | {
      type: 'reversal';
      timeframe: Interval;
      phase: 'warning' | 'confirmed' | 'cancelled' | 'expired';
      warningId: string;
      warningTime: number;
      warningClose?: number;
      directionalChangePercent?: number;
      frozenHigh: number;
      frozenLow: number;
      cancellationLevel: number;
      elapsed: number;
      confirmationBars: number;
      close: number;
    };

export interface LearningFeatures {
  at: number;
  close?: number;
  benchmarkTrend: 'up' | 'down' | 'flat' | 'unknown';
  benchmarkAgreement: boolean;
  dailyRelativeVolume?: number;
  intradayRelativeVolume?: number;
  pressure?: 'buying' | 'selling' | 'neutral';
  pressureBasis?: 'candle_direction';
  frozenHigh?: number;
  frozenLow?: number;
  cancellationLevel?: number;
  breakoutRelativeVolume?: number;
  breakoutThreshold?: number;
  relativeStrength?: number;
  atr?: number;
  level?: number;
  entry?: number;
  targets?: number[];
  rewardRisk?: number;
  entryGeometry?: 'provisional' | 'confirmed';
}
