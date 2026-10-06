import { Routes, type REST } from 'discord.js';
import type { Store } from '../sql-store.js';
import { commands } from './commands.js';
import { stableId } from '../core/strategy.js';

/** Register once per application/definition change using the deployed bot token. */
export async function syncCommands(
  store: Store,
  rest: Pick<REST, 'put'>,
  applicationId: string,
): Promise<void> {
  const body = commands.map((c) => ({ ...c.toJSON(), integration_types: [0], contexts: [0] }));
  const version = stableId(applicationId, JSON.stringify(body));
  if (store.get('command_registration', '') === version) return;
  await rest.put(Routes.applicationCommands(applicationId), { body });
  store.set('command_registration', version);
  store.set('command_registration_details', {
    at: Date.now(),
    names: commands.map((c) => c.toJSON().name),
  });
}
