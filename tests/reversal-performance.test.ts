import { expect, it } from 'vitest';
import { fixture } from './fixtures.js';
import { reversalDetails, advanceReversal, type PendingReversal } from '../src/core/trackers.js';
import { trackerEvent } from '../src/watch-trackers.js';
import { trackerCard } from '../src/discord/cards.js';

it.each(['bullish', 'bearish'] as const)(
  'shows hypothetical %s movement on confirmed, cancelled and expired follow-ups',
  (direction) => {
    const data = fixture(),
      warning = { ...data.intraday[0]!, close: 100, high: 101, low: 99 };
    const pending: PendingReversal = {
      id: 'warning',
      direction,
      high: 105,
      low: 95,
      warning,
      elapsed: 1,
      announced: true,
    };
    for (const phase of ['confirmed', 'cancelled', 'expired'] as const) {
      const close = direction === 'bullish' ? 110 : 90;
      const details = reversalDetails(pending, '15m', phase, close);
      expect(details).toMatchObject({ warningClose: 100, directionalChangePercent: 10 });
      const event = trackerEvent(
        data,
        { id: phase, direction, bar: { ...warning, close }, details },
        Date.now(),
      );
      const embed = trackerCard(event).toJSON();
      const field = embed.fields!.find((f) => f.name === 'Hypothetical move since warning')!;
      expect(field.value).toContain('+10.00%');
      expect(field.value).toContain(`${direction === 'bullish' ? 'long' : 'short'} direction`);
      expect(field.value).toContain('not fills or realized profit');
      expect(event.kind).toBe('watch_tracker');
      expect(event.candidate.entry).toBeUndefined();
    }
    const loss = reversalDetails(pending, '15m', 'cancelled', direction === 'bullish' ? 98 : 102);
    expect(loss).toMatchObject({ directionalChangePercent: -2 });
    const next = {
      ...warning,
      start: warning.end,
      end: warning.end + 900000,
      close: direction === 'bullish' ? 106 : 94,
    };
    expect(advanceReversal(pending, '15m', next).observation?.details).toMatchObject({
      phase: 'confirmed',
      warningClose: 100,
      directionalChangePercent: 6,
    });
  },
);
it('keeps old follow-ups compatible without inventing a warning reference price', () => {
  const data = fixture(),
    warning = data.intraday[0]!;
  const pending: PendingReversal = {
    id: 'old',
    direction: 'bullish',
    high: 120,
    low: 100,
    warning,
    elapsed: 1,
    announced: true,
  };
  const details = reversalDetails(pending, '15m', 'confirmed', 121);
  if (details.type !== 'reversal') throw new Error('Wrong type');
  delete details.warningClose;
  delete details.directionalChangePercent;
  const event = trackerEvent(
    data,
    { id: 'old-confirm', direction: 'bullish', bar: warning, details },
    Date.now(),
  );
  expect(
    trackerCard(event)
      .toJSON()
      .fields!.some((f) => f.name === 'Hypothetical move since warning'),
  ).toBe(false);
});
