import { NewsMonitor } from '../src/news/monitor.js';
import { Store } from '../src/storage.js';
import { equity } from '../src/domain.js';
import { NewsStore } from '../src/news/store.js';
import { NewsIntelligence } from '../src/news/intelligence.js';
import { NewsPublication } from '../src/news/publication.js';
import { observation, policy, now } from './news-fixtures.js';
export function newsFixture(time = now, headlineRights = false) {
  const store = new Store(':memory:'),
    news = new NewsStore(store, time),
    engine = new NewsIntelligence(news),
    instrument = equity('TEST');
  store.pin(instrument);
  store.db.exec("UPDATE outbox SET status='delivered'");
  news.saveConfig({
    enabled: true,
    digest: true,
    alerts: true,
    providers: { marketaux: true, currents: true, gdelt: true },
  });
  const permissions = {
    ...policy('provider').permissions,
    retainHeadline: true,
    retainDescription: true,
    analyze: true,
    retainDerived: true,
    publishMetadata: true,
    publishDerived: true,
    publishHeadline: headlineRights,
  };
  for (const provider of ['marketaux', 'currents', 'gdelt'] as const)
    for (const scope of ['provider', 'publisher'] as const)
      news.savePolicy({
        ...policy(scope, provider),
        reviewedAt: time - 1000,
        expiresAt: time + 10 * 86400000,
        retentionMs: 7 * 86400000,
        permissions,
      });
  news.saveAlias({
    id: 'issuer',
    instrumentId: instrument.id,
    alias: 'Test Company',
    venue: 'NASDAQ',
    reviewedAt: time - 1000,
    expiresAt: time + 10 * 86400000,
    evidence: 'Synthetic issuer review',
  });
  news.savePublisherGroup({
    domain: 'publisher.example',
    groupId: 'issuer',
    reviewedAt: time - 1000,
    expiresAt: time + 10 * 86400000,
    evidence: 'Synthetic issuer primary-source review',
    firstParty: true,
    firstPartyTopics: [`instrument:${instrument.id}`],
  });
  const settings = store.settings();
  settings.channels.updates = 'public';
  settings.channels.summaries = 'public';
  store.set('settings', settings);
  const monitor = new NewsMonitor(news);
  store.set('news_runtime_healthy_at', time);
  store.set('news_production_approved', {
    signature: monitor.signature(time),
    sha256: 'a'.repeat(64),
    at: time,
  });
  const publication = new NewsPublication(news);
  const add = (overrides: Record<string, unknown> = {}, at = time) => {
    const saved = news.saveObservation(
      observation({
        headline: 'Test Company filed for bankruptcy',
        description: null,
        ingestedAt: at,
        publishedAt: at - 1000,
        ...overrides,
      }),
      at,
    );
    engine.process(at);
    return saved;
  };
  const pending = () =>
    store.pending(time + 10 * 86400000).filter((p) => p.event.kind === 'news_report');
  return { store, news, engine, instrument, publication, add, pending, time, permissions };
}
