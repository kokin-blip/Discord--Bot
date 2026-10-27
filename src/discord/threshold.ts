import { EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Store } from '../sql-store.js';
import type { SignalEvent } from '../domain.js';
import type { ThresholdConfig } from '../threshold/types.js';
import { ThresholdStore } from '../threshold/store.js';

export const thresholdCommand = new SlashCommandBuilder()
  .setName('threshold')
  .setDescription('Stalled-trade exit reviews; never places orders');
thresholdCommand.addSubcommand((s) =>
  s
    .setName('add')
    .setDescription('Track a standard long option; future alerts are public')
    .addStringOption((o) =>
      o
        .setName('contract')
        .setDescription('Exact standard OCC contract, e.g. AAPL261218C00250000')
        .setRequired(true),
    )
    .addNumberOption((o) =>
      o
        .setName('entry')
        .setDescription('Average paid premium per share')
        .setRequired(true)
        .setMinValue(0.000001),
    )
    .addIntegerOption((o) =>
      o
        .setName('quantity')
        .setDescription('Contracts held; default 1')
        .setMinValue(1)
        .setMaxValue(1000),
    )
    .addNumberOption((o) =>
      o
        .setName('stop')
        .setDescription('Premium stop below entry; required for loss prompts')
        .setMinValue(0.000001),
    )
    .addNumberOption((o) =>
      o
        .setName('fees')
        .setDescription('Round-trip dollars per contract; omitted means fees not included')
        .setMinValue(0)
        .setMaxValue(10000),
    )
    .addStringOption((o) =>
      o.setName('idea').setDescription('Optional matching source idea ID').setAutocomplete(true),
    ),
);
thresholdCommand.addSubcommand((s) =>
  s
    .setName('edit')
    .setDescription('Change your monitor; empty edit restarts a suspended monitor')
    .addStringOption((o) =>
      o.setName('id').setDescription('Monitor ID').setRequired(true).setAutocomplete(true),
    )
    .addNumberOption((o) =>
      o.setName('entry').setDescription('New average premium').setMinValue(0.000001),
    )
    .addIntegerOption((o) =>
      o.setName('quantity').setDescription('Contracts held').setMinValue(1).setMaxValue(1000),
    )
    .addNumberOption((o) =>
      o.setName('stop').setDescription('Premium stop below entry').setMinValue(0.000001),
    )
    .addBooleanOption((o) =>
      o
        .setName('clear_stop')
        .setDescription('Remove the entered stop; disable negative-return prompts'),
    )
    .addNumberOption((o) =>
      o
        .setName('fees')
        .setDescription('Round-trip dollars per contract')
        .setMinValue(0)
        .setMaxValue(10000),
    ),
);
thresholdCommand.addSubcommand((s) =>
  s.setName('list').setDescription('List active shared monitors and eligibility'),
);
for (const action of ['show', 'snooze', 'stop'])
  thresholdCommand.addSubcommand((s) =>
    s
      .setName(action)
      .setDescription(
        action === 'show'
          ? 'Inspect rules, measurements and forward review records'
          : action === 'snooze'
            ? 'Request one reminder after one additional market hour'
            : 'Stop monitoring; does not imply a sale',
      )
      .addStringOption((o) =>
        o.setName('id').setDescription('Monitor ID').setRequired(true).setAutocomplete(true),
      ),
  );
thresholdCommand.addSubcommand((s) =>
  s
    .setName('config')
    .setDescription('Manager/admin settings; changes start fresh observation windows')
    .addBooleanOption((o) => o.setName('enabled').setDescription('Master threshold feature switch'))
    .addBooleanOption((o) => o.setName('ideas').setDescription('Automatic confirmed-idea monitors'))
    .addBooleanOption((o) =>
      o.setName('contracts').setDescription('Member-registered contract monitors'),
    )
    .addNumberOption((o) =>
      o
        .setName('hours')
        .setDescription('Market hours without meaningful progress; default 4')
        .setMinValue(1)
        .setMaxValue(24),
    )
    .addNumberOption((o) =>
      o
        .setName('progress_atr')
        .setDescription('Favorable progress in frozen daily ATR; default 0.25')
        .setMinValue(0.05)
        .setMaxValue(2),
    )
    .addNumberOption((o) =>
      o
        .setName('contract_loss_percent')
        .setDescription('Maximum contract loss percent; default 5')
        .setMinValue(0)
        .setMaxValue(20),
    )
    .addNumberOption((o) =>
      o
        .setName('idea_loss_r')
        .setDescription('Maximum idea loss in R; default 0.05')
        .setMinValue(0)
        .setMaxValue(0.5),
    ),
);

