import { parseArgs } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../src/storage.js';
import { Alpaca } from '../src/adapters/alpaca.js';
import { Coinbase } from '../src/adapters/coinbase.js';
import { HttpClient } from '../src/adapters/http.js';
import { equity, crypto } from '../src/domain.js';
import {
  collectHistory,
  type Collection,
  type Eligibility,
} from '../src/entry-research/collector.js';
import { diagnosticCode } from '../src/core/errors.js';

try {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { values } = parseArgs({
    options: {
      symbols: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string' },
      'execution-resolution': { type: 'string' },
      'max-pages': { type: 'string' },
      eligibility: { type: 'string' },
    },
  });
  const directory = resolve(values.out ?? 'output/entry-research/collection');
  await mkdir(directory, { recursive: true });
  const store = new Store(join(directory, 'collection.sqlite'));
  try {
    const saved = store.get<Collection | null>('research_collection_settings', null);
    const to = values.to
      ? Date.parse(values.to)
      : (saved?.to ?? Math.floor(Date.now() / 86_400_000) * 86_400_000);
    const defaultFrom = new Date(to);
    defaultFrom.setUTCFullYear(defaultFrom.getUTCFullYear() - 3);
    const instruments = values.symbols
      ? values.symbols.split(',').map((s) => {
          const symbol = s.trim().toUpperCase();
          if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol))
            throw new Error('INVALID_RESEARCH_SYMBOL');
          return symbol.endsWith('-USD') ? crypto(symbol) : equity(symbol);
        })
      : saved?.instruments;
    if (!instruments?.length) throw new Error('RESEARCH_SYMBOLS_REQUIRED');
    const resolution = values['execution-resolution'] ?? saved?.resolution ?? '15m';
    if (!['1m', '15m'].includes(resolution)) throw new Error('INVALID_RESEARCH_RESOLUTION');
    const eligibility: Eligibility[] | undefined = values.eligibility
      ? JSON.parse(await readFile(resolve(values.eligibility), 'utf8'))
      : saved?.eligibility;
    const http = new HttpClient(store);
    http.beginWork();
    const stocks = new Alpaca(
        http,
        process.env.ALPACA_API_KEY ?? '',
        process.env.ALPACA_API_SECRET ?? '',
      ),
      coins = new Coinbase(http);
    const result = await collectHistory(store, (i) => (i.market === 'equity' ? stocks : coins), {
      instruments,
      from: values.from ? Date.parse(values.from) : (saved?.from ?? +defaultFrom),
      to,
      resolution: resolution as '1m' | '15m',
      directory,
      maxPages: Number(values['max-pages'] ?? 24),
      eligibility,
    });
    console.log(JSON.stringify(result, null, 2));
    if (
      result.error &&
      result.error !== 'PROVIDER_WORK_LIMIT' &&
      result.error !== 'PROVIDER_RETRY_LATER'
    )
      process.exitCode = 1;
  } finally {
    store.close();
  }
} catch (error) {
  console.error(diagnosticCode(error));
  process.exitCode = 1;
}
