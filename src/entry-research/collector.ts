import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Bar, Dataset, Instrument, Interval, MarketDataProvider, Session } from '../domain.js';
import { benchmarkFor } from '../domain.js';
import type { Store } from '../sql-store.js';
import { DAY, QUARTER, expectedIntraday, weeklyBars } from '../core/time.js';
import { stableId } from '../core/strategy.js';
import { diagnosticCode } from '../core/errors.js';
import { checkDaily, checkIntraday } from '../core/quality.js';

export interface Eligibility {
  instrumentId: string;
  from: number;
  to: number;
}
export interface ResearchInput {
  schema: 'entry-research-input-v1';
  datasets: Dataset[];
  evaluation: {
    from: number;
    to: number;
    universe: 'current_symbols' | 'point_in_time';
    eligibility?: Eligibility[];
  };
  evidence: { source: string; retrievedAt: string; sourceSha256: string }[];
  executionBars?: Record<string, Bar[]>;
  executionResolution: '15m' | '1m';
  coverage: { complete: boolean; errors: { symbol: string; reason: string }[] };
  sourcePages: {
    file: string;
    sha256: string;
    retrievedAt: string;
    instrumentId: string;
    interval: string;
  }[];
}
export interface Collection {
  instruments: Instrument[];
  from: number;
  to: number;
  resolution: '15m' | '1m';
  directory: string;
  maxPages: number;
  eligibility?: Eligibility[];
}
interface Job {
  instrument: Instrument;
  interval: Interval | '1m';
  from: number;
  to: number;
  cursor?: string;
  done: boolean;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function atomic(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
}

export async function collectHistory(
  store: Store,
  provider: (i: Instrument) => MarketDataProvider,
  options: Collection,
) {
  if (
    !options.instruments.length ||
    !Number.isFinite(options.from) ||
    !Number.isFinite(options.to) ||
    options.from >= options.to ||
    options.to > Date.now() ||
    !Number.isInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > 1000
  )
    throw new Error('INVALID_RESEARCH_COLLECTION');
  if (
    options.eligibility?.some(
      (e) =>
        !options.instruments.some((i) => i.id === e.instrumentId) ||
        !Number.isFinite(e.from) ||
        !Number.isFinite(e.to) ||
        e.from >= e.to,
    )
  )
    throw new Error('INVALID_ELIGIBILITY_MANIFEST');
  const directory = options.directory;
  await mkdir(join(directory, 'pages'), { recursive: true });
  const signature = digest({
    instruments: options.instruments,
    from: options.from,
    to: options.to,
    resolution: options.resolution,
    eligibility: options.eligibility,
  });
  const existing = store.get<string | null>('research_collection_signature', null);
  if (existing && existing !== signature)
    throw new Error('RESEARCH_COLLECTION_SETTINGS_CHANGED_USE_NEW_DIRECTORY');
  store.set('research_collection_signature', signature);
  store.set('research_collection_settings', options);
  const history = new Map(
    options.instruments.flatMap((i) => [i, benchmarkFor(i)]).map((i) => [i.id, i]),
  );
  const jobs = store.get<Job[]>(
    'research_collection_jobs',
    [...history.values()].flatMap((i) => [
      {
        instrument: i,
        interval: '1d' as const,
        from: options.from - 800 * DAY,
        to: options.to,
        done: false,
      },
      ...(options.instruments.some((x) => x.id === i.id)
        ? [
            {
              instrument: i,
              interval: '15m' as const,
              from: options.from - 35 * DAY,
              to: options.to,
              done: false,
            },
            ...(options.resolution === '1m'
              ? [
                  {
                    instrument: i,
                    interval: '1m' as const,
                    from: options.from,
                    to: options.to,
                    done: false,
                  },
                ]
              : []),
          ]
        : []),
    ]),
  );
  const equities = options.instruments.find((i) => i.market === 'equity');
  let sessions: Session[] = store.get('research_calendar', []);
  if (equities && !sessions.length) {
    sessions = await provider(equities).calendar(options.from - 802 * DAY, options.to + DAY);
    store.set('research_calendar', sessions);
  }
  const refs = store.get<ResearchInput['sourcePages']>('research_source_pages', []);
  let pages = 0,
    error: string | undefined;
  for (const job of jobs) {
    if (job.done) continue;
    while (job.from < job.to && pages < options.maxPages) {
      const duration = job.interval === '1d' ? DAY : job.interval === '1m' ? 60_000 : QUARTER;
      const end = Math.min(job.to, job.from + 299 * duration),
        adapter = provider(job.instrument);
      if (!adapter.barPage) throw new Error('RESEARCH_PAGE_ADAPTER_REQUIRED');
      const name = `${stableId(job.instrument.id, job.interval, job.from, end, job.cursor)}.json`,
        file = join(directory, 'pages', name);
      type Page = {
        instrumentId: string;
        interval: string;
        from: number;
        through: number;
        retrievedAt: string;
        bars: Bar[];
        next?: string;
      };
      let page: Page | undefined;
      try {
        page = JSON.parse(await readFile(file, 'utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      try {
        if (!page) {
          const response = await adapter.barPage(
            job.instrument,
            job.interval,
            job.from,
            end,
            job.cursor,
          );
          page = {
            instrumentId: job.instrument.id,
            interval: job.interval,
            from: job.from,
            through: end,
            retrievedAt: new Date().toISOString(),
            bars: response.bars,
            next: response.next,
          };
          await atomic(file, page);
        }
        const sha256 = digest(page);
        store.transaction(() => {
          store.cache(job.instrument, job.interval, page!.bars);
          if (!refs.some((r) => r.file === name))
            refs.push({
              file: name,
              sha256,
              retrievedAt: page!.retrievedAt,
              instrumentId: job.instrument.id,
              interval: job.interval,
            });
          job.cursor = page!.next;
          if (!job.cursor) job.from = end;
          job.done = job.from >= job.to;
          store.set('research_collection_jobs', jobs);
          store.set('research_source_pages', refs);
        });
        pages++;
      } catch (e) {
        error = diagnosticCode(e);
        break;
      }
    }
    if (error || pages >= options.maxPages) break;
  }
  const errors: { symbol: string; reason: string }[] = [];
  const datasets = options.instruments.map((instrument): Dataset => {
    const daily = store.bars(instrument, '1d'),
      benchmark = store.bars(benchmarkFor(instrument), '1d'),
      intraday = store.bars(instrument, '15m');
    try {
      checkDaily(
        instrument,
        daily.filter((b) => b.end <= options.from),
        sessions,
        options.from,
      );
      checkDaily(
        benchmarkFor(instrument),
        benchmark.filter((b) => b.end <= options.from),
        sessions,
        options.from,
      );
      checkDaily(instrument, daily, sessions, options.to);
      checkDaily(benchmarkFor(instrument), benchmark, sessions, options.to);
      checkIntraday(
        { instrument, intraday, sessions } as Dataset,
        options.from - 35 * DAY,
        options.to,
      );
      if (options.resolution === '1m') {
        const starts = new Set(store.bars(instrument, '1m').map((b) => b.start));
        if (
          expectedIntraday(options.from, options.to, instrument.market, sessions).some((t) =>
            Array.from({ length: 15 }, (_, n) => t + n * 60_000).some((t) => !starts.has(t)),
          )
        )
          throw new Error('MISSING_ONE_MINUTE_EXECUTION_BARS');
      }
    } catch (e) {
      errors.push({ symbol: instrument.symbol, reason: diagnosticCode(e) });
    }
    return {
      instrument,
      daily,
      benchmark,
      intraday,
      sessions: instrument.market === 'equity' ? sessions : [],
      weekly: weeklyBars(daily, instrument.market, sessions, options.to),
      provenance: {
        provider: instrument.market === 'equity' ? 'Alpaca' : 'Coinbase Exchange',
        feed:
          instrument.market === 'equity'
            ? 'SIP consolidated adjusted; retrospective source snapshot'
            : 'Coinbase USD spot; retrospective source snapshot',
        delayMinutes: instrument.market === 'equity' ? 16 : 0,
        asOf: options.to,
      },
    };
  });
  if (error) errors.push({ symbol: 'collection', reason: error });
  const complete = jobs.every((j) => j.done) && !errors.length;
  const input: ResearchInput = {
    schema: 'entry-research-input-v1',
    datasets,
    evaluation: {
      from: options.from,
      to: options.to,
      universe: options.eligibility ? 'point_in_time' : 'current_symbols',
      eligibility: options.eligibility,
    },
    executionResolution: options.resolution,
    executionBars:
      options.resolution === '1m'
        ? Object.fromEntries(options.instruments.map((i) => [i.id, store.bars(i, '1m')]))
        : undefined,
    evidence: options.instruments.map((i) => {
      const sources = refs.filter(
        (r) => r.instrumentId === i.id || r.instrumentId === benchmarkFor(i).id,
      );
      return {
        source: `${i.venue}; normalized source pages`,
        retrievedAt: sources.at(-1)?.retrievedAt ?? new Date().toISOString(),
        sourceSha256: digest(sources),
      };
    }),
    coverage: { complete, errors },
    sourcePages: refs,
  };
  await atomic(join(directory, 'research-input.json'), input);
  return {
    schema: 'research-collection-status-v1',
    complete,
    pagesThisInvocation: pages,
    remainingJobs: jobs.filter((j) => !j.done).length,
    error,
    coverage: input.coverage,
    manifest: join(directory, 'research-input.json'),
    warning:
      'Current-symbol selection is not a historical universe. Page hashes establish reproducibility, not source authenticity or historical first availability.',
  };
}
