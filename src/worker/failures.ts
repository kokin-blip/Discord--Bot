import { diagnosticCode } from '../core/errors.js';

export type FailureStage =
  | 'activation'
  | 'budget'
  | 'discord_identity'
  | 'discord_guild'
  | 'command'
  | 'scan'
  | 'publication';
const stages: FailureStage[] = [
  'activation',
  'budget',
  'discord_identity',
  'discord_guild',
  'command',
  'scan',
  'publication',
];

export function failureResponse(error: unknown, stage: FailureStage): Response {
  return Response.json({ error: diagnosticCode(error), stage }, { status: 503 });
}

export async function failureMessage(response: {
  status: number;
  json(): Promise<unknown>;
}): Promise<string> {
  let code = `COORDINATOR_HTTP_${response.status}`;
  let stage = 'coordinator';
  try {
    const data = (await response.json()) as { error?: unknown; stage?: unknown };
    if (typeof data.error === 'string') code = diagnosticCode(new Error(data.error));
    if (typeof data.stage === 'string' && stages.includes(data.stage as FailureStage))
      stage = data.stage;
  } catch {
    // Do not forward unstructured response bodies or exception messages.
  }
  const help: Record<string, string> = {
    DISCORD_INVALID_TOKEN:
      'Check DISCORD_TOKEN in Cloudflare: use this application’s Bot token, not its public key or OAuth secret.',
    DISCORD_MISSING_ACCESS: 'Check DISCORD_GUILD_ID and that this bot is installed in the server.',
    DISCORD_UNKNOWN_GUILD: 'Check DISCORD_GUILD_ID and that this bot is installed in the server.',
    DISCORD_MISSING_PERMISSIONS: 'Check the bot’s server and channel permissions.',
  };
  return `Operation unavailable: ${code}.\nStep: ${stage}.${help[code] ? `\n${help[code]}` : '\nCheck the Worker configuration and runtime logs.'}`;
}
