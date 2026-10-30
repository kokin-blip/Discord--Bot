import { ThresholdStore } from '../threshold/store.js';
import { NewsPublication } from '../news/publication.js';
import { cachedSuggestions, type AutocompleteRequest } from '../discord/autocomplete.js';
import { ChannelSetup } from '../discord/channel-setup.js';
import { Scorecard } from '../scorecard.js';
import { EntryResearch } from '../entry-research/engine.js';
import { EntryMeasurements } from '../entry-research/measurements.js';
import { logEntryRuntime } from '../entry-research/telemetry.js';
import { queueRelease } from '../announcements.js';
import { Learning } from '../learning.js';
import type { DurableObjectState } from '@cloudflare/workers-types';
import {
  ChatInputCommandInteraction,
  Client,
  ClientUser,
  Routes,
  GatewayIntentBits,
  type APIUser,
  type APIChatInputApplicationCommandInteraction,
} from 'discord.js';
import { Store } from '../sql-store.js';
import { initializeNews, type NewsStore } from '../news/store.js';
import { NewsIngestion } from '../news/ingestion.js';
import { CloudSql } from './sql.js';
import { CloudBudget } from './budget.js';
import { CloudCharts } from './charts.js';
import type { Env } from './types.js';
import { HttpClient } from '../adapters/http.js';
import { Alpaca } from '../adapters/alpaca.js';
import { Coinbase } from '../adapters/coinbase.js';
import { DataService } from '../data.js';
import { SignalService } from '../service.js';
import { DiscordPublisher } from '../discord/publisher.js';
import { CommandHandler } from '../discord/commands.js';
import { routes, type Route } from '../config.js';
import { syncCommands } from '../discord/registration.js';
import { diagnosticCode } from '../core/errors.js';
import { activationIssues } from './activation.js';
import { failureResponse, type FailureStage } from './failures.js';
export class SignalCoordinator {
  readonly store: Store;
  readonly news: NewsStore | null;
  readonly newsIngestion: NewsIngestion | null;
  readonly newsPublication: NewsPublication | null;
  readonly newsInitializationError: 'NEWS_INITIALIZATION_FAILED' | null;
  readonly budget: CloudBudget;
  readonly service: SignalService;
  readonly publisher: DiscordPublisher;
  readonly handler: CommandHandler;
  readonly client: Client;
  readonly channelSetup: ChannelSetup;
  private busy = false;
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {
    const sql = new CloudSql(ctx.storage);
    this.store = new Store(sql);
    const initializedNews = initializeNews(this.store);
    this.news = initializedNews.news;
    this.newsIngestion = this.news ? new NewsIngestion(this.news, env) : null;
    this.newsInitializationError = initializedNews.error;
    this.newsPublication = this.news ? new NewsPublication(this.news) : null;
    this.budget = new CloudBudget(this.store, sql);
    const http = new HttpClient(this.store),
      data = new DataService(
        this.store,
        new Alpaca(http, env.ALPACA_API_KEY ?? '', env.ALPACA_API_SECRET ?? ''),
        new Coinbase(http),
      );
    this.service = new SignalService(this.store, data);
    const charts = new CloudCharts(env, this.budget);
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.client.rest.setToken(env.DISCORD_TOKEN ?? 'unconfigured');
    this.channelSetup = new ChannelSetup(this.store, this.client, env.DISCORD_GUILD_ID);
    this.publisher = new DiscordPublisher(
      this.client,
      this.store,
      data,
      charts,
      this.budget,
      env.DISCORD_GUILD_ID,
      Date.now,
      this.newsPublication,
    );
    this.handler = new CommandHandler(
      this.store,
      this.service,
      this.publisher,
      charts,
      this.budget,
      env.DISCORD_GUILD_ID,
      () => this.store.set('scan_requested', true),
      env.BUILD_INFO?.id ?? 'unknown',
      undefined,
      'production',
      this.newsPublication,
    );
  }
  private configured() {
    return activationIssues(this.env).length === 0;
  }
  async fetch(request: Request): Promise<Response> {
    const requestStartedAt = Date.now();
    const path = new URL(request.url).pathname;
    if (path === '/autocomplete') {
      const message = (await request.json()) as AutocompleteRequest;
      return Response.json(
        cachedSuggestions(
          message,
          this.store.monitored().map((i) => i.symbol),
          this.store.activeIdeas().map((i) => ({
            id: i.candidate.id,
            symbol: i.candidate.instrument.symbol,
            state: i.state,
          })),
          new ThresholdStore(this.store)
            .all()
            .map((m) => ({ id: m.id, symbol: m.instrument.symbol, status: m.status })),
        ),
      );
    }
    if (!this.configured())
      return failureResponse(new Error('BOT_ACTIVATION_REQUIRED'), 'activation');
    if (!this.budget.tick(Date.now()) && path !== '/command')
      return failureResponse(new Error('FREE_ALLOWANCE_SAFETY_LIMIT'), 'budget');
    let stage: FailureStage = 'discord_identity';
    try {
      if (!this.client.user) {
        const raw = (await this.client.rest.get(Routes.user())) as APIUser;
        const Self = ClientUser as unknown as new (client: Client, data: APIUser) => ClientUser;
        this.client.user = new Self(this.client, raw);
      }
      stage = 'discord_guild';
      await this.client.guilds.fetch({ guild: this.env.DISCORD_GUILD_ID, force: true });
      if (this.budget.tick(Date.now())) await this.channelSetup.ensure(this.client.user!.id);
      if (path === '/command') {
        // Existing commands can refresh Discord definitions even without a scheduler tick.
        // Keep diagnostics usable if registration itself fails.
        try {
          await syncCommands(this.store, this.client.rest, this.env.DISCORD_APPLICATION_ID);
          this.store.set('command_registration_error', null);
        } catch (error) {
          this.store.set('command_registration_error', diagnosticCode(error));
        }
        stage = 'command';
        const raw = (await request.json()) as APIChatInputApplicationCommandInteraction;
        // The public Worker has already verified the signature and returned the deferred response.
        const Interaction = ChatInputCommandInteraction as unknown as new (
          client: Client,
          raw: APIChatInputApplicationCommandInteraction,
        ) => ChatInputCommandInteraction;
        const interaction = new Interaction(this.client, raw);
        interaction.deferred = true;
        interaction.deferReply = (async () =>
          undefined) as unknown as typeof interaction.deferReply;
        await this.handler.handle(interaction);
        return new Response('Handled');
      }
      if (path !== '/tick') return new Response('Not found', { status: 404 });
      if (this.busy) return new Response('Already running');
      this.busy = true;
      const tickStartedAt = requestStartedAt;
      try {
        stage = 'command_registration';
        try {
          await syncCommands(this.store, this.client.rest, this.env.DISCORD_APPLICATION_ID);
          this.store.set('command_registration_error', null);
        } catch (error) {
          this.store.set('command_registration_error', diagnosticCode(error));
          throw error;
        }
        queueRelease(this.store, Date.now(), this.env.BUILD_INFO?.id ?? 'unknown');
        const now = Date.now(),
          day = new Date(now).toISOString().slice(0, 10),
          force = this.store.get('scan_requested', false);
        this.store.set('scan_requested', false);
        // Discovery batches advance each minute. Monitoring remains on a five-minute cadence.
        const discoveryDue = this.store.get('discovery_day', '') !== day;
        let scanFailed = false;
        if (
          discoveryDue ||
          force ||
          this.store.get('scan_announcement', null) ||
          now - this.store.get('last_poll', 0) >= 300_000
        ) {
          stage = 'scan';
          try {
            const monitor = force || now - this.store.get('last_poll', 0) >= 300_000;
            await this.service.scan(now, force, monitor, !monitor);
            if (monitor) this.store.set('last_poll', now);
          } catch (error) {
            // Durable deliveries, including operational announcements, do not depend on a
            // successful provider poll. Preserve the failure for /status and release checks.
            scanFailed = true;
            this.store.set('last_error', diagnosticCode(error));
            if (!this.store.get('last_error_stage', null))
              this.store.set('last_error_stage', 'scan');
            this.store.set('soak_start', 0);
          }
        }
        const usage = this.store.get('cloud_usage', { reads: 0, writes: 0, requests: 0 });
        this.store.set(
          'learning_paused',
          usage.reads >= 3_600_000 ||
            usage.writes >= 72_000 ||
            usage.requests >= 72_000 ||
            this.budget.status().storageBytes >= 3_600_000_000,
        );
        try {
          new Learning(this.store).process(now);
          this.store.set('learning_error', null);
        } catch (error) {
          this.store.set('learning_error', diagnosticCode(error));
        }
        try {
          if (this.budget.tick(Date.now())) {
            new Scorecard(this.store).process(now);
            this.store.set('scorecard_error', null);
          }
        } catch {
          this.store.set('scorecard_error', 'SCORECARD_PROCESSING_FAILED');
        }
        try {
          new EntryMeasurements(this.store).process(now);
          new EntryResearch(this.store).process(now);
          this.store.set('entry_research_error', null);
        } catch {
          this.store.set('entry_research_error', 'ENTRY_RESEARCH_FAILED');
        }
        stage = 'publication';
        if (this.store.settings().paused) return new Response('Paused');
        this.store.migrateEntryRoutes();
        const blockers: string[] = [];
        const setup = this.store.get<{ state: string; error?: string }>('channel_setup_status', {
          state: 'pending',
        });
        if (setup.state !== 'ready') blockers.push(setup.error ?? 'CHANNEL_SETUP_PENDING');
        const readyRoutes = new Set<Route>();
        const managed = this.store.get<{
          migrated?: boolean;
          channels?: Partial<Record<Route, string>>;
        }>('managed_channels', {});
        const overrides = this.store.get<Partial<Record<Route, string>>>(
          'managed_channel_overrides',
          {},
        );
        for (const route of routes) {
          const destination = this.store.settings().channels[route];
          if (!destination) {
            blockers.push(`CONFIGURE_CHANNEL:${route}`);
            continue;
          }
          if (
            !managed.migrated &&
            managed.channels?.[route] !== destination &&
            overrides[route] !== destination
          )
            continue;
          try {
            await this.publisher.validate(destination);
            readyRoutes.add(route);
          } catch {
            blockers.push(`CHANNEL_PERMISSIONS:${route}`);
          }
        }
        this.store.set('publication_blockers', blockers);
        let deliveryAttempts = 0;
        for (const pending of this.store
          .pending(now)
          .filter((p) => p.event.kind !== 'news_report' && readyRoutes.has(p.route))
          .slice(0, 3)) {
          if (!this.budget.tick(Date.now())) break;
          deliveryAttempts++;
          try {
            if (pending.event.debug) {
              this.store.db
                .prepare("UPDATE outbox SET status='suppressed' WHERE event_id=?")
                .run(pending.event.id);
              continue;
            }
            const target = this.store.settings().channels[pending.route]!;
            // A legacy root may have been delivered before its thread mirror failed.
            // Rehome its discussion without copying the original message into the new route.
            if (
              this.store.hasReceipt(pending.event.id) &&
              !this.store.receipt(pending.event.id, target)
            )
              await this.publisher.continueDiscussion(pending.event);
            else await this.publisher.deliver(pending.event, target);
            const deliveryState = this.store.db
              .prepare('SELECT status FROM outbox WHERE event_id=?')
              .get(pending.event.id) as { status: string };
            if (deliveryState.status !== 'suppressed') this.store.delivered(pending.event.id);
          } catch {
            this.store.failed(pending.event.id, now, pending.attempts, 'DELIVERY_FAILED');
            this.store.set('delivery_error', { at: now, event: pending.event.id });
          }
        }
        // News runs last and owns its error state independently of market scans.
        if (this.newsIngestion) {
          try {
            const result = await this.newsIngestion.tick(tickStartedAt, () => ({
              reads: this.budget.sql.totalReads,
              writes: this.budget.sql.totalWrites,
              unaccountedReads: this.budget.sql.reads,
              unaccountedWrites: this.budget.sql.writes,
              storageBytes: this.budget.status().storageBytes,
            }));
            if (result.status === 'failed' || this.store.get('news_analysis_error', null))
              this.newsIngestion?.monitor.reset();
            if (
              result.status !== 'disabled' &&
              this.newsPublication &&
              this.budget.tick(Date.now())
            )
              await this.newsIngestion.publicationWork(
                tickStartedAt,
                () => ({
                  reads: this.budget.sql.totalReads,
                  writes: this.budget.sql.totalWrites,
                  unaccountedReads: this.budget.sql.reads,
                  unaccountedWrites: this.budget.sql.writes,
                  storageBytes: this.budget.status().storageBytes,
                }),
                async (canWork) => {
                  try {
                    const publication = this.newsPublication!;
                    publication.queue(Date.now(), canWork);
                    if (deliveryAttempts >= 3 || !canWork()) return;
                    const row = this.store.db
                      .prepare(
                        "SELECT e.body,o.attempts,o.route FROM outbox o JOIN events e ON e.id=o.event_id WHERE o.status='pending' AND o.next_attempt<=? AND json_extract(e.body,'$.kind')='news_report' ORDER BY e.seq LIMIT 1",
                      )
                      .get(Date.now()) as
                      { body: string; attempts: number; route: Route } | undefined;
                    if (!row || !readyRoutes.has(row.route)) return;
                    const event = JSON.parse(row.body) as import('../domain.js').SignalEvent;
                    const destination = publication.destination(event);
                    if (
                      destination &&
                      this.store.hasReceipt(event.id) &&
                      !this.store.receipt(event.id, destination)
                    ) {
                      this.store.transaction(() => {
                        this.store.delivered(event.id);
                        publication.delivered(event, Date.now());
                      });
                      return;
                    }
                    if (!publication.report(event, Date.now())) {
                      publication.suppress(event);
                      return;
                    }
                    if (!canWork()) return;
                    const target = publication.destination(event);
                    if (!target) {
                      publication.suppress(event);
                      return;
                    }
                    try {
                      await this.publisher.deliver(event, target);
                      const state = this.store.db
                        .prepare('SELECT status FROM outbox WHERE event_id=?')
                        .get(event.id) as { status: string };
                      if (state.status === 'suppressed') return;
                      this.store.transaction(() => {
                        this.store.delivered(event.id);
                        publication.delivered(event, Date.now());
                      });
                      this.store.set('news_publication_error', null);
                    } catch {
                      publication.failed();
                      this.store.failed(event.id, Date.now(), row.attempts, 'NEWS_DELIVERY_FAILED');
                      this.store.set('news_publication_error', 'NEWS_DELIVERY_FAILED');
                    }
                  } finally {
                    this.newsIngestion!.monitor.observe(
                      Date.now(),
                      'production',
                      ['complete', 'idle'].includes(result.status) &&
                        !this.store.get('news_analysis_error', null) &&
                        !this.store.get('news_runtime_error', null),
                    );
                  }
                },
              );
          } catch {
            // Defense in depth: even an unexpected news failure is isolated.
            try {
              this.store.set('news_runtime_error', 'NEWS_RUNTIME_FAILED');
              this.newsIngestion?.monitor.reset();
            } catch {}
          }
        }
        if (!scanFailed) {
          this.store.set('last_error', null);
          this.store.set('last_error_stage', null);
        }
        if (this.budget.tick(Date.now())) {
          const work = this.store.get('provider_work', { startedAt: 0, requests: 0 });
          let remaining = 24 - (work.startedAt >= tickStartedAt ? work.requests : 0);
          try {
            remaining -=
              (await this.service.data?.repair?.(Date.now(), remaining, tickStartedAt)) ?? 0;
            this.store.set('history_repair_error', null);
          } catch {
            this.store.set('history_repair_error', 'HISTORY_REPAIR_FAILED');
          }
          try {
            this.service.data?.beginWork?.(remaining, tickStartedAt);
            await this.publisher.enrichEntries?.(Date.now());
          } catch {
            this.store.set('entry_enrichment_error', 'ENTRY_ENRICHMENT_FAILED');
          } finally {
            this.service.data?.endWork?.();
          }
        }
        logEntryRuntime(this.store, this.env.BUILD_INFO?.id, Date.now());
        return new Response(scanFailed ? 'Tick complete; scan failed' : 'Tick complete');
      } finally {
        this.busy = false;
      }
    } catch (e) {
      this.store.set('last_error', diagnosticCode(e));
      if (stage !== 'scan') this.store.set('last_error_stage', stage);
      this.store.set('soak_start', 0);
      return failureResponse(e, stage);
    }
  }
}
