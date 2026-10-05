import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Store } from '../sql-store.js';
import { routes, strategySchema } from '../config.js';
import { crypto, equity, benchmarkFor, type Instrument } from '../domain.js';
import { SignalService } from '../service.js';
import type { DiscordPublisher } from './publisher.js';
import type { Candidate, Dataset } from '../domain.js';
import { card, tradingView } from './cards.js';
const watch = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Manage the shared watchlist')
  .addSubcommand((s) =>
    s.setName('list').setDescription('Show auto selections, pins, and exclusions'),
  );
for (const action of ['add', 'remove', 'restore'])
  watch.addSubcommand((s) =>
    s
      .setName(action)
      .setDescription(`${action} a shared watchlist symbol`)
      .addStringOption((o) =>
        o.setName('symbol').setDescription('AAPL or BTC-USD').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('market')
          .setDescription('Market')
          .setRequired(true)
          .addChoices(
            { name: 'US stock / ETF', value: 'equity' },
            { name: 'Coinbase USD spot', value: 'crypto' },
          ),
      ),
  );
export const commands: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }[] = [watch];
commands.push(
  new SlashCommandBuilder()
    .setName('chart')
    .setDescription('Show an annotated chart for a watched symbol')
    .addStringOption((o) => o.setName('symbol').setDescription('Symbol').setRequired(true)),
  new SlashCommandBuilder()
    .setName('scan')
    .setDescription('Request a scan of discovery and watchlists'),
  new SlashCommandBuilder()
    .setName('idea')
    .setDescription('Inspect a signal and its full journal')
    .addStringOption((o) =>
      o.setName('id').setDescription('24-character idea ID').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show scans, data quality, queues, and budgets'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause scanning and publishing'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume unless the resource budget is exhausted'),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure this server')
    .addSubcommand((s) =>
      s
        .setName('channels')
        .setDescription('Choose a publishing destination or manager role')
        .addStringOption((o) =>
          o
            .setName('route')
            .setDescription('Destination type')
            .setRequired(true)
            .addChoices(...routes.map((r) => ({ name: r, value: r }))),
        )
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Destination')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addRoleOption((o) =>
          o
            .setName('manager_role')
            .setDescription('Administrators may grant shared-list management to this role'),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('strategy')
        .setDescription('Change one threshold and create a strategy version')
        .addStringOption((o) =>
          o
            .setName('parameter')
            .setDescription('Threshold name')
            .setRequired(true)
            .addChoices(
              ...Object.keys(strategySchema.parse({})).map((k) => ({ name: k, value: k })),
            ),
        )
        .addNumberOption((o) =>
          o.setName('value').setDescription('New numeric value').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('validation')
        .setDescription('Administrator attestation after reviewing real historical examples')
        .addStringOption((o) =>
          o
            .setName('report_sha256')
            .setDescription('SHA-256 of the reviewed historical replay report')
            .setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName('examples')
            .setDescription(
              'Real historical examples reviewed, including bullish and bearish cases',
            )
            .setMinValue(30)
            .setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName('failures')
            .setDescription('Reviewed rejected or invalidated examples')
            .setMinValue(1)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('alerts')
        .setDescription('Configure watchlist alerts and optional options context')
        .addBooleanOption((o) =>
          o.setName('enabled').setDescription('Significant-change alerts').setRequired(true),
        )
        .addBooleanOption((o) =>
          o.setName('options').setDescription('Optional indicative options context'),
        ),
    ),
);
export function authorized(admin: boolean, roles: string[], manager?: string) {
  return admin || (!!manager && roles.includes(manager));
}
export function parseInstrument(symbol: string, market: string): Instrument {
  const value = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(value)) throw new Error('Invalid symbol');
  if (market === 'crypto' && !value.endsWith('-USD'))
    throw new Error('Use a Coinbase USD pair such as BTC-USD');
  return market === 'crypto' ? crypto(value) : equity(value);
}
export class CommandHandler {
  constructor(
    readonly store: Store,
    readonly service: SignalService,
    readonly publisher: DiscordPublisher,
    readonly charts: { render(data: Dataset, candidate?: Candidate): Promise<Buffer> },
    readonly budget: { image(now: number, bytes: number): boolean; status(): { paused: boolean } },
    readonly guildId: string,
    readonly requestScan?: () => void,
  ) {}
  async handle(i: ChatInputCommandInteraction) {
    if (i.guildId !== this.guildId) {
      await (i.deferred
        ? i.editReply('This bot is configured for one private server.')
        : i.reply({ content: 'This bot is configured for one private server.', ephemeral: true }));
      return;
    }
    const sub = i.options.getSubcommand(false),
      readOnly =
        ['chart', 'idea', 'status'].includes(i.commandName) ||
        (i.commandName === 'watch' && sub === 'list');
    const member = await i.guild!.members.fetch(i.user.id),
      admin = member.permissions.has(PermissionFlagsBits.Administrator);
    if (
      !readOnly &&
      !authorized(admin, [...member.roles.cache.keys()], this.store.settings().managerRole)
    ) {
      await (i.deferred
        ? i.editReply('An administrator or configured manager role is required.')
        : i.reply({
            content: 'An administrator or configured manager role is required.',
            ephemeral: true,
          }));
      return;
    }
    await i.deferReply({ ephemeral: true });
    try {
      if (this.budget.status().paused && i.commandName !== 'status')
        throw new Error(
          'Free-plan resource budget exhausted; scanning and publication remain paused.',
        );
      if (i.commandName === 'watch') {
        if (sub === 'list') {
          const rows = this.store.watchRows();
          await i.editReply(
            rows
              .map(
                (r) =>
                  `${r.instrument.symbol}: ${r.excluded ? 'excluded' : r.pinned ? 'manual pin' : r.auto ? 'auto-selected' : 'available'}`,
              )
              .join('\n')
              .slice(0, 1900) || 'No symbols yet.',
          );
          return;
        }
        const instrument = parseInstrument(
          i.options.getString('symbol', true),
          i.options.getString('market', true),
        );
        if (sub === 'add') {
          const available = await this.service.data.provider(instrument).discover(Date.now());
          if (!available.some((x) => x.id === instrument.id))
            throw new Error('Symbol is not supported by the selected data provider.');
          this.store.pin(instrument);
        } else if (sub === 'remove') this.store.exclude(instrument);
        else this.store.restore(instrument);
        await i.editReply(
          `${instrument.symbol}: ${sub === 'remove' ? 'removed and excluded from automatic selection; existing ideas remain monitored' : sub === 'restore' ? 'eligible for automatic selection again' : 'pinned; strategy and data-quality checks still apply'}.`,
        );
        return;
      }
      if (i.commandName === 'pause' || i.commandName === 'resume') {
        const s = this.store.settings();
        s.paused = i.commandName === 'pause';
        this.store.set('settings', s);
        await i.editReply(
          s.paused ? 'Scanning and publishing paused.' : 'Scanning and publishing resumed.',
        );
        return;
      }
      if (i.commandName === 'config') {
        if (sub === 'validation') {
          if (!admin) throw new Error('Only administrators may attest to historical validation');
          const hash = i.options.getString('report_sha256', true);
          if (!/^[a-f0-9]{64}$/i.test(hash))
            throw new Error('Use the 64-character SHA-256 printed by the replay tool');
          this.store.set('historical_validation', {
            reportSha256: hash,
            examples: i.options.getInteger('examples', true),
            failures: i.options.getInteger('failures', true),
            reviewer: i.user.id,
            at: Date.now(),
          });
          this.store.set('historical_replay_verified', true);
          await i.editReply(
            'Review attestation recorded. The seven-day private-channel soak and channel permissions are still required.',
          );
          return;
        }
        if (sub === 'strategy') {
          const key = i.options.getString('parameter', true),
            value = i.options.getNumber('value', true),
            parsed = strategySchema.safeParse({ ...this.store.strategy(), [key]: value });
          if (!parsed.success)
            throw new Error(parsed.error.issues.map((x) => x.message).join('; '));
          this.store.saveStrategy(parsed.data);
          await i.editReply(
            'New strategy version saved. Existing ideas retain their original rules.',
          );
          return;
        }
        const settings = this.store.settings();
        if (sub === 'channels') {
          const destination = i.options.getChannel('channel', true);
          await this.publisher.validate(destination.id);
          settings.channels[i.options.getString('route', true) as (typeof routes)[number]] =
            destination.id;
          const role = i.options.getRole('manager_role');
          if (role) {
            if (!admin) throw new Error('Only administrators may change the manager role');
            settings.managerRole = role.id;
          }
        } else {
          settings.alerts = i.options.getBoolean('enabled', true);
          settings.options = i.options.getBoolean('options') ?? settings.options;
        }
        this.store.set('settings', settings);
        await i.editReply(
          'Configuration saved. Publication requires all six routes or the private test-channel configuration.',
        );
        return;
      }
      if (i.commandName === 'scan') {
        if (this.service.running) {
          await i.editReply('A scan is already running.');
          return;
        }
        await i.editReply('Scan requested. Results will use configured destinations.');
        if (this.requestScan) this.requestScan();
        else
          void this.service
            .scan(Date.now(), true)
            .catch(() => this.store.set('last_error', 'SCAN_FAILED'));
        return;
      }
      if (i.commandName === 'status') {
        const monitored = this.store.monitored(),
          budget = this.budget.status();
        await i.editReply(
          JSON.stringify(
            {
              paused: this.store.settings().paused,
              running: this.service.running,
              lastScan: this.store.get('last_scan', null),
              lastError: this.store.get('last_error', null),
              lastErrorStage: this.store.get('last_error_stage', null),
              scanProgress: this.store.get('scan_progress', null),
              pendingDeliveries: this.store.pendingCount(),
              activeIdeas: this.store.activeIdeas().length,
              activeEntries: this.store.activeEntries(),
              soakStarted: this.store.get('soak_start', null),
              budget,
              instruments: monitored.map((x) => ({
                symbol: x.symbol,
                pausedReason: this.store.get(`quality:${x.id}`, null),
                dataTime: this.store.get(`freshness:${x.id}`, null),
              })),
            },
            null,
            2,
          ).slice(0, 1950),
        );
        return;
      }
      if (i.commandName === 'idea') {
        const id = i.options.getString('id', true),
          journal = this.store.journal(id);
        if (!journal.length) throw new Error('Unknown idea ID');
        await i.editReply({
          embeds: [card(journal.at(-1)!)],
          content: journal
            .map(
              (e) =>
                `${new Date(e.marketTime).toISOString()} · ${e.state}${e.recovery ? ' · recovered' : ''}`,
            )
            .join('\n')
            .slice(0, 1900),
        });
        return;
      }
      const symbol = i.options.getString('symbol', true).toUpperCase(),
        instrument = this.store.monitored().find((x) => x.symbol === symbol);
      if (!instrument) throw new Error('Add or select this symbol on the watchlist first.');
      const data = await this.service.data.dataset(instrument, Date.now()),
        idea = this.store.activeIdeas().find((x) => x.candidate.instrument.id === instrument.id),
        image = await this.charts.render(data, idea?.candidate).catch(() => undefined);
      if (!image) {
        await i.editReply(
          `Chart rendering allowance unavailable. Open chart: ${tradingView(symbol, instrument.market)}`,
        );
        return;
      }
      if (!this.budget.image(Date.now(), image.length)) {
        await i.editReply(
          `Image allowance reached. Open chart: ${tradingView(symbol, instrument.market)}`,
        );
        return;
      }
      await i.editReply({
        content: `${symbol} · ${data.provenance.feed} · ${data.provenance.delayMinutes}m minimum delay`,
        files: [{ attachment: image, name: 'chart.png' }],
      });
    } catch (e) {
      await i.editReply({
        content:
          e instanceof Error ? e.message.slice(0, 1800) : 'Operation failed; try again later.',
      });
    }
  }
}
