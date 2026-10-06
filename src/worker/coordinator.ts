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
    );
  }
  private configured() {
    return activationIssues(this.env).length === 0;
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
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
        await syncCommands(this.store, this.client.rest, this.env.DISCORD_APPLICATION_ID);
        const now = Date.now(),
          day = new Date(now).toISOString().slice(0, 10),
          force = this.store.get('scan_requested', false);
        this.store.set('scan_requested', false);
        // Discovery batches advance each minute. Monitoring remains on a five-minute cadence.
        const discoveryDue = this.store.get('discovery_day', '') !== day;
        if (
          discoveryDue ||
          force ||
          this.store.get('scan_announcement', null) ||
          now - this.store.get('last_poll', 0) >= 300_000
        ) {
          stage = 'scan';
          await this.service.scan(now, force);
          this.store.set('last_poll', now);
        }
        stage = 'publication';
        if (this.store.settings().paused) return new Response('Paused');
        if (this.env.RELEASE_MODE === 'production') {
          const soak = this.store.get('soak_start', 0);
          if (
            !soak ||
            now - soak < 7 * 86_400_000 ||
            now - this.store.get('healthy_at', 0) > 600_000
          )
            throw new Error('SEVEN_DAY_SOAK_REQUIRED');
          if (!this.store.get<boolean>('historical_replay_verified', false))
            throw new Error('HISTORICAL_REPLAY_REQUIRED');
          if (routes.some((r) => !this.store.settings().channels[r]))
            throw new Error('CONFIGURE_ALL_CHANNELS');
          for (const route of routes)
            await this.publisher.validate(this.store.settings().channels[route]!);
        } else {
          if (!this.env.TEST_CHANNEL_ID) throw new Error('TEST_CHANNEL_REQUIRED');
          await this.publisher.validate(this.env.TEST_CHANNEL_ID);
        }
        for (const pending of this.store.pending(now).slice(0, 3)) {
          if (!this.budget.tick(Date.now())) break;
          try {
            const target =
              this.env.RELEASE_MODE === 'production'
                ? this.store.settings().channels[pending.route]!
                : this.env.TEST_CHANNEL_ID;
            await this.publisher.deliver(pending.event, target);
            this.store.delivered(pending.event.id);
          } catch {
            this.store.failed(pending.event.id, now, pending.attempts, 'DELIVERY_FAILED');
            this.store.set('soak_start', 0);
          }
        }
        this.store.set('last_error', null);
        this.store.set('last_error_stage', null);
        return new Response('Tick complete');
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
