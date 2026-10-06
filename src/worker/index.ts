import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import type { Env } from './types.js';
export { SignalCoordinator } from './coordinator.js';
import { verifySignature } from './signature.js';
import { activationIssues } from './activation.js';
import { failureMessage, failureResponse } from './failures.js';
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/interactions')
      return new Response('Not found', { status: 404 });
    if (Number(request.headers.get('content-length') ?? 0) > 32_768)
      return new Response('Too large', { status: 413 });
    const body = await request.text();
    if (body.length > 32_768) return new Response('Too large', { status: 413 });
    if (
      !(await verifySignature(
        body,
        request.headers.get('x-signature-ed25519'),
        request.headers.get('x-signature-timestamp'),
        env.DISCORD_PUBLIC_KEY,
      ))
    )
      return new Response('Invalid signature', { status: 401 });
    let message: { type: number; guild_id?: string; application_id?: string; token?: string };
    try {
      message = JSON.parse(body);
    } catch {
      return new Response('Malformed JSON', { status: 400 });
    }
    if (message.type === 1) return Response.json({ type: 1 });
    if (message.type !== 2 || message.guild_id !== env.DISCORD_GUILD_ID)
      return Response.json({
        type: 4,
        data: { content: 'This bot serves one configured private server.', flags: 64 },
      });
    const issues = activationIssues(env);
    if (issues.length)
      return Response.json({
        type: 4,
        data: {
          content: `Bot activation blocked:\n${issues.map((issue) => `• ${issue}`).join('\n')}\nUpdate this Worker's runtime settings in Cloudflare, then save/deploy.`,
          flags: 64,
        },
      });
    const stub = env.SIGNALS.get(env.SIGNALS.idFromName(env.DISCORD_GUILD_ID));
    ctx.waitUntil(
      stub
        .fetch('https://internal/command', { method: 'POST', body })
        .catch(() => failureResponse(new Error('COORDINATOR_REQUEST_FAILED'), 'command'))
        .then(async (response) => {
          if (!response.ok && message.application_id && message.token)
            await fetch(
              `https://discord.com/api/v10/webhooks/${encodeURIComponent(message.application_id)}/${encodeURIComponent(message.token)}/messages/@original`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  content: await failureMessage(response),
                }),
              },
            );
        }),
    );
    return Response.json({ type: 5, data: { flags: 64 } });
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.DISCORD_GUILD_ID) return;
    const stub = env.SIGNALS.get(env.SIGNALS.idFromName(env.DISCORD_GUILD_ID));
    ctx.waitUntil(stub.fetch('https://internal/tick', { method: 'POST' }).then(() => {}));
  },
};
