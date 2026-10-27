import { reviewedNews } from './live-fixtures.js';
import { NewsMonitor } from '../src/news/monitor.js';
import { expect, it, vi } from 'vitest';
import { NewsPublication } from '../src/news/publication.js';
import { newsEmbed } from '../src/discord/news.js';
import { newsFixture } from './news-publication-fixtures.js';
import { now, policy } from './news-fixtures.js';
it('enqueues a reference-only initial alert once and routes it to the public updates channel', () => {
  const f = newsFixture();
  try {
    f.add();
    f.publication.queue(now);
    f.publication.queue(now);
    const [pending] = f.pending();
    expect(f.pending()).toHaveLength(1);
    expect(pending!.route).toBe('updates');
    expect(f.publication.destination(pending!.event)).toBe('public');
    expect(JSON.stringify(pending!.event)).not.toContain('bankruptcy');
    expect(pending!.event.announcement).toBeUndefined();
    const report = f.publication.report(pending!.event, now)!;
    expect(report.items[0]).toMatchObject({
      headline: null,
      eventClass: 'bankruptcy',
      freshness: 'fresh',
    });
    const embed = newsEmbed(report, pending!.event.id)!.toJSON();
    expect(embed.description).toContain('Synthetic publisher');
    expect(embed.description).toContain('https://publisher.example/');
    expect(embed.description).not.toContain('filed for bankruptcy');
    expect(embed.image).toBeUndefined();
    expect(new NewsPublication(f.news, 'test', 'public').report(pending!.event, now)).toEqual(
      report,
    );
  } finally {
    f.store.close();
  }
});
it('requires independent publisher evidence or a first-party review for the exact topic', () => {
  const f = newsFixture();
  try {
    f.news.savePublisherGroup({
      domain: 'publisher.example',
      groupId: 'publisher-a',
      reviewedAt: now - 1,
      expiresAt: now + 10000,
      evidence: 'Synthetic source review',
      firstParty: true,
      firstPartyTopics: ['macro:monetary_policy'],
    });
    f.add();
    f.publication.queue(now);
    expect(f.pending()).toHaveLength(0);
    const p = policy('publisher', 'currents', {
      id: 'second-publisher',
      publisherDomain: 'second.example',
      permissions: f.permissions,
    });
    f.news.savePolicy(p);
    f.news.savePublisherGroup({
      domain: 'second.example',
      groupId: 'publisher-b',
      reviewedAt: now - 1,
      expiresAt: now + 10000,
      evidence: 'Synthetic second ownership review',
    });
    f.add({
      provider: 'currents',
      providerArticleId: 'second',
      url: 'https://second.example/story',
      headline: 'Test Company filed for bankruptcy today',
    });
    reviewedNews(f.news, now);
    f.publication.queue(now);
    expect(f.pending()).toHaveLength(1);
    expect(f.publication.report(f.pending()[0]!.event, now)?.items).toHaveLength(2);
  } finally {
    f.store.close();
  }
});
it.each(['rumor', 'stale', 'unknown', 'future', 'routine'] as const)(
  'does not alert on %s evidence',
  (reason) => {
    const f = newsFixture();
    try {
      f.add(
        reason === 'rumor'
          ? { headline: 'Rumor Test Company filed for bankruptcy' }
          : reason === 'stale'
            ? { publishedAt: now - 7200001 }
            : reason === 'unknown'
              ? { publishedAt: null, timestampBasis: 'unknown' }
              : reason === 'future'
                ? { publishedAt: now + 1 }
                : { headline: 'Test Company earnings beats estimates' },
      );
      f.publication.queue(now);
      expect(f.pending()).toHaveLength(0);
    } finally {
      f.store.close();
    }
  },
);
it('requires publication rights beyond research and separately gates headlines', () => {
  const f = newsFixture(now, true);
  try {
    f.add();
    expect(f.publication.latest(now)[0]?.headline).toContain('filed for bankruptcy');
    f.news.savePolicy(
      policy('publisher', 'marketaux', {
        version: 2,
        permissions: { ...f.permissions, publishDerived: false },
      }),
    );
    f.engine.process(now);
    expect(f.publication.latest(now)).toEqual([]);
    f.publication.queue(now);
    expect(f.pending()).toEqual([]);
  } finally {
    f.store.close();
  }
});
it('queues one Phoenix daily digest with at most five clusters and skips empty days', () => {
  const end = Date.parse('2026-10-10T00:00:00-07:00'),
    f = newsFixture(end - 3600000);
  try {
    f.news.saveConfig({ ...f.news.config(), alerts: false });
    reviewedNews(f.news, f.time);
    f.publication.queue(f.time);
    for (let i = 0; i < 6; i++)
      f.add({
        providerArticleId: `earnings-${i}`,
        url: `https://publisher.example/${i}`,
        headline: `Test Company Q1 ${2020 + i} earnings beats estimates`,
      });
    reviewedNews(f.news, end - 1);
    f.publication.queue(end - 1);
    expect(f.pending()).toHaveLength(0);
    reviewedNews(f.news, end);
    f.publication.queue(end);
    reviewedNews(f.news, end);
    f.publication.queue(end);
    expect(f.pending()).toHaveLength(1);
    const p = f.pending()[0]!;
    expect(p.route).toBe('summaries');
    expect(f.publication.report(p.event, end)?.items).toHaveLength(5);
    expect(f.publication.report(p.event, end)?.title).toContain('2026-10-09');
    f.publication.queue(end + 86400000);
    expect(f.pending()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
it('counts persistent alert reservations against rolling-hour and Phoenix-day caps', () => {
  const f = newsFixture();
  try {
    for (let i = 0; i < 7; i++)
      f.add({
        providerArticleId: `a-${i}`,
        url: `https://publisher.example/${i}`,
        headline: `Test Company filed for bankruptcy unique subsidiary alpha${i} beta${i} gamma${i} delta${i}`,
      });
    f.publication.queue(now);
    expect(f.pending()).toHaveLength(2);
    new NewsPublication(f.news, 'test', 'public').queue(now + 1000);
    expect(f.pending()).toHaveLength(2);
    reviewedNews(f.news, now + 3600001);
    f.publication.queue(now + 3600001);
    expect(f.pending()).toHaveLength(4);
    // Existing evidence goes stale after two hours; new records arrive to exercise the daily cap.
    for (let i = 7; i < 12; i++)
      f.add(
        {
          providerArticleId: `a-${i}`,
          url: `https://publisher.example/${i}`,
          headline: `Test Company filed for bankruptcy unique subsidiary alpha${i} beta${i} gamma${i} delta${i}`,
        },
        now + 7200002,
      );
    reviewedNews(f.news, now + 7200002);
    f.publication.queue(now + 7200002);
    expect(f.pending()).toHaveLength(6);
    reviewedNews(f.news, now + 10800003);
    f.publication.queue(now + 10800003);
    expect(f.pending()).toHaveLength(6);
  } finally {
    f.store.close();
  }
});
it('counts the prior-day portion of a rolling alert hour across midnight', () => {
  const end = Date.parse('2026-10-10T00:00:00-07:00'),
    f = newsFixture(end - 1000);
  try {
    for (let i = 0; i < 3; i++)
      f.add({
        providerArticleId: `a${i}`,
        url: `https://publisher.example/${i}`,
        headline: `Test Company filed for bankruptcy alpha${i} beta${i} gamma${i} delta${i}`,
      });
    f.publication.queue(end - 1000);
    expect(f.pending()).toHaveLength(2);
    reviewedNews(f.news, end);
    f.publication.queue(end);
    expect(f.pending().filter((p) => p.route === 'updates')).toHaveLength(2);
  } finally {
    f.store.close();
  }
});
it('invalidates queued output after expiry, revocation or a configuration change', () => {
  for (const reason of ['expiry', 'revoke', 'config']) {
    const f = newsFixture();
    try {
      f.add();
      f.publication.queue(now);
      const p = f.pending()[0]!;
      if (reason === 'revoke')
        f.news.savePolicy(policy('publisher', 'marketaux', { version: 2, status: 'revoked' }));
      if (reason === 'config') f.news.saveConfig({ ...f.news.config(), enabled: false });
      expect(f.publication.report(p.event, reason === 'expiry' ? now + 7200001 : now)).toBeNull();
      f.publication.suppress(p.event);
      expect(f.pending()).toHaveLength(0);
      expect(f.store.journal(p.event.ideaId)).toHaveLength(1);
    } finally {
      f.store.close();
    }
  }
});
it('rolls back journal, outbox and selected evidence together when enqueue fails', () => {
  const f = newsFixture();
  try {
    f.add();
    const before = f.store.journal();
    const original = f.store.db.prepare.bind(f.store.db);
    const spy = vi.spyOn(f.store.db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('INSERT INTO news_delivery_items'))
        throw new Error('synthetic write failure');
      return original(sql);
    });
    expect(() => f.publication.queue(now)).toThrow('synthetic write failure');
    spy.mockRestore();
    expect(f.store.journal()).toEqual(before);
    expect(f.pending()).toHaveLength(0);
    expect(f.store.db.prepare('SELECT * FROM news_deliveries').all()).toEqual([]);
    f.publication.queue(now);
    expect(f.pending()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
it('requires separate current news review and health without market or private-soak blockers', () => {
  const f = newsFixture();
  try {
    f.add();
    f.store.set('news_production_approved', false);
    f.store.set('historical_replay_verified', true);
    f.store.set('soak_start', now - 8 * 86400000);
    const pub = new NewsPublication(f.news);
    pub.queue(now);
    expect(f.pending()).toEqual([]);
    expect(pub.blockers(now)).toEqual(['NEWS_ROLLOUT_REVIEW_REQUIRED']);
    reviewedNews(f.news, now);
    expect(pub.blockers(now)).toEqual([]);
    pub.queue(now);
    expect(f.pending()).toHaveLength(1);
    new NewsMonitor(f.news).observe(now, 'production', false);
    expect(f.store.get('soak_start', 0)).toBe(now - 8 * 86400000);
    expect(pub.blockers(now)).toContain('NEWS_ROLLOUT_REVIEW_REQUIRED');
    expect(pub.blockers(now)).not.toContain('NEWS_SEVEN_DAY_SOAK_REQUIRED');
  } finally {
    f.store.close();
  }
});
