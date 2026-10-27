# News Intelligence: approved implementation roadmap

Approved scope: optional $0/month news intelligence using Marketaux Free, Currents Free, and GDELT. Implement **Phase 1 only** initially. Subsequent phases and deployment are separate steps. The approval does not authorize provider requests, credential changes, or public news publication during Phase 1.

## Architecture findings and boundaries

The existing TypeScript Cloudflare Worker has no news connector. Reuse `src/worker/index.ts` signed guild-bound interactions and minute cron, the SQLite-backed `src/worker/coordinator.ts` SignalCoordinator, `src/sql-store.ts` transactions, and `src/worker/sql.ts` measured SQL reads/writes. Add no public endpoint, cron, database, paid API, Python server, LLM service, or dependencies.

Initialize news independently with caught failures. Later phases run bounded news work after market scans and existing signal delivery. News must never become a market activation prerequisite or alter signals, risk calculations, learning features, strategy versions, or human-controlled promotion.

Reuse the journal/outbox atomic enqueueing, retries, receipts, command registration, guild permissions, test-channel routing, and production gates. News adds an independent publication gate. Immutable journal entries contain references, never article text. Existing `delivery_receipts` remains the sole receipt authority.

Leave `src/adapters/http.ts` unchanged: its internal retries and sleeps do not support per-attempt persistent news quotas. Leave market adapters, chart libraries, strategy, learning, and trading replay unchanged. News uses no chart or browser resources.

Corrections to proposed architecture:

- There is no general application SQL migration framework. Wrangler migration tags create Durable Object classes, not application tables.
- Instrument records do not contain a complete issuer/asset-name directory; reliable mapping needs reviewed aliases.
- GDELT article-list first-seen timestamps are not publisher publication timestamps.
- Existing invocation counters do not count every outbound fetch.
- The existing 4 GB storage guard exceeds Free's 1 GB per-object limit. Add stricter news-specific guards without unrelated market refactoring.

## Shared contracts and provider behavior

Use existing Zod and Node-compatible hashing. Each adapter implements exactly one attempt:

`fetchPage(query, signal) -> validated observations, pagination status, quota feedback`

The scheduler owns reservations, timing, and retries. Observations preserve provider identity, canonical URL, publisher domain, language, attribution, nullable publication and first-seen timestamps, timestamp basis, ingestion time, query/attempt IDs, source-policy versions, permitted headline/description, provider entities, and sentiment scope/provenance. No full bodies or images.

Persist UTC epoch milliseconds. Reject ambiguous dates. Normalize URLs conservatively by removing fragments and known tracking parameters while preserving content-identifying parameters. Never fetch publisher pages or redirects for deduplication. Exact deduplication uses provider identity and canonical URL; similar titles are clustering evidence only.

| Provider  | Contract                                                                                                                                                                                                   | Hard attempts/day | Normal target/day |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------: | ----------------: |
| Marketaux | GET `/v1/news/all`, query-token authentication, English, approved symbols, entity filtering, publication window, page 1, limit 3. Normalize data/uuid/source/published_at/entities and entity sentiment.   |                60 |                24 |
| Currents  | Stable GET `/v1/search`, Bearer authentication, approved keyword/Boolean query, English, strict RFC 3339 window, page 1, page size 20. Normalize news/id/URL/categories and offset-bearing published time. |               100 |                36 |
| GDELT     | Public DOC 2 ArtList JSON, English filter, date-descending sort, maxrecords 20, bounded UTC window. Preserve seendate as first-seen; no invented financial sentiment.                                      |                30 |                12 |

Marketaux advertises 100 Free requests/day with three articles/request; Currents advertises 250/day. Recheck current documentation before adapter implementation. Retries, pagination, and smoke tests consume quota. No upgrades, additional accounts, or quota purchases.

Transport:

- Atomic persistent reservation before every attempt; never refund an uncertain/crashed attempt.
- Application days reset at UTC midnight; provider exhaustion and Retry-After restrictions remain authoritative.
- One news attempt per tick, eight-second timeout including body consumption, 512 KiB response ceiling.
- Retry transient failures on later ticks, exponential delay capped at one hour, no sleeping loops.
- Authentication/permission failures suspend the provider; invalid query failures suspend that query.
- Cloudflare secrets only. No URLs, headers, raw error bodies, or credentials in logs/output.

