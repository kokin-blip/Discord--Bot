import type { Candidate, Dataset, SignalEvent } from './domain.js';
import { chartView } from './chart-view.js';
export const CHART_STYLE_VERSION = 'tv-simple-v3';
export async function chartSnapshot(
  launch: () => Promise<any>,
  library: string,
  data: Dataset,
  candidate?: Candidate,
  event?: SignalEvent,
): Promise<Buffer> {
  const browser = await launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 920 },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route: { abort(): Promise<void> }) => route.abort());
    await page.setContent(`<html><head><style>
      *{box-sizing:border-box} body{margin:0;background:#0d0e10;color:#e0e3e8;font-family:Arial}
      header{height:82px;padding:16px 24px;border-bottom:1px solid #24262b}
      #title{font-size:21px;font-weight:600} #details{margin-top:7px;color:#a5a9b2;font-size:12px}
      section{position:relative} .label{position:absolute;z-index:2;top:12px;left:24px;font-size:12px;color:#c3c7ce;pointer-events:none}
      .watermark{position:absolute;z-index:2;left:0;right:100px;top:42%;text-align:center;color:#ffffff18;font-size:48px;font-weight:600;pointer-events:none}
      #context{border-top:1px solid #24262b} footer{height:48px;padding:10px 24px;color:#a5a9b2;font-size:11px;line-height:16px}
      </style></head><body><header><strong id="title"></strong><div id="details"></div></header>
      <section><div class="label" id="main-label"></div><div class="watermark" id="watermark"></div><div id="main"></div></section>
      <section id="context"><div class="label" id="context-label"></div><div id="overview"></div></section>
      <footer>Charts powered by TradingView Lightweight Charts · tradingview.com<br>Signal references only · no order execution or fills implied</footer></body></html>`);
    await page.addScriptTag({ content: 'globalThis.__name = (fn) => fn;\n' + library });
    const view = chartView(data, candidate, event);
    await page.evaluate(
      ({
        view,
        symbol,
        details,
        debug,
        direction,
      }: {
        view: ReturnType<typeof chartView>;
        symbol: string;
        details: string;
        debug: boolean;
        direction?: string;
      }) => {
        const L = (window as unknown as { LightweightCharts: any }).LightweightCharts;
        document.getElementById('title')!.textContent =
          `${debug ? 'SYNTHETIC DEBUG TEST · ' : ''}${symbol} · ${view.label.toUpperCase()}`;
        document.getElementById('details')!.textContent = details;
        document.getElementById('watermark')!.textContent =
          `${symbol} · ${view.intraday ? '15m' : '1D'}`;
        document.getElementById('main-label')!.textContent =
          `${view.intraday ? '15-MINUTE' : 'DAILY'} · SMA 20 / 50 · VOLUME`;
        document.getElementById('context-label')!.textContent = view.intraday
          ? 'DAILY CONTEXT · SMA 20 / 50'
          : 'WEEKLY CONTEXT · SMA 30';
        for (const [id, bars] of [
          ['main', view.bars],
          ['overview', view.context],
        ] as const) {
          const primary = id === 'main';
          const chart = L.createChart(document.getElementById(id), {
            width: 1200,
            height: primary ? 610 : 180,
            layout: {
              background: { color: '#0d0e10' },
              textColor: '#a5a9b2',
              fontFamily: 'Arial',
              fontSize: 14,
              attributionLogo: true,
            },
            grid: { vertLines: { visible: false }, horzLines: { color: '#ffffff06' } },
            timeScale: {
              timeVisible: view.intraday && primary,
              secondsVisible: false,
              borderVisible: false,
            },
            rightPriceScale: {
              borderVisible: false,
              minimumWidth: 100,
              scaleMargins: { top: primary ? 0.12 : 0.25, bottom: primary ? 0.25 : 0.1 },
            },
          });
          const candles = chart.addSeries(L.CandlestickSeries, {
            upColor: '#26a69a',
            downColor: '#ef5350',
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
            borderVisible: false,
            priceLineVisible: false,
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
          for (const period of !primary && !view.intraday ? [30] : [20, 50]) {
            const average = chart.addSeries(L.LineSeries, {
              color: period === 20 ? '#57a8f1' : '#caac6c',
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
                          bars.slice(i + 1 - period, i + 1).reduce((sum, x) => sum + x.close, 0) /
                          period,
                      },
                    ]
                  : [],
              ),
            );
          }
          if (primary) {
            const volume = chart.addSeries(L.HistogramSeries, {
              priceFormat: { type: 'volume' },
              priceScaleId: 'volume',
              lastValueVisible: false,
              priceLineVisible: false,
            });
            volume
              .priceScale()
              .applyOptions({ scaleMargins: { top: 0.79, bottom: 0 }, visible: false });
            volume.setData(
              bars.map((b) => ({
                time: b.start / 1000,
                value: b.volume,
                color: b.close >= b.open ? '#26a69a70' : '#ef535070',
              })),
            );
            if (view.call) {
              const sell = view.label === 'SELL' || view.label === 'EXIT';
              const above = sell || direction === 'bearish';
              L.createSeriesMarkers(candles, [
                {
                  time: view.call.start / 1000,
                  position: above ? 'aboveBar' : 'belowBar',
                  color: sell ? '#e9b35d' : direction === 'bearish' ? '#ef5350' : '#26a69a',
                  shape: above ? 'arrowDown' : 'arrowUp',
                  text: view.label,
                },
              ]);
            }
          }
          const markerIndex =
            primary && view.call ? bars.findIndex((b) => b.start === view.call!.start) : -1;
          chart
            .timeScale()
            .setVisibleLogicalRange({
              from:
                bars.length < 10
                  ? -3
                  : markerIndex >= 0
                    ? Math.min(Math.max(0, bars.length - 48), Math.max(0, markerIndex - 12))
                    : Math.max(0, bars.length - 48),
              to: bars.length + 6,
            });
        }
      },
      {
        view,
        symbol: data.instrument.symbol,
        debug: !!event?.debug,
        direction: event?.direction ?? candidate?.direction,
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
