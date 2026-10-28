import { ChannelType, PermissionFlagsBits, Routes, type Client } from 'discord.js';
import { routes, type Route } from '../config.js';
import type { Store } from '../sql-store.js';

export const channelNames: Record<Route, string> = {
  equity_ideas: 'equity-ideas',
  crypto_ideas: 'crypto-ideas',
  updates: 'trade-updates',
  watchlist: 'watchlist-alerts',
  summaries: 'daily-summaries',
  operations: 'bot-operations',
  entries: 'entries',
};
interface ChannelRecord {
  id: string;
  type: number;
  name: string;
  parent_id?: string | null;
  topic?: string | null;
  permission_overwrites?: { id: string; allow: string; deny: string }[];
}
interface ManagedState {
  categoryId?: string;
  channels: Partial<Record<Route, string>>;
  previousChannels: Partial<Record<Route, string>>;
  migrated: boolean;
}
export interface ChannelSetupStatus {
  state: 'pending' | 'ready' | 'error';
  categoryId?: string;
  channels: Partial<Record<Route, string>>;
  error: string | null;
}
/** REST-only setup. Persist each successful create before attempting the next object. */
export class ChannelSetup {
  private inFlight?: Promise<ChannelSetupStatus>;
  constructor(
    readonly store: Store,
    readonly client: Pick<Client, 'rest'>,
    readonly guildId: string,
  ) {}
  ensure(botId: string): Promise<ChannelSetupStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.provision(botId).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  private async provision(botId: string): Promise<ChannelSetupStatus> {
    const persisted = this.store.get<ManagedState | null>('managed_channels', null);
    const state =
      persisted ??
      ({
        channels: {},
        previousChannels: this.store.settings().channels,
        migrated: false,
      } as ManagedState);
    let saved = persisted ? JSON.stringify(persisted) : '';
    const save = () => {
      const value = JSON.stringify(state);
      if (value !== saved) {
        this.store.set('managed_channels', state);
        saved = value;
      }
    };
    save();
    const status = (value: ChannelSetupStatus['state'], error: string | null = null) => {
      const result = {
        state: value,
        categoryId: state.categoryId,
        channels: this.store.settings().channels,
        error,
      };
      if (JSON.stringify(this.store.get('channel_setup_status', null)) !== JSON.stringify(result))
        this.store.set('channel_setup_status', result);
      return result;
    };
    try {
      const inventory = (await this.client.rest.get(
        Routes.guildChannels(this.guildId),
      )) as ChannelRecord[];
      if (!Array.isArray(inventory)) throw new Error('CHANNEL_INVENTORY_UNAVAILABLE');
      const publicPermissions =
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.ReadMessageHistory |
        PermissionFlagsBits.UseApplicationCommands |
        PermissionFlagsBits.SendMessagesInThreads;
      const permissions = [
        {
          id: this.guildId,
          type: 0,
          allow: String(publicPermissions),
          deny: String(
            PermissionFlagsBits.SendMessages |
              PermissionFlagsBits.CreatePublicThreads |
              PermissionFlagsBits.CreatePrivateThreads,
          ),
        },
        {
          id: botId,
          type: 1,
          allow: String(
            publicPermissions |
              PermissionFlagsBits.ManageChannels |
              PermissionFlagsBits.SendMessages |
              PermissionFlagsBits.EmbedLinks |
              PermissionFlagsBits.AttachFiles |
              PermissionFlagsBits.CreatePublicThreads |
              PermissionFlagsBits.ManageThreads,
          ),
          deny: '0',
        },
      ];
      const marker = (route: Route) => `discord-trading-signals:${botId}:${this.guildId}:${route}`;
      let creates = 0;
      const create = async (body: object) => {
        const channel = (await this.client.rest.post(Routes.guildChannels(this.guildId), {
          body,
          reason: 'Automatic Trading Bot channel setup',
        })) as ChannelRecord;
        if (!channel.id) throw new Error('CHANNEL_CREATE_UNCERTAIN');
        inventory.push(channel);
        creates++;
        return channel;
      };
      let category = inventory.find(
        (c) => c.id === state.categoryId && c.type === ChannelType.GuildCategory,
      );
      if (!category) {
        // Includes recovery after Discord accepted a create whose response/database save was lost.
        const candidates = inventory.filter(
          (c) =>
            c.type === ChannelType.GuildCategory &&
            c.name === 'Trading Bot' &&
            (inventory.some(
              (child) => child.parent_id === c.id && routes.some((r) => child.topic === marker(r)),
            ) ||
              c.permission_overwrites?.some(
                (p) => p.id === botId && p.allow === permissions[1]!.allow,
              )),
        );
        if (candidates.length > 1) throw new Error('CHANNEL_SETUP_AMBIGUOUS');
        category =
          candidates[0] ??
          (await create({
            name: 'Trading Bot',
            type: ChannelType.GuildCategory,
            permission_overwrites: permissions,
          }));
        state.categoryId = category.id;
        save();
      }
      for (const route of routes) {
        const overrides = this.store.get<Partial<Record<Route, string>>>(
          'managed_channel_overrides',
          {},
        );
        if (overrides[route]) continue;
        let channel = inventory.find(
          (c) => c.id === state.channels[route] && c.type === ChannelType.GuildText,
        );
        if (!channel) {
          const matches = inventory.filter(
            (c) => c.type === ChannelType.GuildText && c.topic === marker(route),
          );
          if (matches.length > 1) throw new Error('CHANNEL_SETUP_AMBIGUOUS');
          channel = matches[0];
        }
        if (!channel) {
          if (creates >= 2) return status('pending');
          channel = await create({
            name: channelNames[route],
            type: ChannelType.GuildText,
            parent_id: category.id,
            topic: marker(route),
            permission_overwrites: permissions,
          });
        } else if (channel.parent_id !== category.id) {
          await this.client.rest.patch(Routes.channel(channel.id), {
            body: { parent_id: category.id },
          });
        }
        state.channels[route] = channel.id;
        save();
        // Re-read settings after I/O so setup never clobbers unrelated settings.
        const settings = this.store.settings();
        if (settings.channels[route] !== channel.id) {
          settings.channels[route] = channel.id;
          this.store.set('settings', settings);
        }
      }
      state.migrated = true;
      save();
      return status('ready');
    } catch (error) {
      const details = (error ?? {}) as { status?: number; code?: number };
      const code =
        details.status === 403 || details.code === 50013
          ? 'CHANNEL_SETUP_MISSING_PERMISSIONS'
          : error instanceof Error &&
              /^CHANNEL_(SETUP_AMBIGUOUS|INVENTORY_UNAVAILABLE|CREATE_UNCERTAIN)$/.test(
                error.message,
              )
            ? error.message
            : 'CHANNEL_SETUP_FAILED';
      return status('error', code);
    }
  }
}
