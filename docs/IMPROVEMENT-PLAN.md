# Three-release implementation plan

Scope: implement and validate locally in dependency order. Deployment and the real historical review/private-channel soak remain separate operational checkpoints. Preserve signal-only behavior, immutable journals and releases, atomic full-list watchlist announcements, persistent exclusions, no-op deduplication, test routing, receipts, and text delivery without charts.

## Release 1 — correctness and continuity

- Discover retests from the frozen candidate and original strategy configuration, including after settings change.
- Isolate refresh failures; crypto must work without an equity calendar. Evaluate only coherent, complete data.
- Describe crossing direction and actual crossing prices/levels correctly.
- Mark delayed/obsolete setup and entry deliveries historical, without changing journal evidence or receipt identities.
- Record production eligibility by strategy/reversal version; continue previously published idea updates while new signals await validation. Keep pause, permissions and quota gates.
- Strengthen replay input validation, source hashes, explicit historical provenance, configuration/version recording and capacity parity.
- Acceptance: regressions for old-version retests, provider isolation, down-crosses, delayed cards and publication eligibility; full verify and Worker build.

## Release 2 — efficiency and visibility

- Separate discovery cadence from monitoring; monitor active entries first. Bound provider work and persist incremental progress.
- Refresh intraday by symbol/cursor, save successful products before later failures, reuse valid discovery history and cache calendars.
- Cache identical frozen chart requests with a bounded lifetime/memory allowance; reserve render capacity for entry events.
- Index active ideas and journal lookups; expose queue age, retries, delivery latency, provider work and job timings.
- Add /health, /explain symbol, /config show and manager /queue inspect/retry; paginate watchlists and preserve complete attachments.
- Acceptance: cold symbol does not rewind warm products, bounded/resumable requests, diagnostics stay usable under pause, cached charts avoid browser reservations, rejected setup explanations agree with detector; verify and Worker build.

## Release 3 — decision support

- Add /ideas active, /digest, /stats and /context. Show deadlines, quality pauses, benchmark context and directional/sector concentration where data exists.
- Add personal /follow add/remove/list preferences for symbols/event types and filtered member digests, independent of the shared watchlist. No unsolicited DMs or mass mentions.
- Improve symbol/idea autocomplete through cached coordinator state.
- Select optional options context using freshness, expiry, directional strike proximity and quoted liquidity; omit unverified contracts.
- Add an offline research simulator with next-bar execution, explicit costs, gap-aware exits, conservative ambiguous-bar handling and chronological holdout reporting. Never equate signal outcomes to fills.
- Acceptance: member/manager authorization, preference isolation, deterministic statistics including unknown/ambiguous outcomes, context without invented sectors, conservative simulator accounting; verify and Worker build.

## Delivery and rollout

Append one unique immutable release entry per stage with exact command changes. Run meaningful targeted regressions as changes land and npm run verify plus npm run worker:build at every stage. Keep credentials and bundled chart library untouched. Document command usage, research limitations, migration compatibility and live rollout checks. Only the latest release is automatically announced on deployment; no manual release messages.

## Local completion evidence

Release 1 passed 192 tests plus typecheck/build and Worker bundling. Release 2 passed 196 tests plus the same checks. Release 3 adds member commands, preferences, context, outcome accounting, options screening and research tools. Final combined-workspace verification passed 213 tests, typecheck, TypeScript build and Worker bundling. Synthetic replay and simulator smoke runs completed, preserving unverified evidence and unknown future outcomes. The independent daily-recap update was preserved. Repository format checking flags only the unchanged src/chart-snapshot.ts. Credentials, deployment, provider entitlements, licensed historical evidence and the live seven-day soak are not inferred from these local checks. See [operation and rollout](RELEASES-1-3.md).
