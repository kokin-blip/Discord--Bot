import { deliveryContext } from './delivery-context.js';
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { Dataset, OptionsContext, Publisher, SignalEvent } from '../domain.js';
import type { Store } from '../sql-store.js';
import type { Candidate } from '../domain.js';
import type { DataService } from '../data.js';
import { buttons, card, publicCard, isConfirmedExit, trackerCard, learningCard } from './cards.js';
import { stableId } from '../core/strategy.js';
import { CHART_STYLE_VERSION } from '../chart-snapshot.js';
export class DiscordPublisher implements Publisher {
  constructor(
    readonly client: Client,
    readonly store: Store,
    readonly data: DataService,
    readonly charts: {
      render(data: Dataset, candidate?: Candidate, tracker?: SignalEvent): Promise<Buffer>;
    },
    readonly budget: { image(now: number, bytes: number): boolean },
    readonly guildId: string,
    readonly clock: () => number = Date.now,
  ) {}
  async validate(destination: string): Promise<GuildTextBasedChannel> {
    const channel = await this.client.channels.fetch(destination);
    if (
      !channel ||
      !('guildId' in channel) ||
      channel.guildId !== this.guildId ||
      !channel.isTextBased() ||
      !('send' in channel) ||
      channel.type !== ChannelType.GuildText
    )
      throw new Error('DESTINATION_MUST_BE_GUILD_TEXT_CHANNEL');
    const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
    const perms = channel.permissionsFor(me),
      required = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ];
    if (!perms?.has(required)) throw new Error('MISSING_CHANNEL_PERMISSIONS');
    return channel;
  }
  async deliver(event: SignalEvent, destination: string, snapshot?: Dataset): Promise<void> {
    if (this.store.get('budget_paused', false)) throw new Error('EGRESS_BUDGET_PAUSED');
    if (event.kind === 'learning_review') {
      const source = this.store.db
        .prepare('SELECT status FROM outbox WHERE event_id=?')
        .get(event.sourceEventId ?? '') as { status: string } | undefined;
      if (source?.status !== 'delivered') throw new Error('FAILURE_ALERT_NOT_DELIVERED');
      const discussion = this.store.thread(event.ideaId);
      if (!discussion?.thread) throw new Error('FAILURE_THREAD_NOT_READY');
      const thread = await this.client.channels.fetch(discussion.thread);
      if (!thread?.isThread() || thread.guildId !== this.guildId)
        throw new Error('FAILURE_THREAD_UNAVAILABLE');
      if (this.store.receipt(event.id, thread.id)) return;
      if (thread.archived) await thread.setArchived(false);
      const recent = await thread.messages.fetch({ limit: 100 });
      const found = recent.find(
        (m) =>
          m.author.id === this.client.user?.id &&
          m.embeds.some((e) => e.footer?.text.includes(`event ${event.id}`)),
      );
      const message =
        found ??
        (await thread.send({
          embeds: [learningCard(event)],
          allowedMentions: { parse: [] },
          nonce: BigInt(`0x${stableId(event.id, thread.id).slice(0, 16)}`).toString(),
          enforceNonce: true,
        }));
      this.store.saveReceipt(event.id, thread.id, message.id);
      return;
    }
    const threaded =
      (!event.debug || event.tracker?.type === 'range') &&
      event.kind !== 'learning_report' &&
      (event.strategyVersion.startsWith('br-v1-') ||
        event.tracker?.type === 'reversal' ||
        event.tracker?.type === 'range');
    const channel = await this.validate(destination),
      existing = this.store.thread(event.ideaId);
    const target = channel,
      receipt = this.store.receipt(event.id, destination);
    const recent = receipt ? undefined : await target.messages.fetch({ limit: 100 });
    let message = receipt
      ? await target.messages.fetch(receipt)
      : recent!.find(
          (m) =>
            m.author.id === (this.client.user?.id ?? channel.guild.members.me?.id) &&
            m.embeds.some((e) => e.footer?.text.includes(`event ${event.id}`)),
        );
    const historical = deliveryContext(this.store, event, this.clock());
    let options: OptionsContext[] = [];
    if (!message) {
      let dataset: Dataset | undefined;
      try {
        if (event.strategyVersion !== 'system')
          dataset = snapshot ?? (await this.data.dataset(event.instrument, event.recordedAt));
      } catch {}
      if (
        event.instrument.market === 'equity' &&
        event.state === 'entry_triggered' &&
        !historical &&
        this.store.settings().options
      ) {
        try {
          options =
            (await this.data.equities.options?.(event.instrument, {
              direction: event.direction,
              price: event.candidate.entry!,
              now: this.clock(),
            })) ?? [];
        } catch {}
      }
      const embed =
        event.kind === 'learning_report'
          ? learningCard(event)
          : event.kind === 'watch_tracker'
            ? trackerCard(event)
            : event.strategyVersion === 'system'
              ? new EmbedBuilder()
                  .setTitle(event.announcement?.title ?? 'Bot update')
                  .setTimestamp(event.marketTime)
                  .setDescription(
                    event.announcement?.body.slice(0, 4000) ?? event.reasons.join('\n'),
                  )
                  .setFooter({ text: `event ${event.id}` })
              : event.strategyVersion === 'watch-alert-v1'
                ? new EmbedBuilder()
                    .setTitle(`${event.instrument.symbol} · Watchlist change`)
                    .setDescription(
                      `${event.reasons.join('\n')}\n${event.provenance.feed} · data ${new Date(event.marketTime).toISOString()} · ${Math.max(0, (Date.now() - event.marketTime) / 60000).toFixed(0)}m old (feed minimum ${event.provenance.delayMinutes}m)`,
                    )
                    .setTimestamp(event.marketTime)
                    .setFooter({ text: `event ${event.id}` })
                : publicCard(event, options);
      if (event.announcement?.imageUrl) embed.setImage(event.announcement.imageUrl);
      if (historical) {
        embed.setTitle(
          `${event.instrument.symbol} · HISTORICAL ${event.state.replaceAll('_', ' ')}`,
        );
        embed.addFields({ name: 'Delivery context', value: historical });
      }
      let image: Buffer | undefined;
      if (
        dataset &&
        !(historical && event.state === 'entry_triggered') &&
        event.strategyVersion !== 'system' &&
        event.strategyVersion !== 'watch-alert-v1'
      )
        try {
          // Freeze chart data at the event time, including only bars available at that instant.
          const frozen = {
            ...dataset,
            daily: dataset.daily.filter((b) => b.end <= event.marketTime),
            weekly: dataset.weekly.filter((b) => b.end <= event.marketTime),
            intraday: dataset.intraday.filter((b) => b.end <= event.marketTime),
            provenance: { ...event.provenance },
          };
          const intradayTracker = event.tracker?.timeframe === '15m';
          if (event.kind === 'watch_tracker') {
            const snapshotBar = event.candidate.breakout;
            const bars = intradayTracker ? frozen.intraday : frozen.daily;
            const exact = bars.map((b) => (b.start === snapshotBar.start ? snapshotBar : b));
            if (intradayTracker) frozen.intraday = exact;
            else frozen.daily = exact;
          }
          if (
            frozen.daily.length &&
            (intradayTracker ? frozen.intraday.length : frozen.weekly.length)
          ) {
            const rendered = await this.charts.render(
              frozen,
              event.kind === 'watch_tracker' ? undefined : event.candidate,
              event,
            );
            if (this.budget.image(Date.now(), rendered.length)) image = rendered;
          }
        } catch {
          // Chart rendering is optional: browser limits and rendering failures must
          // never interrupt the public signal or its delivery receipts.
        }
      if (
        !image &&
        event.strategyVersion !== 'system' &&
        event.strategyVersion !== 'watch-alert-v1'
      )
        embed.addFields({
          name: 'Chart',
          value:
            'Chart unavailable or chart allowance reached; full alert details are shown above.',
        });
      const imageName = event.debug ? `chart-${CHART_STYLE_VERSION}-${event.id}.png` : 'chart.png';
      if (event.debug)
        embed.setFooter({
          text: `${embed.data.footer?.text ?? ''} · chart ${CHART_STYLE_VERSION}`,
        });
      if (image) embed.setImage(`attachment://${imageName}`);
      message = await target.send({
        embeds: [embed],
        components: event.strategyVersion === 'system' ? [] : [buttons(event)],
        files:
          event.announcement && event.announcement.body.length > 4000
            ? [
                new AttachmentBuilder(Buffer.from(event.announcement.body), {
                  name: 'announcement.txt',
                }),
              ]
            : event.kind === 'learning_report'
              ? [
                  new AttachmentBuilder(Buffer.from(event.learningText!), {
                    name: 'learning-report.txt',
                  }),
                ]
              : image
                ? [new AttachmentBuilder(image, { name: imageName })]
                : [],
        allowedMentions: { parse: [] },
        nonce: BigInt(`0x${stableId(event.id, destination).slice(0, 16)}`).toString(),
        enforceNonce: true,
      });
    }
    this.store.saveReceipt(event.id, destination, message.id);
    if (event.debug)
      this.store.set('debug_last_delivery', {
        at: Date.now(),
        channel: destination,
        messageId: message.id,
        eventId: event.id,
        chartAttached: message.embeds.some((e) => !!e.image?.url),
        chartStyleVersion: CHART_STYLE_VERSION,
      });
    if (!existing && threaded) {
      this.store.saveThread(event.ideaId, destination, message.id);
      const thread = message.hasThread
        ? await this.client.channels.fetch(message.id)
        : await message.startThread({
            name: `${event.instrument.symbol} ${event.direction} · ${event.ideaId.slice(0, 6)}`,
            autoArchiveDuration: 1440,
          });
      if (!thread?.isThread()) throw new Error('IDEA_THREAD_UNAVAILABLE');
      this.store.saveThread(event.ideaId, destination, message.id, thread?.id);
    } else if (existing && !existing.thread && threaded) {
      const originalChannel = await this.validate(existing.channel);
      const original = await originalChannel.messages.fetch(existing.message);
      const thread = original.hasThread
        ? await this.client.channels.fetch(original.id)
        : await original.startThread({
            name: `${event.instrument.symbol} · ${event.ideaId.slice(0, 6)}`,
            autoArchiveDuration: 1440,
          });
      if (!thread?.isThread()) throw new Error('IDEA_THREAD_UNAVAILABLE');
      this.store.saveThread(event.ideaId, existing.channel, existing.message, thread?.id);
    }
    const discussion = this.store.thread(event.ideaId);
    if (
      threaded &&
      discussion?.thread &&
      (discussion.message !== message.id ||
        event.state === 'entry_triggered' ||
        isConfirmedExit(event) ||
        event.tracker?.type === 'range')
    ) {
      const thread = await this.client.channels.fetch(discussion.thread);
      if (!thread?.isThread()) throw new Error('IDEA_THREAD_UNAVAILABLE');
      if (thread.archived) await thread.setArchived(false);
      if (!this.store.receipt(event.id, thread.id)) {
        const recent = await thread.messages.fetch({ limit: 100 });
        const mirroredEmbed = event.tracker ? trackerCard(event, true) : card(event, options);
        if (historical)
          mirroredEmbed
            .setTitle(`${event.instrument.symbol} · HISTORICAL ${event.state.replaceAll('_', ' ')}`)
            .addFields({ name: 'Delivery context', value: historical });
        const mirrored =
          recent.find(
            (m) =>
              m.author.id === this.client.user?.id &&
              m.embeds.some((e) => e.footer?.text.includes(`event ${event.id}`)),
          ) ??
          (await thread.send({
            embeds: [mirroredEmbed],
            components: [buttons(event)],
            allowedMentions: { parse: [] },
            nonce: BigInt(`0x${stableId(event.id, thread.id).slice(0, 16)}`).toString(),
            enforceNonce: true,
          }));
        this.store.saveReceipt(event.id, thread.id, mirrored.id);
      }
    }
  }
}
