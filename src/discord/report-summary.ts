import type {
  activeIdeas,
  digest,
  explain,
  health,
  marketContext,
  statistics,
  preferences,
} from '../insights.js';
export function reportSummary(name: string, result: unknown): string {
  if (typeof result === 'string') return result;
  if (name === 'health') {
    const h = result as ReturnType<typeof health>;
    return `Monitoring: ${h.monitoring} · ${h.paused ? 'paused' : 'enabled'}${h.budgetPaused ? ' · resource limit reached' : ''}\nPublication: ${h.publicationBlockers.join(', ') || 'ready'}\nDeliveries: ${h.queue.pending} pending · oldest visible ${h.queue.oldestVisibleMinutes.toFixed(0)}m · ${h.queue.reviewRequired} require review\n${
      h.instruments
        .filter((i) => i.quality)
        .map((i) => `${i.symbol}: ${i.quality}`)
        .slice(0, 10)
        .join('\n') || 'No cached symbol-quality blockers.'
    }\nFull diagnostics attached.`;
  }
  if (name === 'explain') {
    const e = result as ReturnType<typeof explain>;
    return `${e.symbol} · ${e.candidates.length} qualifying setup(s) · ${e.quality ?? 'daily history checks passed'}\n${e.attempts.map((a) => `${a!.direction} latest attempted candle:\n${a!.checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.name}: ${typeof c.value === 'number' ? Number(c.value.toPrecision(5)) : c.value} (${c.requirement})`).join('\n')}`).join('\n')}\n${e.note}`.slice(
      0,
      1850,
    );
  }
  if (name === 'ideas')
    return (
      (result as ReturnType<typeof activeIdeas>)
        .map(
          (i) =>
            `${i.symbol} ${i.direction} · ${i.state}\n${i.id} · ${i.remainingSessions} session(s) remaining${i.quality ? ` · ${i.quality}` : ''}`,
        )
        .join('\n')
        .slice(0, 1800) || 'No active ideas.'
    );
  if (name === 'digest') {
    const d = result as ReturnType<typeof digest>;
    return `${d.personal ? 'Personal' : 'Shared'} digest · ${d.active.length} active ideas · ${d.changes.length} recent changes\n${
      d.changes
        .slice(0, 12)
        .map(
          (e) =>
            `${e.symbol}: ${e.state}${e.tracker ? ` · ${e.tracker}` : ''}${e.recovery ? ' · recovered' : ''}`,
        )
        .join('\n') || 'No matching recent changes.'
    }\nFull details attached. Signal references are not fills.`;
  }
  if (name === 'stats') {
    const s = result as ReturnType<typeof statistics>;
    return `${s.groups.length} version/market/direction/regime groups.\n${s.note}\nFull counts attached.`;
  }
  if (name === 'context') {
    const c = result as ReturnType<typeof marketContext>;
    return (
      c.instruments
        .slice(0, 15)
        .map((i) => `${i.symbol} · ${i.benchmark} trend ${i.benchmarkTrend} · sector ${i.sector}`)
        .join('\n') +
      '\n' +
      c.note
    );
  }
  if (name === 'follow')
    return (
      (result as ReturnType<typeof preferences>).map((p) => `${p.symbol}: ${p.type}`).join('\n') ||
      'No personal follows. Use /follow add to filter /digest personal:true.'
    );
  return `${name} details attached.`;
}
