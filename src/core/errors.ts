// Persist only known diagnostic codes; arbitrary exception text may contain credentials.
export function diagnosticCode(error: unknown): string {
  if (!(error instanceof Error)) return 'WORKER_OPERATION_FAILED';
  if (error.name.startsWith('DiscordAPIError') || error.name === 'HTTPError') {
    const discord = error as Error & { code?: number; status?: number };
    if (discord.status === 401) return 'DISCORD_INVALID_TOKEN';
    if (discord.code === 50001) return 'DISCORD_MISSING_ACCESS';
    if (discord.code === 50013) return 'DISCORD_MISSING_PERMISSIONS';
    if (discord.code === 10004) return 'DISCORD_UNKNOWN_GUILD';
    if (Number.isInteger(discord.status) && discord.status! >= 400 && discord.status! <= 599)
      return `DISCORD_HTTP_${discord.status}`;
  }
  if (/^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)) return error.message;
  if (
    /^(?:NETWORK_UNAVAILABLE|DATA_HTTP_\d{3}):(api\.exchange\.coinbase\.com|paper-api\.alpaca\.markets|data\.alpaca\.markets)$/.test(
      error.message,
    )
  )
    return error.message;
  return 'WORKER_OPERATION_FAILED';
}
