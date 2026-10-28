import { expect, it, vi } from 'vitest';
import { Store } from '../src/storage.js';
import { syncCommands } from '../src/discord/registration.js';
it('syncs global server commands once, including tracker controls, and retries a failed registration', async () => {
  const store = new Store(':memory:');
  const rest = { put: vi.fn(async () => []) };
  try {
    rest.put.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(syncCommands(store, rest, 'application')).rejects.toThrow('Unauthorized');
    expect(store.get('command_registration', '')).toBe('');
    await syncCommands(store, rest, 'application');
    await syncCommands(store, rest, 'application');
    expect(rest.put).toHaveBeenCalledTimes(2);
    expect(store.get('command_registration_details', {})).toMatchObject({
      names: expect.arrayContaining(['debug']),
    });
    const calls = rest.put.mock.calls as unknown as [string, { body: any[] }][];
    expect(calls[1]![0]).toBe('/applications/application/commands');
    const body = calls[1]![1].body;
    expect(body.every((c) => c.contexts[0] === 0 && c.integration_types[0] === 0)).toBe(true);
    const alerts = body
      .find((c) => c.name === 'config')
      .options.find((s: any) => s.name === 'alerts');
    const channelRoute = body
      .find((c) => c.name === 'config')
      .options.find((s: any) => s.name === 'channels')
      .options.find((o: any) => o.name === 'route');
    expect(channelRoute.choices).toContainEqual({ name: 'entries', value: 'entries' });
    expect(alerts.options.map((o: any) => o.name)).toEqual([
      'enabled',
      'options',
      'volume',
      'range',
      'range_multiplier',
      'reversals',
      'volume_multiplier',
    ]);
    await syncCommands(store, rest, 'different-application');
    expect(rest.put).toHaveBeenCalledTimes(3);
  } finally {
    store.close();
  }
});
it('registers news reads and manager controls through the existing guild-bound definitions', async () => {
  const store = new Store(':memory:');
  try {
    const rest = { put: vi.fn(async () => []) };
    await syncCommands(store, rest, 'application');
    const body = (rest.put.mock.calls as unknown as [string, { body: any[] }][])[0]![1].body;
    const news = body.find((c) => c.name === 'news');
    expect(news.contexts).toEqual([0]);
    expect(news.integration_types).toEqual([0]);
    expect(news.options.map((s: any) => s.name)).toEqual([
      'latest',
      'sentiment',
      'sources',
      'status',
      'config',
    ]);
    expect(
      news.options.find((s: any) => s.name === 'config').options.map((o: any) => o.name),
    ).toEqual([
      'enabled',
      'marketaux',
      'currents',
      'gdelt',
      'digest',
      'alerts',
      'marketaux_cap',
      'currents_cap',
      'gdelt_cap',
      'review_sha256',
      'reviewed_mappings',
      'false_mappings',
      'reviewed_alerts',
      'false_alerts',
      'free_plan_verified',
    ]);
  } finally {
    store.close();
  }
});
