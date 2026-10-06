import type { Candidate } from '../domain.js';
// The pre-entry reference is the same hypothetical geometry used for ranking.
export function referenceGeometry(c: Candidate) {
  const s = c.direction === 'bullish' ? 1 : -1,
    provisional = c.entry === undefined,
    entry = c.entry ?? c.level + s * 0.5 * c.atr,
    risk = Math.abs(entry - c.level),
    target = c.target ?? entry + s * risk * c.provisionalRR;
  return {
    provisional,
    entry,
    target,
    targets: c.targets ?? [entry + s * risk, entry + s * 2 * risk, target],
    rr: risk > 0 ? (s * (target - entry)) / risk : 0,
  };
}
