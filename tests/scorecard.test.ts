import { expect, it, vi } from 'vitest';
import { Collection, type ChatInputCommandInteraction } from 'discord.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import { Scorecard } from '../src/scorecard.js';
import { CommandHandler, commands } from '../src/discord/commands.js';
import { fixture, idea } from './fixtures.js';
import { advance } from '../src/core/strategy.js';
import { defaults } from '../src/config.js';
import type { SignalEvent } from '../src/domain.js';
const now = Date.parse('2026-10-27T12:00:00Z');
function event(id: string, state: SignalEvent['state'] = 'entry_triggered'): SignalEvent {
  const data = fixture();
  const e = structuredClone(
    advance(idea(data), data, defaults, data.provenance.asOf).events.at(-1)!,
  );
  Object.assign(e, {
    id,
    ideaId: id,
    kind: 'lifecycle',
    state,
    marketTime: now,
    recordedAt: now,
    recovery: false,
  });
  e.provenance = { ...e.provenance, provider: 'Alpaca', feed: 'SIP' };
  delete e.learning; // Legacy history does not require learning features.
  if (state === 'watching' || state === 'setup_ready') delete e.candidate.entry;
  return e;
}
function publish(store: Store, e: SignalEvent, receipt = true) {
  store.enqueue(e, 'equity_ideas');
  if (receipt) store.saveReceipt(e.id, 'former-test-channel', `message-${e.id}`);
  return e;
}
function end(
  store: Store,
  e: SignalEvent,
  state: SignalEvent['state'],
  change?: number,
  ambiguous = false,
) {
  const terminal = {
    ...e,
    id: `end-${e.id}`,
    state,
    marketTime: now + 900000,
    recordedAt: now + 900000,
    performance:
      change === undefined
        ? undefined
        : {
            referencePrice: 100,
            changePercent: change,
            rMultiple: change,
            reachedTargets: [],
            basis: 'completed_close' as const,
            ambiguous,
          },
  };
  store.recordEvent(terminal);
  return terminal;
}
it('scores all terminal rules while keeping uncertain results separate', () => {
  const store = new Store(':memory:');
  try {
    for (const [id, state, change, ambiguous] of [
      ['target', 'final_target', undefined, false],
      ['profit', 'time_exit', 2, false],
      ['flat', 'time_exit', 0, false],
      ['loss', 'time_exit', -1, false],
      ['invalid', 'invalidated', undefined, false],
      ['unknown', 'time_exit', undefined, false],
      ['non-finite', 'time_exit', NaN, false],
      ['expired', 'expired', undefined, false],
      ['ambiguous', 'invalidated', -1, true],
    ] as const)
      end(store, publish(store, event(id)), state, change, ambiguous);
    publish(store, event('pending'));
    new Scorecard(store).process(now);
    expect(new Scorecard(store).summary().groups.strategy_entry).toEqual({
      success: 3,
      failure: 2,
      pending: 1,
      unknown: 2,
      ambiguous: 1,
      unconfirmed: 1,
    });
  } finally {
    store.close();
  }
});
it('counts one idea per family despite multiple source cards, milestones, receipts and versions', () => {
  const store = new Store(':memory:');
  try {
    const setup = publish(store, event('idea', 'watching'));
    publish(store, { ...setup, id: 'ready', state: 'setup_ready' });
    const entry = publish(store, { ...event('idea'), id: 'entry', ideaId: setup.ideaId });
    store.saveReceipt(entry.id, 'thread', 'mirror');
    store.recordEvent({ ...entry, id: 'milestone-1', state: 'target_1' });
    store.recordEvent({ ...entry, id: 'milestone-2', state: 'target_2' });
    end(store, entry, 'final_target');
    end(
      store,
      publish(store, { ...event('different-version'), strategyVersion: 'br-v1-old' }),
      'invalidated',
    );
    new Scorecard(store).process(now);
    new Scorecard(store).process(now);
    expect(new Scorecard(store).summary().groups.strategy_entry).toMatchObject({
      success: 1,
      failure: 1,
    });
    expect(new Scorecard(store).summary().groups.strategy_setup).toMatchObject({
      success: 1,
      failure: 0,
      pending: 0,
    });
  } finally {
    store.close();
  }
});
it('scores reversal confirmation, cancellation and expiry independently', () => {
  const store = new Store(':memory:');
  try {
    for (const phase of ['confirmed', 'cancelled', 'expired'] as const) {
      const e = publish(store, {
        ...event(phase, 'watching'),
        kind: 'watch_tracker',
        strategyVersion: 'reversal-v1',
        tracker: {
          type: 'reversal',
          timeframe: '15m',
          phase: 'warning',
          warningId: phase,
          warningTime: now,
          frozenHigh: 101,
          frozenLow: 99,
          cancellationLevel: 99,
          elapsed: 0,
          confirmationBars: 5,
          close: 100,
        },
      });
      store.recordEvent({
        ...e,
        id: `end-${phase}`,
        tracker: { ...(e.tracker as Extract<SignalEvent['tracker'], { type: 'reversal' }>), phase },
      });
    }
    new Scorecard(store).process(now);
    expect(new Scorecard(store).summary().groups.reversal_warning).toMatchObject({
      success: 1,
      failure: 1,
      unconfirmed: 1,
      pending: 0,
    });
  } finally {
    store.close();
  }
});
it('excludes synthetic/debug, unpublished, recovery and informational events; late receipts work without reindexing', () => {
  const store = new Store(':memory:');
  try {
    const late = publish(store, event('late'), false);
    end(store, late, 'invalidated');
    for (const e of [
      { ...event('debug'), debug: true },
      { ...event('recovery'), recovery: true },
      {
        ...event('fixture'),
        provenance: { ...event('fixture').provenance, provider: 'Synthetic fixture' },
      },
      { ...event('news'), kind: 'news_report' as const },
      { ...event('threshold'), kind: 'threshold_alert' as const },
    ]) {
      end(store, publish(store, e), 'invalidated');
    }
    const unpublished = event('silent');
    store.recordEvent(unpublished);
    end(store, unpublished, 'invalidated');
    store.set('learning_paused', true);
    new Scorecard(store).process(now);
    expect(new Scorecard(store).summary().groups.strategy_entry.failure).toBe(0);
    store.saveReceipt(late.id, 'public', 'late-message');
    expect(new Scorecard(store).summary().groups.strategy_entry.failure).toBe(1);
  } finally {
    store.close();
  }
});
it('prefers recorded learning outcomes over daily records and reconstructed results', () => {
  const store = new Store(':memory:');
  try {
    const e = publish(store, event('historical'));
    const terminal = end(store, e, 'invalidated');
    const card = new Scorecard(store);
    card.process(now);
    store.db
      .prepare('INSERT INTO daily_outcomes(id,callout_id,day,body) VALUES(?,?,?,?)')
      .run(
        'daily',
        e.id,
        '2026-10-27',
        JSON.stringify({ family: 'strategy_entry', outcome: 'success' }),
      );
    card.process(now);
    expect(card.summary().groups.strategy_entry.success).toBe(1);
    store.db.prepare('INSERT INTO learning_journal VALUES(?,?,?,?,?,?)').run(
      'sample',
      'strategy_entry',
      e.strategyVersion,
      now,
      now,
      JSON.stringify({
        id: 'sample',
        family: 'strategy_entry',
        callout: e,
        terminal,
        outcome: 'ambiguous',
      }),
    );
    card.process(now);
    expect(card.summary().groups.strategy_entry).toMatchObject({
      success: 0,
      failure: 0,
      ambiguous: 1,
    });
  } finally {
    store.close();
  }
});
it('backfills in bounded transactions, respects budgets, and rolls back cursors on failure', () => {
  const store = new Store(':memory:');
  try {
    end(store, publish(store, event('bounded')), 'invalidated');
    const card = new Scorecard(store);
    store.set('budget_paused', true);
    card.process(now, 1);
    expect(store.get('scorecard_event_cursor', 0)).toBe(0);
    store.set('budget_paused', false);
    card.process(now, 1);
    expect(card.summary().coverage.caughtUp).toBe(false);
    expect(card.text()).toContain('totals are partial');
    store.db.exec(
      "CREATE TRIGGER fail_scorecard BEFORE INSERT ON scorecard_results BEGIN SELECT RAISE(ABORT,'failed'); END;",
    );
    expect(() => card.process(now, 1)).toThrow('failed');
    expect(store.get('scorecard_event_cursor', 0)).toBe(1);
    store.db.exec('DROP TRIGGER fail_scorecard');
    card.process(now, 1);
    expect(card.summary().groups.strategy_entry.failure).toBe(1);
    expect(card.summary().coverage.caughtUp).toBe(true);
  } finally {
    store.close();
  }
});
it('retains lifetime totals after reopening SQLite and deleting detailed examples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'callout-scorecard-'));
  let store = new Store(join(dir, 'history.db'));
  try {
    end(store, publish(store, event('persistent')), 'final_target');
    new Scorecard(store).process(now);
    store.db.exec('DELETE FROM learning_cases');
    store.close();
    store = new Store(join(dir, 'history.db'));
    expect(new Scorecard(store).summary().groups.strategy_entry.success).toBe(1);
    expect(new Scorecard(store).summary().coverage.since).toBe(now);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
it('registers scorecard for members and publicly responds even when scanning is paused', async () => {
  const store = new Store(':memory:');
  try {
    expect(
      commands.find((c) => c.toJSON().name === 'scorecard')!.toJSON().options ?? [],
    ).toHaveLength(0);
    const handler = new CommandHandler(
      store,
      {} as never,
      {} as never,
      { render: vi.fn() },
      { image: () => false, status: () => ({ paused: true }) },
      'guild',
    );
    const interaction = {
      guildId: 'guild',
      commandName: 'scorecard',
      user: { id: 'member' },
      guild: {
        members: {
          fetch: async () => ({
            permissions: { has: () => false },
            roles: { cache: new Collection() },
          }),
        },
      },
      options: { getSubcommand: () => null },
      deferReply: vi.fn(),
      editReply: vi.fn(),
    };
    await handler.handle(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('0 correct · 0 wrong') }),
    );
  } finally {
    store.close();
  }
});
it('reports terminal history without a source callout as a coverage gap without inventing a wrong call', () => {
  const store = new Store(':memory:');
  try {
    const terminal = {
      ...event('missing-origin'),
      id: 'only-terminal',
      state: 'invalidated' as const,
    };
    store.enqueue(terminal, 'updates');
    store.saveReceipt(terminal.id, 'public', 'terminal-message');
    const scorecard = new Scorecard(store);
    scorecard.process(now);
    expect(scorecard.summary().coverage.historicalGaps).toBe(1);
    expect(scorecard.summary().groups.strategy_entry.failure).toBe(0);
    expect(scorecard.text()).toContain('missing their originating callout: 1');
    expect(scorecard.text().length).toBeLessThanOrEqual(2000);
  } finally {
    store.close();
  }
});
