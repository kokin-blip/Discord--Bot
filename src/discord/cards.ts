import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { OptionsContext, SignalEvent } from '../domain.js';
const price = (n: number | undefined) =>
  n === undefined
    ? 'Awaiting confirmation'
    : n.toLocaleString('en-US', { maximumFractionDigits: 6 });
export function tradingView(symbol: string, market: string) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(market === 'crypto' ? `COINBASE:${symbol.replace('-', '')}` : symbol)}`;
}
export function card(e: SignalEvent, options: OptionsContext[] = []): EmbedBuilder {
  const c = e.candidate,
    rr =
      c.entry !== undefined && c.target !== undefined
        ? Math.abs((c.target - c.entry) / (c.entry - c.level))
        : c.provisionalRR;
  const embed = new EmbedBuilder()
    .setColor(
      e.state === 'invalidated' ? 0xef6571 : c.direction === 'bullish' ? 0x22c6a8 : 0xe9b35d,
    )
    .setTitle(
      `${e.instrument.symbol} · ${e.direction.toUpperCase()} · ${e.state.replaceAll('_', ' ').toUpperCase()}`,
    )
    .setDescription([...e.reasons, ...(e.observations ?? [])].join('\n').slice(0, 2000))
    .addFields(
      { name: 'Setup', value: 'Weekly base → daily retest → 15-minute confirmation' },
      { name: 'Entry reference', value: price(c.entry), inline: true },
      {
        name: 'Invalidation',
        value: `15m close ${e.direction === 'bullish' ? 'below' : 'above'} ${price(c.level)}`,
        inline: true,
      },
      {
        name: 'Targets',
        value:
          c.targets?.map((t, i) => `T${i + 1}: ${price(t)}`).join(' · ') ?? 'Finalized at entry',
      },
      {
        name: 'Planned reward/risk',
        value: `${rr.toFixed(2)}R${c.entry === undefined ? ' · provisional' : ''}`,
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
