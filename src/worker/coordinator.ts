import { cachedSuggestions, type AutocompleteRequest } from '../discord/autocomplete.js';
import { productionBlockers, canPublishProduction, publicationVersion } from './publication.js';
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
import { routes } from '../config.js';
import { syncCommands } from '../discord/registration.js';
import { diagnosticCode } from '../core/errors.js';
import { activationIssues } from './activation.js';
import { failureResponse, type FailureStage } from './failures.js';
export class SignalCoordinator {
  readonly store: Store;
  readonly budget: CloudBudget;
  readonly service: SignalService;
  readonly publisher: DiscordPublisher;
  readonly handler: CommandHandler;
  readonly client: Client;
  private busy = false;
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {
    const sql = new CloudSql(ctx.storage);
    this.store = new Store(sql);
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
    this.publisher = new DiscordPublisher(
      this.client,
      this.store,
      data,
      charts,
      this.budget,
      env.DISCORD_GUILD_ID,
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
      env.TEST_CHANNEL_ID,
      env.RELEASE_MODE,
    );
  }
  private configured() {
    return activationIssues(this.env).length === 0;
  }
  async fetch(request: Request): Promise<Response> {
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
        stage = 'publication';
        if (this.store.settings().paused) return new Response('Paused');
        let newPublicationReady = true;
        if (this.env.RELEASE_MODE === 'production') {
          const blockers = productionBlockers(this.store, now);
          for (const route of routes) {
            const destination = this.store.settings().channels[route];
            if (!destination) {
              blockers.push(`CONFIGURE_CHANNEL:${route}`);
              continue;
            }
            try {
              await this.publisher.validate(destination);
            } catch {
              blockers.push(`CHANNEL_PERMISSIONS:${route}`);
            }
          }
          this.store.set('publication_blockers', blockers);
          newPublicationReady = !blockers.length;
          if (newPublicationReady)
            this.store.set(`production_version:${publicationVersion(this.store)}`, {
              approvedAt: now,
            });
          // Upgrade compatibility: a root in a distinct production route proves prior production publication.
          for (const idea of this.store.activeIdeas()) {
            const root = this.store.thread(idea.candidate.id);
            const route =
              idea.candidate.instrument.market === 'equity' ? 'equity_ideas' : 'crypto_ideas';
            if (
              root?.channel === this.store.settings().channels[route] &&
              root?.channel !== this.env.TEST_CHANNEL_ID &&
              root?.thread
            )
              this.store.set(
                `production_idea:${idea.candidate.id}`,
                idea.candidate.strategyVersion,
              );
          }
        } else {
          if (!this.env.TEST_CHANNEL_ID) throw new Error('TEST_CHANNEL_REQUIRED');
          await this.publisher.validate(this.env.TEST_CHANNEL_ID);
        }
        for (const pending of this.store
          .pending(now, this.env.RELEASE_MODE === 'production' && !newPublicationReady)
          .slice(0, 3)) {
          if (!this.budget.tick(Date.now())) break;
          if (
            this.env.RELEASE_MODE === 'production' &&
            !canPublishProduction(this.store, pending.event, newPublicationReady)
          )
            continue;
          try {
            const target =
              this.env.RELEASE_MODE === 'production'
                ? this.store.settings().channels[pending.route]!
                : this.env.TEST_CHANNEL_ID;
            await this.publisher.deliver(pending.event, target);
            if (
              this.env.RELEASE_MODE === 'production' &&
              pending.event.strategyVersion.startsWith('br-v1-')
            )
              this.store.set(
                `production_idea:${pending.event.ideaId}`,
                pending.event.strategyVersion,
              );
            this.store.delivered(pending.event.id);
          } catch {
            const target =
              this.env.RELEASE_MODE === 'production'
                ? this.store.settings().channels[pending.route]
                : this.env.TEST_CHANNEL_ID;
            if (
              this.env.RELEASE_MODE === 'production' &&
              target &&
              this.store.receipt(pending.event.id, target) &&
              pending.event.strategyVersion.startsWith('br-v1-')
            )
              this.store.set(
                `production_idea:${pending.event.ideaId}`,
                pending.event.strategyVersion,
              );
            if (this.env.RELEASE_MODE === 'test') this.store.set('soak_start', 0);
            this.store.failed(pending.event.id, now, pending.attempts, 'DELIVERY_FAILED');
            this.store.set('delivery_error', { at: now, event: pending.event.id });
          }
        }
        if (!scanFailed) {
          this.store.set('last_error', null);
          this.store.set('last_error_stage', null);
        }
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
