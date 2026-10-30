import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { historicalEntries } from '../src/entry-research/historical.js';
import type { ResearchInput } from '../src/entry-research/collector.js';
import { defaults, strategySchema } from '../src/config.js';
import { diagnosticCode } from '../src/core/errors.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      strategy: { type: 'string' },
      'include-holdout': { type: 'boolean' },
      'frozen-manifest': { type: 'string' },
    },
  });
  if (!positionals[0]) throw new Error('RESEARCH_INPUT_REQUIRED');
  const raw = await readFile(resolve(positionals[0]), 'utf8'),
    input = JSON.parse(raw) as ResearchInput;
  const configuration = values.strategy
    ? strategySchema.parse(JSON.parse(await readFile(resolve(values.strategy), 'utf8')))
    : defaults;
  const code = await Promise.all(
    [
      'src/core/strategy.ts',
      'src/entry-research/engine.ts',
      'src/entry-research/execution.ts',
      'src/entry-research/report.ts',
      'src/entry-research/historical.ts',
    ].map((path) => readFile(resolve(path), 'utf8')),
  );
  const fingerprint = hash(
    JSON.stringify({ input: hash(raw), config: configuration, code: hash(code.join('\n')) }),
  );
  if (values['include-holdout']) {
    if (!values['frozen-manifest']) throw new Error('FROZEN_VALIDATION_MANIFEST_REQUIRED');
    const frozen = JSON.parse(await readFile(resolve(values['frozen-manifest']), 'utf8')) as {
      fingerprint: string;
      stage: string;
    };
    if (frozen.fingerprint !== fingerprint || frozen.stage !== 'development_and_validation')
      throw new Error('FROZEN_RESEARCH_MANIFEST_MISMATCH');
  }
  const directory = resolve(values.out ?? 'output/entry-research/runs');
  await mkdir(directory, { recursive: true });
  const at = new Date().toISOString(),
    id = hash(`${fingerprint}:${at}`).slice(0, 24);
  const manifest = {
    id,
    fingerprint,
    at,
    stage: values['include-holdout'] ? 'reserved_holdout' : 'development_and_validation',
    inputSha256: hash(raw),
    configuration,
    policyVersion: 'daily-entry-research-v1',
    codeSha256: hash(code.join('\n')),
  };
  await writeFile(join(directory, `${id}-manifest.json`), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
  });
  await appendFile(join(directory, 'attempts.jsonl'), JSON.stringify(manifest) + '\n');
  const report = historicalEntries(input, configuration, values['include-holdout']);
  const destination = join(directory, `${id}-report.json`);
  await writeFile(destination, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(
    JSON.stringify(
      {
        id,
        report: destination,
        manifest: join(directory, `${id}-manifest.json`),
        holdout: report.historicalHoldout,
        issues: report.issues.length,
        partitions: report.partitions.map((p) => ({
          name: p.partition.name,
          opportunities: p.opportunities,
          policies: p.policies.map(
            ({ policy, entered, unknown, executionCoverage, totalR, netRPerOpportunity }) => ({
              policy,
              entered,
              unknown,
              executionCoverage,
              totalR,
              netRPerOpportunity,
            }),
          ),
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(diagnosticCode(error));
  process.exitCode = 1;
}
