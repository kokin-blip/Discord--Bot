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
import { buttons, card } from './cards.js';
export class DiscordPublisher implements Publisher {
  constructor(
    readonly client: Client,
    readonly store: Store,
    readonly data: DataService,
    readonly charts: { render(data: Dataset, candidate?: Candidate): Promise<Buffer> },
    readonly budget: { image(now: number, bytes: number): boolean },
    readonly guildId: string,
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
  async deliver(event: SignalEvent, destination: string): Promise<void> {
    if (this.store.get('budget_paused', false)) throw new Error('EGRESS_BUDGET_PAUSED');
    const channel = await this.validate(destination),
      existing = this.store.thread(event.ideaId);
    let target: GuildTextBasedChannel = channel;
    if (existing?.thread && existing.channel === destination) {
      const thread = await this.client.channels.fetch(existing.thread);
      if (thread?.isThread()) {
        if (thread.archived) await thread.setArchived(false);
        target = thread;
      }
    }
    const recent = await target.messages.fetch({ limit: 100 });
    let message = recent.find(
      (m) =>
        m.author.id === (this.client.user?.id ?? channel.guild.members.me?.id) &&
        m.embeds.some((e) => e.footer?.text.includes(`event ${event.id}`)),
    );
    if (!message) {
      let dataset: Dataset | undefined;
      try {
        dataset = await this.data.dataset(event.instrument, event.recordedAt);
      } catch {}
      let options: OptionsContext[] = [];
      if (
        event.instrument.market === 'equity' &&
        event.state === 'entry_triggered' &&
        this.store.settings().options
      ) {
        try {
          options = (await this.data.equities.options?.(event.instrument)) ?? [];
        } catch {}
      }
      const embed =
        event.strategyVersion === 'system'
          ? new EmbedBuilder()
              .setTitle('Bot update')
              .setDescription(event.reasons.join('\n'))
              .setFooter({ text: `event ${event.id}` })
          : event.strategyVersion === 'watch-alert-v1'
            ? new EmbedBuilder()
                .setTitle(`${event.instrument.symbol} · Watchlist change`)
                .setDescription(
                  `${event.reasons.join('\n')}\n${event.provenance.feed} · data ${new Date(event.marketTime).toISOString()} · ${Math.max(0, (Date.now() - event.marketTime) / 60000).toFixed(0)}m old (feed minimum ${event.provenance.delayMinutes}m)`,
                )
                .setTimestamp(event.marketTime)
                .setFooter({ text: `event ${event.id}` })
            : card(event, options);
      let image: Buffer | undefined;
      if (
        dataset &&
        event.strategyVersion !== 'system' &&
        event.strategyVersion !== 'watch-alert-v1'
      )
        try {
          // Freeze chart data at the event time, including only bars available at that instant.
          const frozen = {
            ...dataset,
            daily: dataset.daily.filter((b) => b.end <= event.marketTime),
            weekly: dataset.weekly.filter((b) => b.end <= event.marketTime),
            provenance: { ...event.provenance },
          };
          if (frozen.daily.length && frozen.weekly.length) {
            const rendered = await this.charts.render(frozen, event.candidate);
            if (this.budget.image(Date.now(), rendered.length)) image = rendered;
          }
        } catch {
          embed.addFields({ name: 'Chart', value: 'Chart unavailable; signal details retained.' });
        }
      if (image) embed.setImage('attachment://chart.png');
      message = await target.send({
        embeds: [embed],
        components: event.strategyVersion === 'system' ? [] : [buttons(event)],
        files: image ? [new AttachmentBuilder(image, { name: 'chart.png' })] : [],
        allowedMentions: { parse: [] },
        nonce: BigInt(`0x${event.id.slice(0, 16)}`).toString(),
        enforceNonce: true,
      });
    }
    if (!existing && event.strategyVersion.startsWith('br-v1-')) {
      this.store.saveThread(event.ideaId, destination, message.id);
      const thread = message.hasThread
        ? message.thread
        : await message.startThread({
            name: `${event.instrument.symbol} ${event.direction} · ${event.ideaId.slice(0, 6)}`,
            autoArchiveDuration: 1440,
          });
      this.store.saveThread(event.ideaId, destination, message.id, thread?.id);
    } else if (existing && !existing.thread && event.strategyVersion.startsWith('br-v1-')) {
      const originalChannel = await this.validate(existing.channel);
      const original = await originalChannel.messages.fetch(existing.message);
      const thread = original.hasThread
        ? original.thread
        : await original.startThread({
            name: `${event.instrument.symbol} · ${event.ideaId.slice(0, 6)}`,
            autoArchiveDuration: 1440,
          });
      this.store.saveThread(event.ideaId, existing.channel, existing.message, thread?.id);
    }
  }
}
