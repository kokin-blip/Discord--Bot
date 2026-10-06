import type { Candidate, Dataset, SignalEvent } from './domain.js';
import { referenceGeometry } from './core/geometry.js';
export async function chartSnapshot(
  launch: () => Promise<any>,
  library: string,
  data: Dataset,
  candidate?: Candidate,
  tracker?: SignalEvent,
): Promise<Buffer> {
  const browser = await launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 920 },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route: { abort(): Promise<void> }) => route.abort()); // Chart snapshots make no external requests.
    await page.setContent(
      `<html><head><style>
        *{box-sizing:border-box} body{margin:0;background:#0d0e10;color:#e0e3e8;font-family:Arial}
        header{height:82px;padding:16px 24px;border-bottom:1px solid #24262b}
        #title{font-size:21px;font-weight:600} #details{margin-top:7px;color:#a5a9b2;font-size:12px}
        section{position:relative} .label{position:absolute;z-index:2;top:12px;left:24px;font-size:12px;color:#c3c7ce;pointer-events:none}
        .metrics{position:absolute;z-index:2;top:12px;right:110px;color:#a5a9b2;font-size:12px;pointer-events:none} .watermark{position:absolute;z-index:2;left:0;right:100px;top:42%;text-align:center;color:#ffffff18;font-size:48px;font-weight:600;pointer-events:none}
        #context{border-top:1px solid #24262b} footer{height:48px;padding:10px 24px;color:#a5a9b2;font-size:11px;line-height:16px}
        </style></head><body><header><strong id="title"></strong><div id="details"></div></header>
        <section><div class="label" id="right-label">DAILY SETUP</div><div class="metrics" id="metrics"></div><div class="watermark" id="watermark"></div><div id="daily"></div></section>
        <section id="context"><div class="label" id="left-label">WEEKLY CONTEXT</div><div id="weekly"></div></section>
        <footer>Charts powered by TradingView Lightweight Charts · tradingview.com<br>Signal references only · no order execution or fills implied</footer></body></html>`,
    );
    // Serialized TypeScript callbacks may contain esbuild's function-name helper.
    await page.addScriptTag({ content: 'globalThis.__name = (fn) => fn;\n' + library });
    await page.evaluate(
      ({
        daily,
        weekly,
        c,
        geometry,
        title,
        details,
        tracker,
      }: {
        daily: Dataset['daily'];
        weekly: Dataset['weekly'];
        c?: Candidate;
        geometry?: ReturnType<typeof referenceGeometry>;
        title: string;
        details: string;
        tracker?: SignalEvent;
      }) => {
        const L = (window as unknown as { LightweightCharts: any }).LightweightCharts;
        document.getElementById('title')!.textContent = title;
        document.getElementById('details')!.textContent = details;
        document.getElementById('watermark')!.textContent =
          title.split(' · ')[tracker?.debug ? 1 : 0]! +
          (tracker?.tracker?.timeframe === '15m' ? ' · 15m' : ' · 1D');
        const intradayTracker = tracker?.tracker?.timeframe === '15m';
        const lastBar = daily.at(-1);
        const format = (value: number) =>
          value.toLocaleString('en-US', { maximumFractionDigits: 2 });
        document.getElementById('metrics')!.textContent =
          tracker?.tracker?.type === 'volume'
            ? `Volume ${format(tracker.tracker.volume)} · ${tracker.tracker.relativeVolume.toFixed(1)}× · ${tracker.tracker.baselineDays}d baseline ${format(tracker.tracker.baseline)}`
            : lastBar
              ? `O ${format(lastBar.open)}   H ${format(lastBar.high)}   L ${format(lastBar.low)}   C ${format(lastBar.close)}`
              : '';
        document.getElementById('left-label')!.textContent = intradayTracker
          ? 'DAILY CONTEXT'
          : 'WEEKLY CONTEXT';
        document.getElementById('right-label')!.textContent = tracker
          ? intradayTracker
            ? '15-MINUTE ACTIVITY'
            : 'DAILY ACTIVITY'
          : 'DAILY SETUP';
        for (const [id, bars] of [
          ['weekly', weekly],
          ['daily', daily],
        ] as const) {
          const chart = L.createChart(document.getElementById(id), {
            width: 1200,
            height: id === 'daily' ? 610 : 180,
            layout: {
              background: { color: '#0d0e10' },
              textColor: '#a5a9b2',
              fontFamily: 'Arial',
              fontSize: 12,
              attributionLogo: true,
            },
            grid: { vertLines: { visible: false }, horzLines: { color: '#ffffff06' } },
            timeScale: { timeVisible: intradayTracker && id === 'daily', rightOffset: 10 },
            rightPriceScale: {
              borderVisible: false,
              minimumWidth: 100,
              scaleMargins: {
                top: id === 'daily' ? 0.12 : 0.25,
                bottom: id === 'daily' ? 0.25 : 0.1,
              },
            },
            crosshair: { mode: 0 },
          });
          const candles = chart.addSeries(L.CandlestickSeries, {
            upColor: '#26a69a',
            downColor: '#ef5350',
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
            borderVisible: false,
          });
          candles.setData(
            bars.map((b) => ({
              time: b.start / 1000,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
            })),
          );
          const volume = chart.addSeries(L.HistogramSeries, {
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
            lastValueVisible: false,
            priceLineVisible: false,
            visible: id === 'daily',
          });
          volume
            .priceScale()
            .applyOptions({ scaleMargins: { top: 0.79, bottom: 0 }, visible: false });
          volume.setData(
            bars.map((b) => ({
              time: b.start / 1000,
              value: b.volume,
              color:
                tracker && id === 'daily' && b.end === tracker.marketTime
                  ? '#e9b35d'
                  : b.close >= b.open
                    ? '#26a69a70'
                    : '#ef535070',
            })),
          );
          for (const period of id === 'weekly' && !intradayTracker ? [30] : [10, 20, 50]) {
            const average = chart.addSeries(L.LineSeries, {
              color:
                period === 30 || period === 50 ? '#caac6c' : period === 10 ? '#57a8f1' : '#b293df',
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            });
            average.setData(
              bars.flatMap((b, i) =>
                i + 1 >= period
                  ? [
                      {
                        time: b.start / 1000,
                        value:
                          bars.slice(i + 1 - period, i + 1).reduce((a, x) => a + x.close, 0) /
                          period,
                      },
                    ]
                  : [],
              ),
            );
          }
          if (c && id === 'daily') {
            candles.applyOptions({
              autoscaleInfoProvider: (original: () => any) => {
                const info = original();
                if (info) {
                  const levels = [
                    c.baseLow,
                    c.baseHigh,
                    geometry?.entry,
                    ...(geometry?.targets ?? []),
                  ].filter((x): x is number => x !== undefined);
                  info.priceRange.minValue = Math.min(info.priceRange.minValue, ...levels);
                  info.priceRange.maxValue = Math.max(info.priceRange.maxValue, ...levels);
                }
                return info;
              },
            });
            for (const [price, label, color] of [
              [c.baseHigh, 'Base high', '#63748d'],
              [c.baseLow, 'Base low', '#63748d'],
              [c.level, 'Invalidation close', '#e9b35d'],
              [
                geometry?.entry,
                geometry?.provisional ? 'Provisional entry' : 'Entry reference',
                '#57a8f1',
              ],
              [
                c.retest ? (c.direction === 'bullish' ? c.retest.high : c.retest.low) : undefined,
                '15m trigger',
                '#b293df',
              ],
              ...(geometry?.targets ?? []).map((t: number, i: number) => [
                t,
                `${geometry?.provisional ? 'Provisional ' : ''}T${i + 1}`,
                '#26a69a',
              ]),
            ] as [number | undefined, string, string][]) {
              if (price !== undefined && !(label.startsWith('Base') && price === c.level))
                candles.createPriceLine({
                  price,
                  color,
                  lineWidth: 1,
                  lineStyle: 2,
                  axisLabelVisible: true,
                  title: label,
                });
            }
            if (id === 'daily') {
              L.createSeriesMarkers(candles, [
                {
                  time: c.breakout.start / 1000,
                  position: c.direction === 'bullish' ? 'belowBar' : 'aboveBar',
                  color: '#e9b35d',
                  shape: c.direction === 'bullish' ? 'arrowUp' : 'arrowDown',
                  text: c.direction === 'bullish' ? 'Breakout' : 'Breakdown',
                },
                ...(c.retest
                  ? [
                      {
                        time: c.retest.start / 1000,
                        position: c.direction === 'bullish' ? 'belowBar' : 'aboveBar',
                        color: '#57a8f1',
                        shape: 'circle',
                        text: 'Retest',
                      },
                    ]
                  : []),
              ]);
            }
          }
          if (tracker?.tracker && id === 'daily' && bars.length) {
            const t = tracker.tracker;
            const last = bars.at(-1)!;
            const color =
              t.type === 'volume'
                ? t.pressure === 'buying'
                  ? '#26a69a'
                  : t.pressure === 'selling'
                    ? '#ef5350'
                    : '#a8b4c4'
                : tracker.direction === 'bullish'
                  ? '#26a69a'
                  : '#ef5350';
            L.createSeriesMarkers(candles, [
              {
                time: last.start / 1000,
                position: 'aboveBar',
                color,
                shape: 'circle',
                text:
                  t.type === 'volume'
                    ? `${t.relativeVolume.toFixed(1)}× vol`
                    : t.phase[0]!.toUpperCase() + t.phase.slice(1),
              },
            ]);
            if (t.type === 'volume')
              volume.createPriceLine({
                price: t.baseline,
                title: `${t.baselineDays}-day baseline`,
                color: '#e9b35d',
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: false,
              });
            if (t.type === 'reversal') {
              for (const [price, title, lineColor] of [
                [t.frozenHigh, 'Frozen swing high', '#57a8f1'],
                [t.frozenLow, 'Frozen swing low', '#b293df'],
                [t.cancellationLevel, 'Warning cancellation close', '#ef5350'],
              ] as [number, string, string][])
                candles.createPriceLine({
                  price,
                  title,
                  color: lineColor,
                  lineWidth: 1,
                  lineStyle: 2,
                  axisLabelVisible: true,
                });
              candles.applyOptions({
                autoscaleInfoProvider: (original: () => any) => {
                  const info = original();
                  if (info) {
                    info.priceRange.minValue = Math.min(
                      info.priceRange.minValue,
                      t.frozenLow,
                      t.cancellationLevel,
                    );
                    info.priceRange.maxValue = Math.max(
                      info.priceRange.maxValue,
                      t.frozenHigh,
                      t.cancellationLevel,
                    );
                  }
                  return info;
                },
              });
            }
          }
          chart.timeScale().setVisibleLogicalRange({
            from:
              tracker && bars.length < 10
                ? -5
                : id === 'daily'
                  ? Math.max(0, bars.length - 70)
                  : Math.max(0, bars.length - 45),
            to: bars.length + 10,
          });
        }
      },
      {
        daily:
          tracker?.tracker?.timeframe === '15m' ? data.intraday.slice(-96) : data.daily.slice(-100),
        weekly:
          tracker?.tracker?.timeframe === '15m' ? data.daily.slice(-100) : data.weekly.slice(-60),
        tracker,
        c: candidate,
        geometry: candidate ? referenceGeometry(candidate) : undefined,
        title: tracker?.debug
          ? `SYNTHETIC DEBUG TEST · ${data.instrument.symbol} · VOLUME ALERT`
          : `${data.instrument.symbol} · ${tracker ? (tracker.tracker?.type === 'volume' ? `${tracker.tracker.pressure.toUpperCase()} PRESSURE · VOLUME SPIKE` : `${tracker.direction.toUpperCase()} REVERSAL ${tracker.tracker?.type === 'reversal' ? tracker.tracker.phase.toUpperCase() : ''}`) : (candidate?.direction.toUpperCase() ?? 'MARKET CHART')} · ${data.instrument.venue}`,
        details: `${data.provenance.feed} · data ${new Date(data.provenance.asOf).toISOString()} · ${data.provenance.delayMinutes}m minimum delay`,
      },
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const image = await page.screenshot({ type: 'png' });
    if (image.byteLength > 250 * 1024) throw new Error('CHART_TOO_LARGE');
    return Buffer.from(image);
  } finally {
    await browser.close();
  }
}