export async function handleThreshold(
  i: ChatInputCommandInteraction,
  store: Store,
  manager: boolean,
  now: number,
): Promise<void> {
  const state = new ThresholdStore(store),
    sub = i.options.getSubcommand();
  if (sub === 'config') {
    if (!manager)
      throw new Error(
        'An administrator or configured manager role is required for threshold configuration.',
      );
    const patch: Partial<ThresholdConfig> = {};
    for (const key of ['enabled', 'ideas', 'contracts'] as const) {
      const value = i.options.getBoolean(key);
      if (value !== null) patch[key] = value;
    }
    for (const [option, key] of [
      ['hours', 'hours'],
      ['progress_atr', 'progressAtr'],
      ['contract_loss_percent', 'contractLossPercent'],
      ['idea_loss_r', 'ideaLossR'],
    ] as const) {
      const value = i.options.getNumber(option);
      if (value !== null) patch[key] = value;
    }
    if (
      store.get('budget_paused', false) &&
      Object.entries(patch).some(
        ([k, v]) => !['enabled', 'ideas', 'contracts'].includes(k) || v !== false,
      )
    )
      throw new Error('Resource budget exhausted; only disabling threshold switches is available.');
    const config = Object.keys(patch).length
      ? state.configure(patch, i.user.id, now)
      : state.config();
    await report(i, 'Threshold settings. Rule changes start a fresh observation window.', config);
    return;
  }
  if (sub === 'list') {
    const rows = state.all();
    await report(
      i,
      rows
        .map(
          (m) =>
            `${m.id} · ${m.contract ?? m.instrument.symbol} · ${m.mode} · ${m.owner ?? 'shared'} · ${m.status} · ${m.observation?.reason ?? 'AWAITING_DATA'}`,
        )
        .join('\n') || 'No active threshold monitors.',
      rows,
    );
    return;
  }
  const id = sub === 'add' ? undefined : i.options.getString('id', true);
  if (sub === 'show') {
    const m = state.get(id!);
    if (!m) throw new Error('Unknown threshold monitor ID.');
    await report(
      i,
      `${m.contract ?? m.instrument.symbol} · ${m.status} · ${m.observation?.reason ?? 'AWAITING_DATA'}\n${m.mode === 'contract' ? 'Indicative estimated P&L; check your broker.' : 'Signal-reference movement; not personal contract P&L.'}`,
      { monitor: m, reviews: state.reviews(id) },
    );
    return;
  }
  if (store.get('budget_paused', false) && sub !== 'stop')
    throw new Error('Free-plan resource budget exhausted; monitoring changes are paused.');
  if (sub === 'add') {
    const m = state.register(
      {
        contract: i.options.getString('contract', true),
        entry: i.options.getNumber('entry', true),
        quantity: i.options.getInteger('quantity') ?? undefined,
        stop: i.options.getNumber('stop') ?? undefined,
        fees: i.options.getNumber('fees') ?? undefined,
        ideaId: i.options.getString('idea') ?? undefined,
      },
      i.user.id,
      now,
    );
    await i.editReply(
      `Monitor ${m.id} registered. Future alert details, including entry and estimated P&L, appear publicly in the updates channel. Long standard 100-share contracts only. No order is placed. ${m.fees === undefined ? 'Fees not included.' : 'Entered round-trip fees included.'} ${m.stop === undefined ? 'Negative-return prompts require an entered stop.' : ''} ${state.config().enabled && state.config().contracts ? 'Awaiting fresh monitoring data.' : 'Contract alerts are currently disabled.'}`,
    );
    return;
  }
  if (sub === 'edit') {
    const stop = i.options.getNumber('stop'),
      clear = i.options.getBoolean('clear_stop');
    if (clear && stop !== null) throw new Error('Choose stop or clear_stop, not both.');
    const m = state.edit(
      id!,
      {
        entry: i.options.getNumber('entry') ?? undefined,
        quantity: i.options.getInteger('quantity') ?? undefined,
        stop: clear ? null : (stop ?? undefined),
        fees: i.options.getNumber('fees') ?? undefined,
      },
      i.user.id,
      manager,
      now,
    );
    await report(
      i,
      `Monitor ${m.id} · ${m.status}. Effective changes restart its observation window; no order is placed.`,
      m,
    );
    return;
  }
  if (sub === 'stop') {
    state.stop(id!, i.user.id, manager, now);
    await i.editReply('Threshold monitoring stopped. No sale is recorded or executed.');
    return;
  }
  if (sub === 'snooze') {
    state.snooze(id!, i.user.id, manager, now);
    await i.editReply(
      'One reminder requested after one additional market hour, if the same stall still qualifies.',
    );
    return;
  }
  throw new Error('Unknown threshold action.');
}
async function report(i: ChatInputCommandInteraction, content: string, value: unknown) {
  await i.editReply({
    content: content.slice(0, 1850),
    files: [{ attachment: Buffer.from(JSON.stringify(value, null, 2)), name: 'threshold.json' }],
  });
}
const signed = (v: number | undefined, suffix = '%') =>
  v === undefined ? 'unavailable' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}${suffix}`;
export function thresholdCard(event: SignalEvent): EmbedBuilder {
  const a = event.threshold!,
    m = a.monitor,
    o = a.observation;
  const embed = new EmbedBuilder()
    .setTitle(`${m.instrument.symbol} · Threshold reached · Exit review`)
    .setColor(0xd4a348)
    .setDescription(
      `No meaningful favorable progress for ${o.elapsedHours.toFixed(2)} market hours. Consider reviewing whether to close or continue holding.\n${m.mode === 'contract' ? 'Indicative estimated P&L; check your broker’s current quote before deciding.' : 'Signal-reference movement; not personal contract P&L.'}`,
    )
    .addFields(
      {
        name: m.mode === 'contract' ? 'Registered long contract' : 'Automatic idea',
        value: m.contract ?? m.ideaId!,
      },
      {
        name:
          m.mode === 'contract' ? 'Indicative estimated return' : 'Directional reference return',
        value: `${signed(o.returnPercent)}${o.rMultiple === undefined ? '' : ` · ${signed(o.rMultiple, 'R')}`}`,
        inline: true,
      },
      { name: 'Observed peak since tracking', value: signed(o.peakPercent), inline: true },
      {
        name: 'Underlying range contraction',
        value:
          o.contractionRatio === undefined
            ? 'Contraction unavailable'
            : `${o.contractionRatio.toFixed(2)}× usual candle range${o.contractionRatio <= 0.5 ? ' · contracted' : ''}`,
      },
      {
        name: 'Review controls',
        value: `/threshold show id:${m.id}\n/threshold snooze id:${m.id}\n/threshold stop id:${m.id}`,
      },
      {
        name: 'Underlying data',
        value: `${o.provenance.provider} · ${o.provenance.feed} · minimum delay ${o.provenance.delayMinutes}m · age at evaluation ${Math.max(0, (event.recordedAt - o.marketTime) / 60000).toFixed(0)}m\n${new Date(o.marketTime).toISOString()}`,
      },
    );
  if (m.mode === 'contract')
    embed.addFields(
      {
        name: 'Position reference',
        value: `Owner: ${m.owner} · ${m.quantity} contract(s) · entry $${m.entry.toFixed(4)}\n${m.fees === undefined ? 'Fees not included' : `Round-trip fees $${m.fees.toFixed(2)} per contract`} · estimated net $${o.estimatedNet?.toFixed(2)}`,
      },
      {
        name: 'Stop and quote',
        value: `Entered premium stop: ${m.stop === undefined ? 'not supplied' : `$${m.stop.toFixed(4)}`} · indicative bid $${o.quote!.bid.toFixed(4)} / ask $${o.quote!.ask.toFixed(4)}\nModified indicative quote · ${new Date(o.quote!.asOf).toISOString()} · age at evaluation ${Math.max(0, (event.recordedAt - o.quote!.asOf) / 60000).toFixed(0)}m`,
      },
    );
  return embed
    .setTimestamp(o.marketTime)
    .setFooter({ text: `Review only; no orders · monitor ${m.id} · event ${event.id}` });
}
