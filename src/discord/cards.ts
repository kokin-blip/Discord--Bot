import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { OptionsContext, SignalEvent } from '../domain.js';
import { referenceGeometry } from '../core/geometry.js';
const price = (n: number | undefined) =>
  n === undefined
    ? 'Awaiting confirmation'
    : n.toLocaleString('en-US', { maximumFractionDigits: 6 });
export function tradingView(symbol: string, market: string) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(market === 'crypto' ? `COINBASE:${symbol.replace('-', '')}` : symbol)}`;
}
export function card(e: SignalEvent, options: OptionsContext[] = []): EmbedBuilder {
  const c = e.candidate,
    geometry = referenceGeometry(c),
    stage =
      e.kind === 'setup_snapshot'
        ? 'CURRENT SETUP SNAPSHOT'
        : e.state === 'watching'
          ? 'POSSIBLE SETUP · AWAITING RETEST'
          : e.state === 'setup_ready'
            ? 'SETUP READY · AWAITING ENTRY'
            : e.state === 'entry_triggered'
              ? 'ENTRY CONFIRMED'
              : e.state.replaceAll('_', ' ').toUpperCase();
  const embed = new EmbedBuilder()
    .setColor(
      e.state === 'invalidated' ? 0xef6571 : c.direction === 'bullish' ? 0x22c6a8 : 0xe9b35d,
    )
    .setTitle(`${e.instrument.symbol} · ${e.direction.toUpperCase()} · ${stage}`)
    .setDescription(
      [...new Set([...c.reasons, ...e.reasons]), ...(e.observations ?? [])]
        .join('\n')
        .slice(0, 2000),
    )
    .addFields(
      { name: 'Setup', value: 'Weekly base → daily retest → 15-minute confirmation' },
      {
        name: geometry.provisional ? 'Hypothetical entry · 0.5 ATR' : 'Entry signal reference',
        value: price(geometry.entry),
        inline: true,
      },
      {
        name: 'Invalidation',
        value: `15m close ${e.direction === 'bullish' ? 'below' : 'above'} ${price(c.level)}`,
        inline: true,
      },
      {
        name: 'Targets',
        value: `${geometry.provisional ? 'Provisional: ' : ''}${geometry.targets.map((t, i) => `${i === 2 ? 'Final' : `${i + 1}R`}: ${price(t)}`).join(' · ')}`,
      },
      {
        name: 'Planned reward/risk',
        value: `${geometry.rr.toFixed(2)}:1${geometry.provisional ? ' · provisional, recalculated at entry' : ''}`,
        inline: true,
      },
      {
        name: 'Data',
        value: `${e.provenance.provider} / ${e.provenance.feed}\n${new Date(e.provenance.asOf).toISOString()}\nAge at display: ${Math.max(0, (Date.now() - e.provenance.asOf) / 60_000).toFixed(0)}m · feed minimum: ${e.provenance.delayMinutes}m`,
      },
      {
        name: 'Interpretation',
        value: `Experimental strategy. Prices are references, not fills.${e.instrument.market === 'crypto' && e.direction === 'bearish' ? ' Bearish spot thesis; no short availability implied.' : ''}`,
      },
    )
    .setTimestamp(e.marketTime)
    .setFooter({ text: `${e.strategyVersion} · idea ${e.ideaId} · event ${e.id}` });
  if (geometry.provisional) {
    embed.addFields({
      name: 'Entry condition',
      value: c.retest
        ? `Completed 15m close ${e.direction === 'bullish' ? 'above' : 'below'} ${price(e.direction === 'bullish' ? c.retest.high : c.retest.low)}; chase and minimum R/R checks must also pass.`
        : 'Awaiting a qualifying daily retest. No confirmed entry yet.',
    });
    if (e.setupContext)
      embed.addFields(
        {
          name: 'Allowed entry band',
          value: `${price(e.setupContext.entryBand[0])}–${price(e.setupContext.entryBand[1])}`,
          inline: true,
        },
        {
          name: c.retest ? 'Confirmation window' : 'Retest window',
          value: `${e.setupContext.remainingSessions}/${e.setupContext.totalSessions} daily sessions remaining at signal time`,
          inline: true,
        },
      );
  }
  if (options.length)
    embed.addFields({
      name: 'Optional options context · indicative/delayed',
      value: options
        .map(
          (o) =>
            `${o.contract} (${o.expiry})${o.iv === undefined ? '' : ` · IV ${(o.iv * 100).toFixed(1)}%`}${o.delta === undefined ? '' : ` · Δ ${o.delta.toFixed(2)}`}${o.asOf ? ` · ${new Date(o.asOf).toISOString()}` : ''}`,
        )
        .join('\n')
        .slice(0, 1000),
    });
  return embed;
}
export function buttons(e: SignalEvent) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Open TradingView')
      .setStyle(ButtonStyle.Link)
      .setURL(tradingView(e.instrument.symbol, e.instrument.market)),
  );
}
