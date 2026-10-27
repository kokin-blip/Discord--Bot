import { vi } from 'vitest';
import { routes, type Route } from '../src/config.js';
import type { SignalCoordinator } from '../src/worker/coordinator.js';
import { NewsMonitor } from '../src/news/monitor.js';
import type { NewsStore } from '../src/news/store.js';

/** Isolate publication tests from provisioning, which has its own REST integration tests. */
export function configuredChannels(
  coordinator: SignalCoordinator,
  channels?: Partial<Record<Route, string>>,
) {
  const selected = channels ?? Object.fromEntries(routes.map((r) => [r, 'public']));
  coordinator.store.set('settings', { ...coordinator.store.settings(), channels: selected });
  coordinator.store.set('managed_channels', {
    migrated: true,
    channels: selected,
    previousChannels: {},
  });
  const status = { state: 'ready' as const, channels: selected, error: null };
  coordinator.store.set('channel_setup_status', status);
  Object.assign(coordinator, { channelSetup: { ensure: vi.fn(async () => status) } });
}
/** A publication fixture's explicit human approval, independent of market rollout flags. */
export function reviewedNews(news: NewsStore, at: number) {
  news.store.set('news_runtime_healthy_at', at);
  news.store.set('news_production_approved', {
    signature: new NewsMonitor(news).signature(at),
    sha256: 'a'.repeat(64),
    at,
  });
}
