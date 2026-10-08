import type { Candidate, SignalEvent } from './domain.js';
import type { Store } from './sql-store.js';
import { stableId } from './core/strategy.js';
import { currentRelease, type BotRelease } from './releases.js';
// Direct animated asset from https://klipy.com/gifs/monkey-developer.
export const RELEASE_GIF_URL =
  'https://static2.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/01/5c/Jh3SMkvD.gif';
export function announcement(id: string, title: string, body: string, now: number): SignalEvent {
  const candidate: Candidate = {
    id,
    instrument: { id: 'system', symbol: 'BOT', market: 'equity', venue: 'Discord' },
    direction: 'bullish',
    strategyVersion: 'system',
    breakout: { start: now, end: now, open: 1, close: 1, high: 1, low: 1, volume: 0 },
    level: 0,
    baseHigh: 0,
    baseLow: 0,
    atr: 0,
    relativeStrength: 0,
    relativeVolume: 0,
    provisionalRR: 0,
    reasons: [body],
  };
  return {
    id,
    ideaId: id,
    kind: 'announcement',
    announcement: { title, body },
    instrument: candidate.instrument,
    direction: 'bullish',
    strategyVersion: 'system',
    state: 'watching',
    candidate,
    reasons: [body],
    marketTime: now,
    recordedAt: now,
    provenance: { provider: 'Bot', feed: 'Operational', delayMinutes: 0, asOf: now },
  };
}
export function queueRelease(
  store: Store,
  now: number,
  runtime: string,
  release: BotRelease = currentRelease,
): void {
  const key = `release_queued:${release.id}`;
  if (store.get(key, false)) return;
  const lines = (values: string[]) =>
    values.length ? values.map((v) => `• ${v}`).join('\n') : 'None.';
  const body = `**Changelog**\n${lines(release.changes)}\n\n**New commands**\n${lines(release.addedCommands)}\n\n**Changed commands**\n${lines(release.changedCommands)}\n\n**Removed commands**\n${lines(release.removedCommands)}\n\nRelease: ${release.id}\nRuntime: ${runtime}`;
  store.transaction(() => {
    const event = announcement(
      stableId('bot-release', release.id),
      `Bot updated · ${release.title}`,
      body,
      now,
    );
    event.announcement!.imageUrl = RELEASE_GIF_URL;
    store.enqueue(event, 'operations');
    store.set(key, true);
  });
}
type WatchRows = ReturnType<Store['watchRows']>;
function digest(rows: WatchRows): string {
  return stableId(
    rows
      .map((r) => [
        r.instrument.id,
        r.instrument.symbol,
        r.instrument.market,
        r.pinned,
        r.auto && !r.pinned,
        r.excluded,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
export function watchlistChanged(
  store: Store,
  before: WatchRows,
  reason: string,
  now = Date.now(),
): void {
  const after = store.watchRows();
  if (digest(before) === digest(after)) return;
  const revision = store.get('watch_revision', 0) + 1;
  const describe = (rows: WatchRows) =>
    rows
      .sort((a, b) => a.instrument.id.localeCompare(b.instrument.id))
      .map(
        (r) =>
          `${r.instrument.symbol} (${r.instrument.market === 'crypto' ? 'crypto' : 'stock / ETF'})`,
      )
      .join(' · ') || 'None';
  const selected = after.filter((r) => !r.excluded && (r.pinned || r.auto));
  const retained = store.monitored().filter((i) => !selected.some((r) => r.instrument.id === i.id));
  const previous = before.filter((r) => !r.excluded && (r.pinned || r.auto));
  const added = selected.filter((r) => !previous.some((p) => p.instrument.id === r.instrument.id));
  const removed = previous.filter(
    (r) => !selected.some((p) => p.instrument.id === r.instrument.id),
  );
  const body = `${reason}\n${added.length ? `Added: ${describe(added)}\n` : ''}${removed.length ? `Removed from selected watchlist: ${describe(removed)}\n` : ''}\n**Full current watchlist (${selected.length}/20)**\n**Manual pins (${selected.filter((r) => r.pinned).length}/10)**\n${describe(selected.filter((r) => r.pinned))}\n\n**Automatic selections (${selected.filter((r) => r.auto && !r.pinned).length}/10)**\n${describe(selected.filter((r) => r.auto && !r.pinned))}\n\n**Still monitored for active ideas**\n${
    retained
      .map((i) => `${i.symbol} (${i.market})`)
      .sort()
      .join(' · ') || 'None'
  }\n\n**Persistent exclusions**\n${describe(after.filter((r) => r.excluded))}\n\nRestored symbols are eligible for selection; restoration does not pin them. Strategy and data-quality checks still apply.`;
  store.enqueue(
    announcement(
      stableId('watchlist-revision', revision),
      `Watchlist updated · revision ${revision}`,
      body,
      now,
    ),
    'watchlist',
  );
  store.set('watch_revision', revision);
}
