import { REST, Routes } from 'discord.js';
import { commands } from '../src/discord/commands.js';
const { DISCORD_TOKEN, DISCORD_APPLICATION_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID)
  throw new Error('Set Discord token and application ID in .env');
await new REST({ version: '10' })
  .setToken(DISCORD_TOKEN)
  .put(Routes.applicationCommands(DISCORD_APPLICATION_ID), {
    body: commands.map((c) => ({ ...c.toJSON(), integration_types: [0], contexts: [0] })),
  });
console.log(
  'Global server commands registered: ' + commands.map((c) => '/' + c.toJSON().name).join(', '),
);
