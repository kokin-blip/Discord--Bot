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
    await expect(service.scan(Date.now())).rejects.toThrow('DATA_HTTP_401');
    expect(service.running).toBe(false);
    expect(s.get('last_scan', null)).toBeNull();
    expect(s.get('last_error', null)).toBe('DATA_HTTP_401:paper-api.alpaca.markets');
    expect(s.get('last_error_stage', null)).toBe('discovery');
    expect(s.get<{ stage: string }>('scan_progress', { stage: '' }).stage).toBe('failed');
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
