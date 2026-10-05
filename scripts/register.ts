import { REST, Routes } from 'discord.js';
import { commands } from '../src/discord/commands.js';
const { DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID || !DISCORD_GUILD_ID)
  throw new Error('Set Discord token, application ID, and guild ID in .env');
await new REST({ version: '10' })
  .setToken(DISCORD_TOKEN)
  .put(Routes.applicationGuildCommands(DISCORD_APPLICATION_ID, DISCORD_GUILD_ID), {
    body: commands.map((c) => c.toJSON()),
  });
console.log('Private-server commands registered.');
