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
  if (e.state === 'entry_triggered')
    embed.addFields({
      name: 'Entry price interpretation',
      value: `The minimum chase distance is 0.1 ATR and the maximum is 1 ATR beyond the breakout level. Confirmation must also close ${e.direction === 'bullish' ? 'above the retest high' : 'below the retest low'} and meet the configured minimum R/R. These are candle-close references, not a live quote or guaranteed fill.`,
    });
  if (e.performance)
    embed.addFields({ name: 'Signal performance · completed close', value: performanceText(e) });
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
const signed = (n: number, suffix: string) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}${suffix}`;
function performanceText(e: SignalEvent): string {
  const p = e.performance!;
  return `${signed(p.changePercent, '%')} · ${signed(p.rMultiple, 'R')}\nLatest completed close: $${price(p.referencePrice)}\nDirectional move from entry reference; not realized P/L.${p.ambiguous ? ' Intrabar ordering unknown.' : ''}`;
}
function reachedLevels(e: SignalEvent): string {
  const targets = referenceGeometry(e.candidate).targets;
  const fallback =
    e.state === 'target_1'
      ? [0]
      : e.state === 'target_2'
        ? [0, 1]
        : e.state === 'final_target'
          ? [0, 1, 2]
          : [];
  const reached = e.performance?.reachedTargets ?? fallback;
  return targets
    .map((target, index) => {
      const text = `${index === 2 ? 'Final' : `${index + 1}R`}: $${price(target)}`;
      return reached.includes(index) ? `~~${text}~~` : text;
    })
    .join(' · ');
}
export function isConfirmedExit(e: SignalEvent): boolean {
  return (
    e.candidate.entry !== undefined &&
    ['final_target', 'invalidated', 'time_exit'].includes(e.state)
  );
}

/** Compact public entry; the full qualification record is published in its thread. */
export function publicCard(e: SignalEvent, options: OptionsContext[] = []): EmbedBuilder {
  if (e.candidate.entry !== undefined && ['target_1', 'target_2'].includes(e.state)) {
    return new EmbedBuilder()
      .setColor(0x22c6a8)
      .setTitle(
        `UPDATE · ${e.instrument.symbol} · ${e.direction === 'bullish' ? 'LONG' : 'SHORT'}${e.performance ? ` · ${signed(e.performance.changePercent, '%')}` : ''}`,
      )
      .setDescription(
        `${e.state === 'target_1' ? '1R' : '2R'} target touched. The idea remains active.\n${(e.observations ?? []).join('\n')}`,
      )
      .addFields(
        { name: 'Entry reference', value: `$${price(e.candidate.entry)}`, inline: true },
        { name: 'Target progress', value: reachedLevels(e) },
        ...(e.performance ? [{ name: 'Signal performance', value: performanceText(e) }] : []),
        {
          name: 'Data',
          value: `Age at display: ${Math.max(0, (Date.now() - e.marketTime) / 60000).toFixed(0)}m · feed minimum: ${e.provenance.delayMinutes}m\n${new Date(e.marketTime).toISOString()}`,
        },
      )
      .setTimestamp(e.marketTime)
      .setFooter({
        text: `Target touch, not a fill · ${e.strategyVersion} · idea ${e.ideaId} · event ${e.id}`,
      });
  }
  if (isConfirmedExit(e)) {
    const reason =
      e.state === 'final_target'
        ? 'Final target reached.'
        : e.state === 'invalidated'
          ? `Completed 15m close ${e.direction === 'bullish' ? 'below' : 'above'} the invalidation level.`
          : 'The strategy holding window ended.';
    const geometry = referenceGeometry(e.candidate);
    return new EmbedBuilder()
      .setColor(
        e.state === 'invalidated' || (e.performance?.changePercent ?? 0) < 0 ? 0xef6571 : 0x22c6a8,
      )
      .setTitle(
        `${e.direction === 'bullish' ? 'SELL RECOMMENDED NOW 💰' : 'EXIT RECOMMENDED NOW 💰'} · ${e.instrument.symbol}${e.performance ? ` · ${signed(e.performance.changePercent, '%')}` : ''}`,
      )
      .setDescription(
        [
          reason,
          ...(e.observations ?? []),
          'You may hold at your own discretion. Full exit reasoning is in the thread.',
        ].join('\n'),
      )
      .addFields(
        { name: 'Original entry reference', value: `$${price(geometry.entry)}`, inline: true },
        { name: 'Invalidation level', value: `$${price(e.candidate.level)}`, inline: true },
        { name: 'Target progress', value: reachedLevels(e) },
        ...(e.performance ? [{ name: 'Signal performance', value: performanceText(e) }] : []),
        {
          name: 'Data',
          value: `Age at display: ${Math.max(0, (Date.now() - e.provenance.asOf) / 60000).toFixed(0)}m · feed minimum: ${e.provenance.delayMinutes}m\n${new Date(e.provenance.asOf).toISOString()}`,
        },
      )
      .setTimestamp(e.marketTime)
      .setFooter({
        text: `Exit signal, not an execution · ${e.strategyVersion} · idea ${e.ideaId} · event ${e.id}`,
      });
  }
  if (e.state !== 'entry_triggered') return card(e, options);
  const c = e.candidate,
    geometry = referenceGeometry(c);
  const bullish = e.direction === 'bullish';
  const lower = bullish ? c.level + 0.1 * c.atr : c.level - c.atr;
  const upper = bullish ? c.level + c.atr : c.level - 0.1 * c.atr;
  const minimum = bullish ? Math.max(lower, c.retest?.high ?? lower) : lower;
  return new EmbedBuilder()
    .setColor(bullish ? 0x22c6a8 : 0xe9b35d)
    .setTitle(`${bullish ? 'BUY IN NOW ✅' : 'BUY IN NOW ❎ · SHORT'} · ${e.instrument.symbol}`)
    .setDescription(
      `${bullish ? '' : 'Recommended SHORT position — not a long purchase. '}${!bullish && e.instrument.market === 'crypto' ? 'Directional thesis; spot short availability is not implied. ' : ''}Completed 15m close confirmed the ${bullish ? 'breakout' : 'breakdown'} retest. Volume, trend and reward/risk checks passed. Full reasoning in the thread.`,
    )
    .addFields(
      { name: 'Entry reference', value: `$${price(geometry.entry)}`, inline: true },
      { name: 'R/R', value: `${Number(geometry.rr.toFixed(2))}:1`, inline: true },
      {
        name: bullish ? 'Minimum buy-in reference' : 'Entry price band',
        value: bullish
          ? `$${price(minimum)} · max $${price(upper)}`
          : `$${price(lower)}–$${price(upper)}`,
        inline: true,
      },
      {
        name: 'Invalidation',
        value: `15m close ${bullish ? 'below' : 'above'} $${price(c.level)}`,
        inline: true,
      },
      {
        name: 'Targets',
        value: geometry.targets
          .map((t, i) => `${i === 2 ? 'Final' : `${i + 1}R`}: $${price(t)}`)
          .join(' · '),
      },
      {
        name: 'Data',
        value: `Age at display: ${Math.max(0, (Date.now() - e.provenance.asOf) / 60000).toFixed(0)}m · feed minimum: ${e.provenance.delayMinutes}m\n${new Date(e.provenance.asOf).toISOString()}`,
      },
    )
    .setTimestamp(e.marketTime)
    .setFooter({
      text: `Signal references, not fills · ${e.strategyVersion} · idea ${e.ideaId} · event ${e.id}`,
    });
}

export function buttons(e: SignalEvent) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Open TradingView')
      .setStyle(ButtonStyle.Link)
      .setURL(tradingView(e.instrument.symbol, e.instrument.market)),
  );
}

export function trackerCard(e: SignalEvent): EmbedBuilder {
  const t = e.tracker;
  if (!t) throw new Error('MISSING_TRACKER_DETAILS');
  const timeframe = t.timeframe === '1d' ? 'Daily' : '15-minute';
  const embed = new EmbedBuilder()
    .setColor(
      t.type === 'volume'
        ? t.pressure === 'neutral'
          ? 0x87939d
          : t.pressure === 'buying'
            ? 0x22c6a8
            : 0xe9b35d
        : e.direction === 'bullish'
          ? 0x22c6a8
          : 0xe9b35d,
    )
    .setTitle(
      `${e.debug ? 'DEBUG TEST · SYNTHETIC · ' : ''}${e.instrument.symbol} · ${timeframe} · ${t.type === 'volume' ? `${t.pressure.toUpperCase()} PRESSURE · VOLUME SPIKE` : `${e.direction.toUpperCase()} REVERSAL ${t.phase.toUpperCase()}`}`,
    )
    .setDescription(
      t.type === 'volume'
        ? `${e.debug ? 'DELIVERY TEST ONLY: invented prices and volume. ' : ''}Unusual market activity; this is not a trade entry signal. Pressure is estimated from candle direction, not measured buyer/seller volume.`
        : 'Experimental market-structure tracker; separate from the breakout strategy. This is not a trade entry signal.',
    )
    .addFields({ name: 'Closing price', value: price(t.close), inline: true });
  if (t.type === 'volume')
    embed.addFields(
      {
        name: 'Estimated volume pressure',
        value: `${t.pressure} · candle ${t.pressure === 'buying' ? 'closed above its open' : t.pressure === 'selling' ? 'closed below its open' : 'closed at its open'}. Total volume; no aggressor-side breakdown.`,
      },
      { name: 'Observed volume', value: price(t.volume), inline: true },
      {
        name: `${t.baselineDays}-day baseline`,
        value: `${price(t.baseline)}${t.timeframe === '15m' ? ' · matching session time slot' : ' · prior completed daily candles'}`,
        inline: true,
      },
      {
        name: 'Relative volume',
        value: `${t.relativeVolume.toFixed(2)}× (threshold ${t.multiplier}×)`,
        inline: true,
      },
      {
        name: 'Price change from previous close',
        value: `${t.priceChange >= 0 ? '+' : ''}${price(t.priceChange)} (${t.priceChangePercent.toFixed(2)}%)`,
        inline: true,
      },
    );
  else
    embed.addFields(
      {
        name: 'Frozen swing levels',
        value: `Low ${price(t.frozenLow)} · High ${price(t.frozenHigh)}`,
      },
      {
        name: 'Confirmation condition',
        value: `Later completed ${timeframe.toLowerCase()} close ${e.direction === 'bullish' ? 'above' : 'below'} ${price(e.direction === 'bullish' ? t.frozenHigh : t.frozenLow)} within ${t.confirmationBars} candles`,
      },
      {
        name: 'Cancellation condition',
        value: `Completed close ${e.direction === 'bullish' ? 'below' : 'above'} ${price(t.cancellationLevel)}; cancellation takes precedence`,
      },
      {
        name: 'Warning correlation',
        value: `${t.warningId} · ${new Date(t.warningTime).toISOString()} · ${t.elapsed}/${t.confirmationBars} candles elapsed`,
      },
    );
  if (
    t.type === 'reversal' &&
    t.phase !== 'warning' &&
    t.warningClose !== undefined &&
    t.directionalChangePercent !== undefined
  )
    embed.addFields({
      name: 'Hypothetical move since warning',
      value: `**${signed(t.directionalChangePercent, '%')}** · ${e.direction === 'bullish' ? 'long' : 'short'} direction\nWarning close: $${price(t.warningClose)} → update close: $${price(t.close)}\nReference prices, not fills or realized profit; excludes fees and leverage. The warning was not an entry signal.`,
    });
  return embed
    .addFields({
      name: 'Data',
      value: `${e.provenance.provider} / ${e.provenance.feed}\n${new Date(e.marketTime).toISOString()}\nAge at display: ${Math.max(0, (Date.now() - e.marketTime) / 60000).toFixed(0)}m · feed minimum ${e.provenance.delayMinutes}m`,
    })
    .setTimestamp(e.marketTime)
    .setFooter({ text: `${e.strategyVersion} · event ${e.id}` });
}
