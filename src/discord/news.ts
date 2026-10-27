import { NewsMonitor } from '../news/monitor.js';
import { NewsQuota } from '../news/quota.js';
import {
  EmbedBuilder,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { NEWS_ANALYTICS_VERSION } from '../news/mapping.js';
import type { NewsPublication, NewsItem } from '../news/publication.js';
export const newsCommand = new SlashCommandBuilder()
  .setName('news')
  .setDescription('Inspect cached, licensed news and configure informational delivery');
for (const action of ['latest', 'sentiment'])
  newsCommand.addSubcommand((s) =>
    s
      .setName(action)
      .setDescription(
        action === 'latest'
          ? 'Show cached permitted news'
          : 'Show explainable cached financial sentiment',
      )
      .addStringOption((o) =>
        o.setName('symbol').setDescription('Optional monitored symbol').setAutocomplete(true),
      ),
  );
newsCommand.addSubcommand((s) =>
  s.setName('sources').setDescription('Show providers and sources cleared for publication'),
);
newsCommand.addSubcommand((s) =>
  s
    .setName('status')
    .setDescription('Manager: inspect news diagnostics, quotas and publication gates'),
);
newsCommand.addSubcommand((s) => {
  s.setName('config').setDescription('Manager: configure news switches and reduce request caps');
  for (const name of ['enabled', 'marketaux', 'currents', 'gdelt', 'digest', 'alerts'])
    s.addBooleanOption((o) => o.setName(name).setDescription(`Enable or disable ${name}`));
  for (const [provider, cap] of [
    ['marketaux', 60],
    ['currents', 100],
    ['gdelt', 30],
  ] as const)
    s.addIntegerOption((o) =>
      o
        .setName(`${provider}_cap`)
        .setDescription('Daily attempt cap; may only be reduced')
        .setMinValue(0)
        .setMaxValue(cap),
    );
  s.addStringOption((o) =>
    o
      .setName('review_sha256')
      .setDescription('Approve the current private-soak status snapshot hash'),
  );
  for (const name of ['reviewed_mappings', 'false_mappings', 'reviewed_alerts', 'false_alerts'])
    s.addIntegerOption((o) =>
      o
        .setName(name)
        .setDescription('Human-reviewed sample count for rollout')
        .setMinValue(0)
        .setMaxValue(1000000),
    );
  s.addBooleanOption((o) =>
    o
      .setName('free_plan_verified')
      .setDescription('Attest account-wide resource headroom on free plans'),
  );
  return s;
});
const safe = (text: string) => escapeMarkdown(text.replace(/[\r\n]+/g, ' '));
export function newsLines(items: NewsItem[]): string[] {
  return items.map((item) => {
    const topic = item.topic.startsWith('instrument:') ? item.topic.split(':').at(-1)! : item.topic;
    const timing =
      item.publishedAt === null
        ? `Publication unknown${item.firstSeenAt !== null ? `; provider first seen ${new Date(item.firstSeenAt).toISOString()}` : ''}`
        : `Published ${new Date(item.publishedAt).toISOString()} · ${item.freshness}`;
    return `**${safe(topic)} · ${safe(item.eventClass.replaceAll('_', ' '))} · ${safe(item.severity)}**\n${item.headline ? `${safe(item.headline)}\n` : ''}${timing}\n${item.attribution.map(safe).join(' · ')}\n<${item.url}>`;
  });
}
export function newsEmbed(
  report: { title: string; items: NewsItem[] },
  eventId?: string,
): EmbedBuilder | null {
  const description = newsLines(report.items).join('\n\n');
  if (!description || description.length > 3800) return null;
  return new EmbedBuilder()
    .setTitle(report.title)
    .setDescription(description)
    .setFooter({
      text: `Informational · sampled coverage · ${NEWS_ANALYTICS_VERSION}${eventId ? ` · event ${eventId}` : ''}`,
    });
}
export async function handleNews(
  i: ChatInputCommandInteraction,
  publication: NewsPublication | null,
  now: number,
): Promise<void> {
  if (!publication) {
    await i.editReply('News is unavailable; market monitoring remains independent.');
    return;
  }
  const news = publication.news,
    store = news.store,
    sub = i.options.getSubcommand();
  if (sub === 'config') {
    const sha256 = i.options.getString('review_sha256');
    const reviewOptions = [
      'reviewed_mappings',
      'false_mappings',
      'reviewed_alerts',
      'false_alerts',
    ];
    if (
      sha256 ||
      reviewOptions.some((name) => i.options.getInteger(name) !== null) ||
      i.options.getBoolean('free_plan_verified') !== null
    ) {
      const switches = ['enabled', 'digest', 'alerts', 'marketaux', 'currents', 'gdelt'];
      if (
        switches.some((name) => i.options.getBoolean(name) !== null) ||
        ['marketaux', 'currents', 'gdelt'].some(
          (name) => i.options.getInteger(`${name}_cap`) !== null,
        )
      )
        throw new Error('NEWS_ROLLOUT_REVIEW_BLOCKED');
      new NewsMonitor(news).approve(
        {
          sha256,
          reviewedMappings: i.options.getInteger('reviewed_mappings'),
          falseMappings: i.options.getInteger('false_mappings'),
          reviewedAlerts: i.options.getInteger('reviewed_alerts'),
          falseAlerts: i.options.getInteger('false_alerts'),
          freePlanVerified: i.options.getBoolean('free_plan_verified'),
        },
        i.user.id,
        now,
      );
      await i.editReply(
        'News review recorded for live publication. Source rights, current health and resource limits still apply.',
      );
      return;
    }
    const current = news.config(),
      next = structuredClone(current);
    for (const name of ['enabled', 'digest', 'alerts'] as const)
      next[name] = i.options.getBoolean(name) ?? current[name];
    for (const name of ['marketaux', 'currents', 'gdelt'] as const) {
      next.providers[name] = i.options.getBoolean(name) ?? current.providers[name];
      const cap = i.options.getInteger(`${name}_cap`);
      if (cap !== null) {
        if (cap > current.dailyCaps[name])
          throw new Error('News request caps may only be reduced.');
        next.dailyCaps[name] = cap;
      }
    }
    news.saveConfig(next);
    await i.editReply(
      'News configuration saved. Source rights, credentials, current health and a separate manager review are required for live publication.',
    );
    return;
  }
  if (sub === 'status') {
    const config = news.config(),
      day = new Date(now).toISOString().slice(0, 10);
    const quotas = store.db
      .prepare('SELECT provider,attempts FROM news_quota_days WHERE day=?')
      .all(day);
    const text = JSON.stringify(
      {
        config,
        monitoring: new NewsMonitor(news).snapshot(now),
        analyticsVersion: NEWS_ANALYTICS_VERSION,
        quotas,
        publicationMode: publication.mode,
        publicationBlockers: publication.blockers(now),
        providers: publication.sources(now).map((provider) => {
          const { diagnostic, suspended, nextAt, blockedUntil, failures, remaining, remainingDay } =
            new NewsQuota(news).state(provider.provider);
          return {
            ...provider,
            diagnostic,
            suspended,
            nextAt,
            blockedUntil,
            failures,
            remaining,
            remainingDay,
          };
        }),
        runtimeError: store.get('news_runtime_error', null),
        analysisError: store.get('news_analysis_error', null),
        publicationError: store.get('news_publication_error', null),
        lastResult: store.get('news_last_result', null),
        resources: store.get('news_resource_usage', null),
      },
      null,
      2,
    );
    await i.editReply({
      content: `News ${config.enabled ? 'enabled' : 'disabled'} · ${publication.mode} publication · ${publication.blockers(now).join(', ') || 'publication gate ready'}`,
      files: [{ attachment: Buffer.from(text), name: 'news-status.json' }],
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (sub === 'sources') {
    const text = publication
      .sources(now)
      .map(
        (p) =>
          `${p.provider}: ${p.enabled ? 'enabled' : 'disabled'} · ${p.licensedPublishers.length ? 'publication-cleared domains: ' + p.licensedPublishers.join(', ') : 'no publication-cleared sources'}`,
      )
      .join('\n');
    await i.editReply({ content: text.slice(0, 1900), allowedMentions: { parse: [] } });
    return;
  }
  if (!news.config().enabled) {
    await i.editReply('News is disabled.');
    return;
  }
  const symbol = i.options.getString('symbol')?.trim().toUpperCase();
  const instrument = symbol ? store.monitored().find((x) => x.symbol === symbol) : undefined;
  if (symbol && !instrument) throw new Error('Symbol is not monitored.');
  if (sub === 'latest') {
    const items = publication.latest(now, instrument?.id),
      selected: NewsItem[] = [];
    for (const item of items) {
      if (newsLines([...selected, item]).join('\n\n').length <= 3800) selected.push(item);
    }
    const embed = newsEmbed({ title: 'Latest cached news · informational', items: selected });
    await i.editReply(
      embed
        ? { embeds: [embed], allowedMentions: { parse: [] } }
        : 'No cached news has current publication permission.',
    );
    return;
  }
  if (sub === 'sentiment') {
    const ids = instrument
      ? [instrument.id]
      : store
          .monitored()
          .slice(0, 20)
          .map((x) => x.id);
    const lines: string[] = [];
    outer: for (const id of [...ids, ...(instrument ? [] : [null])])
      for (const result of publication.intelligence.sentiments(id, now)) {
        // Per-article evidence must be cleared for metadata and derived publication.
        const clusterIds = store.db
          .prepare('SELECT event_id FROM news_event_articles WHERE article_id=? LIMIT 10')
          .all(result.articleId) as { event_id: string }[];
        const evidence = clusterIds
          .flatMap((c) => publication.items(c.event_id, now))
          .find((e) => e.articleId === result.articleId);
        if (!evidence) continue;
        const explanation = result.explanation as {
          local?: {
            label: string;
            contributions: { rule: string; weight: number; negated: boolean }[];
          };
          scope?: string;
        };
        const label = explanation.local?.label ?? 'provider entity score';
        const line = `${safe(store.monitored().find((x) => x.id === id)?.symbol ?? 'Article')} · ${result.origin} · ${label}: ${result.score === null ? 'unknown' : result.score} · ${result.origin === 'local' ? 'rule coverage' : 'mapping confidence'} ${result.confidence}\n${explanation.local?.contributions.map((c) => `${c.rule}: ${c.weight}${c.negated ? ' (negated)' : ''}`).join('; ') || 'Provider-scoped financial score; not blended with local rules.'}\n${evidence.attribution.map(safe).join(' · ')}\n<${evidence.url}>`;
        if ([...lines, line].join('\n\n').length <= 1800) lines.push(line);
        if (lines.length >= 5) break outer;
      }
    await i.editReply({
      content: lines.length
        ? `Cached sentiment · informational · ${NEWS_ANALYTICS_VERSION}\n${lines.slice(0, 5).join('\n\n')}`.slice(
            0,
            2000,
          )
        : 'No cached sentiment has current publication permission.',
      allowedMentions: { parse: [] },
    });
    return;
  }
}
