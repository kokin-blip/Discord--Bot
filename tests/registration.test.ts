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