## Licensing and source policy

Explicitly licensed research is permitted; unverified storage, analysis, and publication are denied. Require current provider **and** publisher approval per capability. Provider grants cannot override publisher restrictions.

Version policies with evidence URL/agreement reference, review date, expiry/review deadline, attribution, explicit retention, and distinct permissions for ingestion, retained metadata/headline/description, analysis, retained derived data, publication of metadata/headlines/derived statistics. Missing permission, missing policy, revoked status, or expiry means deny. Never fall back to an older approved version after revocation.

Unresolved rights:

- Marketaux terms do not establish blanket persistent-storage/public-Discord redistribution rights; commercial/API scope needs clarification.
- Currents terms restrict permanent databases, distribution, derivative uses, and unauthorized public statistics. Pricing guidance is not blanket permission for public sentiment.
- GDELT's broad dataset-use permission does not license publishers' article text/images.

Links and aggregate statistics also require applicable approval. Attribution is not a substitute for permission. No article scraping, customer-facing AI summaries, paid clearance, or automatic provider outreach. No policies start pre-approved.

Official references reviewed during planning:

- [Marketaux pricing](https://www.marketaux.com/pricing), [API](https://www.marketaux.com/documentation), [terms](https://www.marketaux.com/tos)
- [Currents pricing](https://currentsapi.services/en/product/price), [search](https://currentsapi.services/en/docs/search), [terms](https://currentsapi.services/terms)
- [GDELT DOC API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/), [project information](https://gdeltproject.org/about.html)
- [Cloudflare limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Persistence and intelligence

Independent additive migration registry, atomic through existing Store transactions. Do not change PRAGMA user_version, existing Wrangler tags, journal rows, or existing tables. Enforce relationship cleanup explicitly because local/cloud foreign-key settings differ.

| Table                                    | Responsibility                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| news_migrations                          | Unique version/applied timestamp                                                                                                               |
| news_source_policies                     | Immutable versioned provider/publisher permissions, evidence, expiry, attribution, retention                                                   |
| news_articles                            | Unique canonical URL/hash/domain and ingestion envelope; publication provenance is retained per observation to avoid overwriting disagreements |
| news_observations                        | Unique provider/article identity, canonical article reference, provenance and policy-permitted metadata/entities/sentiment                     |
| news_aliases                             | Reviewed instrument aliases, venue and disambiguation                                                                                          |
| news_instrument_links                    | Mapping method/confidence/evidence/version/expiry                                                                                              |
| news_events, news_event_articles         | Classified clusters, severity/freshness/analytics version and article evidence                                                                 |
| news_sentiments                          | Instrument/event scope, provider versus local origin, score/confidence/explanation/rules version/expiry                                        |
| news_queries                             | Sanitized specification, priority/due time/checkpoint/lease/failures                                                                           |
| news_quota_days, news_quota_reservations | Daily counts and unique persistent pre-attempt reservations                                                                                    |
| news_deliveries, news_delivery_items     | Digest/alert identity, journal reference, evidence/policy versions/expiry; reuse existing receipts                                             |

Narrow indexes support identities, query due times, expiry, instrument lookup, and cluster candidates. Article text belongs to provider observations so one provider's license does not silently authorize another's retained content.

Retention: at most seven days for approved article fields/observations and 30 days for approved derived data, shortened by source policy. Unknown retention means no persistence. Bounded cleanup removes expired/revoked evidence and dependent intelligence. Revocation suppresses queued deliveries. Permanent audit references must contain no licensed article content.

Intelligence rules for Phase 3:

- Watchlist, active ideas, and a small fixed macro/crypto query set.
- Reviewed aliases or unambiguous provider entity/venue matches; unresolved tickers stay unassigned.
- Provider sentiment kept separate from deterministic English weighted-phrase sentiment with negation and explicit contributions; absent evidence is unknown, not neutral.
- Same instrument/macro topic and event class within 24 hours; normalized-title token similarity >=0.75; at most 50 indexed cluster candidates.
- Earnings/guidance, acquisitions, legal/regulatory events, bankruptcy, security incidents/outages, macro policy.
- Independent publishers, not providers, count as corroboration; syndicated copies are not independent.
- News analytics version separate from trading/learning versions.

## Phase 1: contracts, persistence, policies

Create `src/news/{types,validation,normalize,config,policies,schema,store}.ts` and `tests/news-{contracts,storage,policies}.test.ts`, using synthetic fixtures. Compose NewsStore with existing Store transactions. Add isolated initialization in SignalCoordinator. Defaults are disabled for news, every provider, digests, and alerts.

Acceptance:

- Fresh/existing databases migrate idempotently and simulated failures roll back.
- Existing journal/watchlist/settings/strategy data and user_version stay unchanged.
- Canonical articles deduplicate while retaining separate provider observations and provenance.
- UTC validation and first-seen/publication distinctions are correct.
- Unknown/expired/revoked rights deny operations, and unlicensed fields never persist.
- News initialization failures leave market startup/storage/scanning functional.

No provider calls, scheduling, commands, publication, strategy changes, or release-ID bump. Save this approved roadmap at `docs/plans/news-intelligence.md`.

## Phase 2: adapters, quotas, ingestion

Create `src/news/{transport,quota,scheduler,ingestion}.ts` and `src/news/providers/{marketaux,currents,gdelt}.ts`. Extend coordinator orchestration, optional Worker secret types, and finite sanitized diagnostics. Missing credentials suspend only that provider.

Rotate approved queries with active-idea/pinned-instrument priority and aging. Maximum 64 scheduled queries, overlapping bounded windows, no automatic pagination/backlog bursts.

Acceptance: mocked provider contracts, malformed/oversized responses, timeout/partial reads, UTC reset, provider exhaustion, concurrent reservations, restart after reservation, retry accounting, redaction, and failure isolation from market scans.

## Phase 3: mapping, events, sentiment

Create `src/news/{mapping,clustering,sentiment,intelligence}.ts`, synthetic fixtures and tests.

Acceptance: ambiguous-ticker rejection, reviewed aliases, syndication deduplication, distinct-event separation, deterministic sentiment explanations, provider/local separation, unknown publication time not claimed as verified freshness, bounded processing, unchanged trading replay.

## Phase 4: commands and private publication

Create `src/discord/news.ts`, `src/news/publication.ts`. Extend command builders/authorization, publisher, domain event type, and outbox priority.

Public cached `/news latest [symbol]`, `/news sentiment [symbol]`, `/news sources`. Manager/admin `/news status`, `/news config` for news/provider/digest/alert switches and reducing caps. No arbitrary rights override or credential command.

Existing summaries route for digest, updates route for alerts; all test-mode automated output goes to TEST_CHANNEL_ID. No new required route.

After explicit activation:

- One Phoenix-calendar-day digest, next tick after midnight; max five eligible clusters, skip empty days.
- High-severity alerts only: bankruptcy, confirmed material security incidents, final material regulatory/legal actions, confirmed macro policy decisions.
- Verified mapping and two independent permitted publishers or reviewed first-party source; no rumors or evidence older than two hours.
- Max two alerts/hour and six/day; one initial alert per cluster.
- Approved factual templates/attribution/links only; separate headline permission; no generated article summaries.

Reference-only news_report events, atomic enqueue, rights check again at delivery. Preserve three total deliveries/tick; max one news delivery using spare capacity after existing events. No chart/browser/image/button/thread use.

Acceptance: permissions, cache-only commands, test routing, revoke-after-enqueue, expired evidence, restart/receipt/digest/alert deduplication, signal priority, no chart resources. Append immutable src/releases.ts entry only when user-visible functionality ships, with accurate command changes; never manually send releases.

## Phase 5: validation, monitoring, rollout

Create `src/research/news-replay.ts`, `scripts/news-smoke.ts`, recovery/end-to-end fixtures. Explicit smoke reserves quota and performs at most one request/provider. Committed fixtures are synthetic. Replay respects ingestion time and prevents future-evidence leakage.

Require seven healthy days of private test publication before production news. Measure duplicate/false-match/false-alert rates, policy suppression, freshness, retries, delivery failures, and resources. Keep existing market production gates, plus independent news gate.

Acceptance: gates pass, secrets never leak, market replay unchanged, outages do not stop market scans/delivery, rights-blocked providers remain visibly disabled.

## Resource protections, checks, rollback

Max 190 attempts/day, approximately 2,780 returned records/day before filtering/deduplication; sampled coverage, no claims of exhaustive/real-time news. Free limits are shared: 5 million SQL reads/day, 100,000 writes/day, 5 GB account storage, 1 GB per object; verify account headroom during soak.

News-specific limits for later runtime phases:

- Skip fetch if tick already took 45 seconds.
- Stop at 100,000 news SQL reads/day or 10,000 writes/day.
- Stop at shared 3.2 million reads, 64,000 writes, or 64,000 counted invocations/day.
- Stop ingestion at 64 MiB estimated news storage or 800 MB total object storage.
- Cap 5,000 articles, 10,000 observations, 2,000 events.
- Count index/cleanup writes; bounded maintenance; distinguish local counters from account billing metrics.

Every runtime phase runs `npm run verify`, `npm run worker:build`, formatting checks and relevant existing Worker/storage/budget/publishing/registration regressions.

Rollback: disable news ingestion/publication, suppress pending news deliveries, keep market operation running. Additive tables permit reverting Worker code without destructive migrations. Purge restricted fields when required while preserving immutable journal and existing receipts. Phase 1 neither enables nor deploys public news.

## Implementation progress

Phase 1 is implemented: validated contracts, independent additive migrations, policy-controlled canonical storage, retention cleanup, and isolated coordinator initialization. No policies were pre-approved.

Phase 2 is implemented following approval to proceed to the next phase:

- Single-attempt Marketaux, Currents, and GDELT adapters with bounded streaming transport, eight-second timeout, redirect rejection, and sanitized finite error codes.
- Optional `MARKETAUX_API_TOKEN` and `CURRENTS_API_KEY` Worker secret types. Existing market activation does not require either. No credentials were added or changed.
- UTC-day quota reservations, provider-wide retry streaks, persistent exhaustion/Retry-After restrictions, credential suspension, and hashed credential identity for rotation. Uncertain attempts remain consumed.
- Restart-safe query leases and a shared minute slot. Normal provider cadence remains 24/36/12 attempts per day; hard caps remain 60/100/30. No automatic pagination.
- Hourly query reconciliation for monitored equity symbols, reviewed aliases, macro policy, and crypto topics. Missing issuer aliases are not guessed. Active ideas and pinned symbols receive priority; older due queries age ahead. Maximum 64 recipes.
- Searches are restricted to currently approved publisher domains before requests. Currents rotates one approved domain per request; Marketaux/GDELT use at most 20. Unexpected domains/languages are suppressed and storage rechecks current rights after the response.
- News runs after market scans and durable delivery. Its diagnostics and failures are isolated from market errors and soak state. No news commands or messages exist yet.
- Daily measured SQL accounting, shared-resource/storage guards, daily conservative storage audit plus incremental insertion estimates, bounded hourly retention cleanup, and indexed reservation maintenance. Estimates reserve overhead; they are not billing measurements.
- Migration 2 adds a reservation-time index without changing migration 1 or existing tables.
- Synthetic tests cover provider contracts, body/fetch timeouts, byte bounds, rights races, quotas, crashes, leases, query scheduling, resource pauses, and coordinator ordering/failure isolation.

Provider API documentation was rechecked during Phase 2. Marketaux fractional timestamps can include six digits; UTC conversion now accepts up to nine fractional digits and stores millisecond precision. GDELT observation identity uses the canonical URL, while `seendate` remains provider first-seen time.

News and every provider remain disabled by default. There have been no live provider requests, secret changes, deployments, or release-ID changes. Phase 5 remains pending; source rights and appropriate secrets must be configured before private ingestion is enabled. Public publication still requires Phase 4 and the independent rollout gates.

Phase 3 is implemented following approval to proceed to the next phase:

- Independent `news-rules-v1` analytics in `mapping.ts`, `clustering.ts`, `sentiment.ts`, and `intelligence.ts`. Trading rules, learning, strategy promotion, journal events, and Discord commands are unchanged.
- Validated reviewed issuer aliases, exchange/entity matching, ambiguity context rules, and expiry. “US consolidated” equity venues cannot verify an exchange; bare tickers and guessed issuer names are rejected. Existing invalid/unreviewed alias bodies are ignored.
- Deterministic weighted financial phrases, negation, explicit contribution offsets, and rule-coverage confidence. Missing evidence remains unknown. Provider entity scores retain their scope and provenance separately; multi-instrument local sentiment remains article-scoped.
- Explainable event classes, conservative severity rules, rumor downgrades, period/target distinctions, and title-token similarity clustering within 24 hours. Derived evidence uses hashed title tokens and operational references rather than copied article text.
- Reviewed publisher ownership groups and conservative syndication suppression. Unknown ownership supplies no independent corroboration. Identical/near-identical titles do not supply a second independent source merely because another provider or publisher carries them.
- Migration 3 adds a durable analysis queue/state, publisher review table, and narrow candidate/sentiment/delivery indexes. Observation insertion and queue insertion are atomic. A bounded sweep refreshes analytics after policy/review changes, restart, analytics-version changes, and hourly expiry checks.
- At most 20 articles per analysis batch, 10 observations per article, 100 monitored instruments, 10 mappings, 50 cluster candidates total per article, and 20 evidence articles per cluster. These are sampling/resource bounds, not exhaustive coverage claims.
- Analysis runs after ingestion or on idle news ticks, after market work. It shares measured news/shared SQL and storage guards, includes current-tick usage, and stops before 55 seconds of tick elapsed time. Resource pauses preserve queued work; failed analysis retries later with finite diagnostics.
- Current provider and publisher analysis/retention permissions, policy versions, alias reviews, publisher reviews, and evidence expiry are rechecked before exposing stored analytics. Revocation suppresses dependent deliveries; cleanup invalidates affected clusters and requeues surviving evidence. GDELT first-seen time never becomes publication freshness.
- Synthetic mapping, clustering, sentiment, and persistence tests cover ambiguity, unrelated periods, syndication, unknown/future/conflicting publication times, provider score separation, restart idempotence, rights/review changes, durable retry, batch limits, resource rollback, malformed analytics, and unchanged market state.

News remains disabled by default. No source approvals, live provider requests, secret changes, deployments, public messages, or release-ID changes were made in Phase 3. Phase 4 follows below; production activation and Phase 5 remain separate steps.

Phase 4 is implemented following approval to proceed to the next phase:

- New `src/discord/news.ts` and `src/news/publication.ts` provide `/news latest [symbol]`, `/news sentiment [symbol]`, `/news sources`, manager/admin `/news status`, and `/news config` switches and downward-only daily caps. Reads use retained evidence only; they make no provider or market-data requests. Guild-bound interactions and cached autocomplete are reused.
- Every Discord response containing evidence—including ephemeral commands—requires current provider and publisher metadata/derived publication rights. Headline rights are separate. Templates contain factual classifications, attribution, links, provenance and explainable scores, with no generated article summaries. Complete required attribution is preserved; oversized automated templates are suppressed.
- Daily digests use the summaries route at the first tick after Phoenix midnight, select at most five eligible clusters from the preceding day, skip empty days, and never catch up multiple missed days. Initial activation starts the current day.
- Severe alerts use updates, require publication-verified freshness within two hours, verified instrument mapping (or the explicit macro policy topic), no rumors, and either two reviewed independent publishers or a reviewed primary source for the exact topic. Optional `firstPartyTopics` scopes primary-source reviews; a generic ownership review alone cannot bypass corroboration. Legal high severity now requires an explicitly final material ruling/penalty. At most two alerts in a rolling hour and six per Phoenix day; reserved alerts count conservatively even across restarts, suppression and midnight.
- Additive migration 4 adds delivery-time and event-selection indexes. Enqueueing the reference-only `news_report` journal event, existing outbox row, selected article/cluster references and policy versions is atomic. No article text is journaled. Existing delivery receipts remain the sole receipt authority.
- Pending news has the lowest outbox priority. The coordinator first attempts up to three existing events, then permits at most one news delivery using spare capacity. All automatic news goes exclusively to `TEST_CHANNEL_ID` in test mode. Production preserves the existing publication gates and adds independent news soak/review blockers; no command automatically approves production news.
- Delivery rechecks current rights, mapping/ownership reviews, evidence expiry, settings and alert eligibility after pre-send Discord I/O. Existing nonce/footer recovery and receipts prevent duplicate sends after uncertain outcomes. News uses no charts, images, files, buttons or idea threads. Failures and news soak resets remain separate from market diagnostics and soak state.
- Configuration changes atomically suppress pending news and reset the independent news test/review gate. Managers can disable news even when resource-paused. Source-policy changes continue to suppress affected pending deliveries immediately.
- Publication SQL shares news/shared limits and the 64 MiB news / 800 MB object protections; it starts only before 45 seconds of tick elapsed time. Delivery references are included in storage estimates. Monotonic SQL meters preserve measured news accounting when the shared budget counters reset between asynchronous operations.
- Synthetic command, publication, delivery, registration and coordinator regressions cover permissions, cached reads, attribution, disabled/rights-blocked sources, headline gating, digest/alert caps and midnight behavior, atomic enqueue rollback, revocation during Discord I/O, expiry, restart recovery, source corroboration, no signal starvation, private routing, finite diagnostics and zero chart use.
- Appended immutable release `2026-10-09-news-intelligence-publication` with the five added news subcommands and accurate controls. The existing durable release mechanism will announce it on a future deployment; no release message was sent manually.

Defaults remain disabled. No credentials, source approvals, runtime settings, live provider calls, deployments or public news were added by this implementation. Phase 5 must supply replay/smoke/recovery monitoring, complete the seven-day healthy private publication soak, and obtain the human rollout review before production news activation.

Phase 5 is implemented following approval to proceed to the next phase:

- `src/research/news-replay.ts` and synthetic fixtures replay ingestion, reviews, configuration and policy changes in chronological availability order in an isolated SQLite database. Snapshots use the existing bounded intelligence engine and separate analytics version. Delayed ingestion/reviews cannot leak into earlier snapshots; invalid future availability is rejected. Replay never publishes, calls providers, changes trading rules or grants rollout approval.
- `scripts/news-replay.ts` (`npm run news:replay`) defaults to synthetic fixtures and accepts an explicitly supplied licensed research fixture. `scripts/news-smoke.ts` (`npm run news:smoke`) exercises all three actual adapters against synthetic HTTP responses through the existing ingestion, persistent quota and scheduler path. It makes zero live requests and does not read environment credentials.
- Live smoke requests stay inside the existing manager-authorized `/news status smoke:true` interaction and Durable Object. This deliberately avoids a second local quota database or moving credentials out of Cloudflare secrets. Each request queues at most one attempt per enabled, rights-approved provider, spreads requests across normal ticks, honors all caps/backoff/timeouts/resource limits, and expires after 24 hours. There are no new Worker endpoints. Restarted reserved smoke attempts become uncertain and are never retried as smoke jobs; quota is not refunded. Normal ingestion retains its existing retry behavior.
- Additive migration 5 persists daily operational metrics and smoke requests/jobs. `src/news/metrics.ts`, `monitor.ts` and `smoke.ts` track attempts, retries, failures, new observations, exact duplicates (including canonical URL reuse), policy suppression, mapping/unmapped analysis passes, publication failures, delivered digests/alerts, selected-evidence freshness, SQL work and maximum elapsed tick time. Counters contain no article text, credentials, request URLs or error bodies. Accuracy is a human-labeled sample, never inferred from these counters.
- Resource guards persist each work unit using monotonic SQL measurements, including monitoring/accounting overhead. Dashboard resource aggregates and healthy checkpoints flush every five minutes to avoid redundant writes; resource aggregates can lag up to five minutes. Ninety-day metric/smoke maintenance deletes bounded batches. Shared Free-plan limits, 45-second work start, 55-second analysis, per-provider budgets and storage guards remain authoritative.
- Independent production gating now requires seven continuous private-test days, healthy live ingestion from every enabled provider within 24 hours, actual private delivery receipts and ongoing source rights. More than ten minutes without a healthy checkpoint, a failure, configuration/review/policy changes or private delivery inactivity beyond 48 hours restarts the test proof. Synthetic adapters and legacy soak booleans cannot clear this gate. Seven-day simulation tests validate the mechanism; they do not satisfy the real operational soak.
- `/news status` attaches monitoring, smoke state and a persisted SHA-256 review snapshot. Manager/admin `/news config` can separately record `review_sha256`, positive `reviewed_mappings`, `false_mappings`, `reviewed_alerts`, `false_alerts`, and `free_plan_verified:true`. Review requires a fresh matching snapshot, completed healthy soak, no observed false mappings/alerts in the supplied sample, and alert review when private alerts were delivered. The manager attests account-wide free-plan headroom; local counters cannot establish billing capacity. Review cannot be combined with configuration changes or executed in production mode. It never promotes trading strategies or deploys anything.
- Reviewed private-test proof remains valid on transition to production for the exact configuration, policies and active reviewed aliases/publisher groups. Production also requires current healthy runtime checkpoints. Failures revoke news approval while preserving market soak and strategy state. Existing production release gates remain additional requirements.
- Appended immutable release `2026-10-09-news-validation-and-rollout` with accurate status/config option changes. Release delivery remains automatic through the existing outbox on a later deployment.
- Synthetic regression coverage adds delayed/revoked replay evidence, uncertain quota recovery across SQLite restart, real-adapter smoke contracts, receipt-only health evidence, continuous seven-day state progression, failed/stale sample review, resource overruns, production health continuity, legacy-gate bypass rejection and manager command controls. Existing trading/replay/outbox/Worker regression suites remain required.

**Operational work remains separate:** no provider licenses were approved, no credentials were changed, no live smoke requests or seven-day private publication soak were run, no production settings were enabled, and no deployment occurred. Implementation validation cannot substitute for those external acceptance gates. See the rollout runbook below before activation.

## Phase 5 private-test rollout runbook

1. Obtain applicable provider and publisher permission for ingesting, retaining and analyzing fields and publishing metadata/derived results. Store evidence, attribution, retention and review expiry through the existing reviewed source-policy records. Missing rights stay denied; provider pricing is not a redistribution license. Review issuer aliases and publisher ownership/first-party scope. No fixtures in this repository constitute real rights or issuer reviews.
2. Keep `RELEASE_MODE=test` and verify `TEST_CHANNEL_ID` is private. Configure optional Marketaux/Currents credentials only as Cloudflare secrets using the established operational process. News is independently disabled by default; market activation does not depend on these secrets or news policies.
3. Use manager `/news config` to enable only cleared providers and desired digest/alerts, keeping hard caps at or below 60/100/30. Configuration changes suppress pending news and restart its separate rollout review. Source-policy changes suppress affected queued output. Existing scan and signal delivery limits remain first priority.
4. Request `/news status smoke:true` explicitly, then inspect status on subsequent ticks. Smoke is subject to provider cadence/backoff, so completion is not promised on the next three ticks. Inspect finite diagnostics and uncertain attempts; do not refund quota or automatically replay an uncertain smoke job. Each eligible provider is attempted at most once for that request, including failures. CLI smoke is offline and cannot clear live health.
5. Run healthy private publication for at least seven continuous days with at least one real private delivery per 48 hours, current live success for every enabled provider and no ten-minute monitoring gap. Empty digests are skipped; a sparse source set may need more observation time. Check daily counters, private messages and source-policy suppressions. Evaluate duplicate rate, sampled mapping false positives, alert false positives, provenance/freshness, retries, delivery failures and measured SQL/storage/tick use. Treat mapping counters as analysis passes, not unique article counts; rates need explicit sample denominators.
6. Review a labeled mapping/alert sample and actual Cloudflare account-wide reads, writes, storage, invocations and CPU-duration headroom, shared with the existing bot. Inspect provider dashboards for exhaustion. No upgrade, quota purchase or paid inference is permitted. False matches/alerts or resource pressure require correction and another healthy soak; zero observed errors in a sample is not a guarantee of population accuracy.
7. Fetch `/news status` and retain its `monitoring.sha256` and evidence for the review. Within one hour, an administrator/manager may submit `/news config review_sha256:<hash> reviewed_mappings:<positive sample size> false_mappings:0 reviewed_alerts:<sample size> false_alerts:0 free_plan_verified:true`. Review options are a separate action; do not combine switches/caps. If no private alerts occurred, reviewed_alerts may be zero. Review records the actor, time, sample and exact source/configuration signature. It approves the news rollout evidence only; production deployment remains separate and existing release gates still apply.
8. After separately authorized deployment/production activation, continue monitoring live ingestion and delivery. A stale runtime checkpoint blocks publication; an unhealthy tick revokes news approval. Disable news or individual providers with `/news config` for rollback, suppress queued news and purge restricted fields through bounded policy cleanup. Preserve the immutable journal and existing receipts. Reverting the Worker leaves additive tables intact; no destructive down migration is required.

Local validation commands: `npm run news:smoke`, `npm run news:replay`, `npm run verify`, `npm run worker:build`, and `npm run format:check`. All committed tests use synthetic data. A supplied replay fixture must have approved retention/analysis rights, and exported derived artifacts must have applicable permission; do not commit licensed article text or credentials.
