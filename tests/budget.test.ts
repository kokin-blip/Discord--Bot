import { it, expect } from 'vitest';
import { Store } from '../src/storage.js';
import { CloudBudget } from '../src/worker/budget.js';
import type { CloudSql } from '../src/worker/sql.js';
import { authorized } from '../src/discord/commands.js';
it('reserves browser time, limits launches, and enforces image size', () => {
  const s = new Store(':memory:');
  try {
    const counters = { reads: 0, writes: 0 } as CloudSql,
      b = new CloudBudget(s, counters),
      now = Date.parse('2026-01-01');
    expect(b.tick(now)).toBe(true);
    expect(b.reserveBrowser(now)).toBe(true);
    expect(b.reserveBrowser(now + 1000)).toBe(false);
    for (let n = 1; n < 6; n++) expect(b.reserveBrowser(now + n * 30_000)).toBe(true);
    expect(b.reserveBrowser(now + 6 * 30_000)).toBe(false);
    expect(b.reserveBrowser(now + 6 * 30_000, true)).toBe(true);
    expect(b.reserveBrowser(now + 7 * 30_000, true)).toBe(true);
    expect(b.reserveBrowser(now + 9 * 30_000, true)).toBe(false);
    expect(b.image(now, 250 * 1024 + 1)).toBe(false);
    for (let n = 0; n < 60; n++) expect(b.image(now, 100)).toBe(true);
    expect(b.image(now, 100)).toBe(false);
    expect(b.tick(now + 86_400_000)).toBe(true);
    expect(b.reserveBrowser(now + 86_400_000)).toBe(true);
  } finally {
    s.close();
  }
});
it('pauses before the account free row allowance and resets next UTC day', () => {
  const s = new Store(':memory:');
  try {
    const counters = { reads: 0, writes: 80_000 } as CloudSql,
      b = new CloudBudget(s, counters),
      now = Date.parse('2026-01-01');
    expect(b.tick(now)).toBe(false);
    expect(b.image(now, 1)).toBe(false);
    expect(b.reserveBrowser(now)).toBe(false);
    expect(b.tick(now + 86_400_000)).toBe(true);
  } finally {
    s.close();
  }
});
it('allows only administrators and the configured manager role to mutate settings', () => {
  expect(authorized(false, ['member'], 'manager')).toBe(false);
  expect(authorized(false, ['manager'], 'manager')).toBe(true);
  expect(authorized(true, [])).toBe(true);
});
