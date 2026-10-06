import { it, expect } from 'vitest';
import { Store } from '../src/storage.js';
import { SignalService } from '../src/service.js';
import type { DataService } from '../src/data.js';
import { fixture, idea } from './fixtures.js';
import { equity } from '../src/domain.js';
import { utcDate } from '../src/core/time.js';
it('records the failing scan stage and provider code and clears the running flag', async () => {
  const s = new Store(':memory:');
  try {
    const data = {
      universe: async () => {
        throw new Error('DATA_HTTP_401:paper-api.alpaca.markets');
      },
    } as unknown as DataService;
    const service = new SignalService(s, data);
    s.set('scan_announcement', { id: 'failed-request', requestedAt: Date.now() });
    await expect(service.scan(Date.now())).rejects.toThrow('DATA_HTTP_401');
    expect(service.running).toBe(false);
    expect(s.get('last_scan', null)).toBeNull();
    expect(s.get('last_error', null)).toBe('DATA_HTTP_401:paper-api.alpaca.markets');
    expect(s.get('last_error_stage', null)).toBe('discovery');
    expect(s.get<{ stage: string }>('scan_progress', { stage: '' }).stage).toBe('failed');
    expect(s.get('scan_announcement', null)).not.toBeNull();
    expect(s.pending(Date.now())).toHaveLength(0);
  } finally {
    s.close();
  }
});
it('announces a requested scan once after all discovery batches finish, including an empty universe', async () => {
  const s = new Store(':memory:');
  try {
    let batch = 0;
    const now = Date.now();
    const data = {
      universe: async () => {
        s.set('discovery_progress', ++batch === 1 ? { market: 'crypto', offset: 10 } : null);
        return [];
      },
      refreshDaily: async () => {},
      refreshIntraday: async () => {},
    } as unknown as DataService;
    const service = new SignalService(s, data);
    s.set('scan_announcement', { id: 'request-one', requestedAt: now });
    const completions = () =>
      s.pending(now + 300_000).filter((p) => p.event.reasons[0]?.startsWith('Scan complete:'));
    await service.scan(now, true);
    expect(completions()).toHaveLength(0);
    expect(s.get<{ stage: string }>('scan_progress', { stage: '' }).stage).toBe(
      'discovery_pending',
    );
    expect(s.get('scan_announcement', null)).not.toBeNull();
    await service.scan(now + 60_000);
    expect(completions()).toHaveLength(1);
    expect(s.get<{ stage: string }>('scan_progress', { stage: '' }).stage).toBe('complete');
    expect(completions()[0]?.route).toBe('summaries');
    expect(completions()[0]?.event.reasons[0]).toContain('0 symbols monitored');
    expect(s.get('scan_announcement', null)).toBeNull();
    expect(s.get('discovery_day', '')).toBe(utcDate(now));
    await service.scan(now + 120_000);
    expect(completions()).toHaveLength(1);
    s.set('scan_announcement', { id: 'request-two', requestedAt: now + 180_000 });
    await service.scan(now + 180_000, true);
    expect(completions()).toHaveLength(2);
  } finally {
    s.close();
  }
});
it('publishes a fresh delayed equity confirmation during normal polling', async () => {
  const s = new Store(':memory:');
  try {
    const d = fixture();
    d.instrument = equity('TEST');
    d.provenance.delayMinutes = 16;
    d.sessions = [
      {
        date: utcDate(d.intraday[0]!.start),
        open: d.intraday[0]!.start,
        close: d.intraday[0]!.end,
      },
    ];
    const old = idea(d);
    s.pin(d.instrument);
    s.saveIdea(old, [], false);
    const now = d.provenance.asOf + 16 * 60_000;
    s.set('last_scan', now - 5 * 60_000);
    s.set('discovery_day', utcDate(now));
    const data = {
      refreshDaily: async () => {},
      refreshIntraday: async () => {},
      dataset: async () => d,
      universe: async () => [],
    } as unknown as DataService;
    await new SignalService(s, data).scan(now);
    const event = s.pending(now).find((p) => p.event.state === 'entry_triggered')?.event;
    expect(event).toBeDefined();
    expect(event?.recovery).toBe(false);
  } finally {
    s.close();
  }
});
it('journals recovery entries without publishing them as fresh signals', async () => {
  const s = new Store(':memory:');
  try {
    const d = fixture();
    d.instrument = equity('TEST');
    d.sessions = [
      {
        date: utcDate(d.intraday[0]!.start),
        open: d.intraday[0]!.start,
        close: d.intraday[0]!.end,
      },
    ];
    s.pin(d.instrument);
    s.saveIdea(idea(d), [], false);
    const now = d.provenance.asOf + 16 * 60_000;
    s.set('discovery_day', utcDate(now));
    const data = {
      refreshDaily: async () => {},
      refreshIntraday: async () => {},
      dataset: async () => d,
      universe: async () => [],
    } as unknown as DataService;
    await new SignalService(s, data).scan(now);
    expect(s.journal().some((e) => e.state === 'entry_triggered' && e.recovery)).toBe(true);
    expect(s.pending(now).some((p) => p.event.state === 'entry_triggered')).toBe(false);
    expect(s.pending(now).filter((p) => p.route === 'summaries')).toHaveLength(1);
  } finally {
    s.close();
  }
});
it.each(['bullish', 'bearish'] as const)(
  'publishes one current %s pending setup snapshot across repeated polling and recovery',
  async (direction) => {
    const s = new Store(':memory:');
    try {
      const d = fixture(direction);
      d.instrument = equity('TEST');
      d.intraday[0]!.close = direction === 'bullish' ? 111.5 : 88.5;
      d.sessions = [
        {
          date: utcDate(d.intraday[0]!.start),
          open: d.intraday[0]!.start,
          close: d.intraday[0]!.end,
        },
      ];
      s.pin(d.instrument);
      const pending = idea(d);
      s.saveIdea(pending, [], false);
      const now = d.provenance.asOf + 16 * 60_000;
      s.set('discovery_day', utcDate(now));
      const data = {
        refreshDaily: async () => {},
        refreshIntraday: async () => {},
        dataset: async () => d,
        universe: async () => [],
      } as unknown as DataService;
      const service = new SignalService(s, data);
      await service.scan(now);
      const snapshots = () =>
        s.journal(pending.candidate.id).filter((e) => e.kind === 'setup_snapshot');
      expect(snapshots()).toHaveLength(1);
      expect(snapshots()[0]?.state).toBe('setup_ready');
      expect(snapshots()[0]?.candidate.entry).toBeUndefined();
      expect(snapshots()[0]?.setupContext?.remainingSessions).toBe(1);
      expect(s.pending(now).filter((p) => p.event.kind === 'setup_snapshot')).toHaveLength(1);
      expect(s.idea(pending.candidate.id)?.state).toBe('setup_ready');
      s.set('last_scan', 0); // simulate recovery after restarting
      await new SignalService(s, data).scan(now);
      expect(snapshots()).toHaveLength(1);
    } finally {
      s.close();
    }
  },
);
it('does not snapshot invalidated setups or instruments failing data quality', async () => {
  for (const mode of ['invalidated', 'quality'] as const) {
    const s = new Store(':memory:');
    try {
      const d = fixture();
      d.instrument = equity('TEST');
      d.intraday[0]!.close = mode === 'invalidated' ? 109 : 111.5;
      d.sessions = [
        {
          date: utcDate(d.intraday[0]!.start),
          open: d.intraday[0]!.start,
          close: d.intraday[0]!.end,
        },
      ];
      s.pin(d.instrument);
      s.saveIdea(idea(d), [], false);
      const now = d.provenance.asOf + 16 * 60_000;
      s.set('discovery_day', utcDate(now));
      const data = {
        refreshDaily: async () => {},
        refreshIntraday: async () => {},
        dataset: async () => {
          if (mode === 'quality') throw new Error('MISSING_DAILY_CANDLES');
          return d;
        },
        universe: async () => [],
      } as unknown as DataService;
      await new SignalService(s, data).scan(now);
      expect(s.journal().some((e) => e.kind === 'setup_snapshot')).toBe(false);
      expect(s.pending(now).some((p) => p.event.state === 'entry_triggered')).toBe(false);
    } finally {
      s.close();
    }
  }
});
