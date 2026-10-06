import type { Candidate, Dataset } from './domain.js';
import { referenceGeometry } from './core/geometry.js';
export async function chartSnapshot(
  launch: () => Promise<any>,
  library: string,
  data: Dataset,
  candidate?: Candidate,
): Promise<Buffer> {
  const browser = await launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 860 },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route: { abort(): Promise<void> }) => route.abort()); // Chart snapshots make no external requests.
    await page.setContent(
      `<html><body style="margin:0;background:#11151c;color:#e6edf3;font-family:Arial"><header style="padding:20px 24px"><strong id="title" style="font-size:24px"></strong><div id="details" style="margin-top:8px;color:#a8b4c4"></div></header><div style="display:flex"><section><div style="padding:8px 24px">WEEKLY CONTEXT</div><div id="weekly"></div></section><section><div style="padding:8px 24px">DAILY SETUP</div><div id="daily"></div></section></div><footer style="padding:16px 24px;color:#a8b4c4">Charts powered by TradingView Lightweight Charts · tradingview.com<br>Signal references only · no order execution or fills implied</footer></body></html>`,
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
      }: {
        daily: Dataset['daily'];
        weekly: Dataset['weekly'];
        c?: Candidate;
        geometry?: ReturnType<typeof referenceGeometry>;
        title: string;
        details: string;
      }) => {
        const L = (window as unknown as { LightweightCharts: any }).LightweightCharts;
        document.getElementById('title')!.textContent = title;
        document.getElementById('details')!.textContent = details;
        for (const [id, bars] of [
          ['weekly', weekly],
          ['daily', daily],
        ] as const) {
          const chart = L.createChart(document.getElementById(id), {
            width: 600,
            height: 620,
            layout: {
              background: { color: '#11151c' },
              textColor: '#a8b4c4',
              attributionLogo: true,
            },
            grid: { vertLines: { color: '#202937' }, horzLines: { color: '#202937' } },
            timeScale: { timeVisible: false, rightOffset: 10 },
            rightPriceScale: { borderColor: '#334155' },
          });
          const candles = chart.addSeries(L.CandlestickSeries, {
            upColor: '#22c6a8',
            downColor: '#ef6571',
            wickUpColor: '#22c6a8',
            wickDownColor: '#ef6571',
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
          });
          volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
          volume.setData(
            bars.map((b) => ({
              time: b.start / 1000,
              value: b.volume,
              color: b.close >= b.open ? '#165e53' : '#6b3039',
            })),
          );
          for (const period of id === 'weekly' ? [30] : [10, 20, 50]) {
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
          if (c) {
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
              [c.level, 'Breakout / invalidation close', '#e9b35d'],
              [
                geometry?.entry,
                geometry?.provisional ? 'Hypothetical entry' : 'Entry reference',
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
                '#22c6a8',
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
          chart.timeScale().setVisibleLogicalRange({ from: 0, to: bars.length + 10 });
        }
      },
      {
        daily: data.daily.slice(-100),
        weekly: data.weekly.slice(-60),
        c: candidate,
        geometry: candidate ? referenceGeometry(candidate) : undefined,
        title: `${data.instrument.symbol} · ${candidate?.direction.toUpperCase() ?? 'MARKET CHART'} · ${data.instrument.venue}`,
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
