import { afterEach, describe, expect, it } from 'vitest';

import { MiioClient, type MiioClientOptions } from '../src/miio/client';
import { FAKE_TOKEN, FakeDevice, type FakeModel } from './support/fake-device';

let device: FakeDevice;
let client: MiioClient;

async function setup(
  model: FakeModel = 'zhimi.fan.za1',
  options: Partial<MiioClientOptions> = {},
): Promise<void> {
  device = await FakeDevice.start(model);
  client = new MiioClient({
    address: device.address,
    port: device.port,
    token: FAKE_TOKEN,
    timeoutMs: 80,
    ...options,
  });
}

afterEach(async () => {
  client.close();
  await device.close();
});

describe('miio client', () => {
  it('returns the result of a request', async () => {
    await setup();
    await expect(client.call('get_prop', ['power', 'speed_level'])).resolves.toEqual(['on', 25]);
  });

  it('rejects with the error the device answers', async () => {
    await setup();
    await expect(client.call('no_such_method', [])).rejects.toMatchObject({
      name: 'MiioError',
      code: -5000,
    });
  });

  it('sends a request again, after a new handshake, when the reply is lost', async () => {
    await setup();
    device.dropReplies = 1;
    await expect(client.call('get_prop', ['power'])).resolves.toEqual(['on']);
    expect(device.methods).toEqual(['get_prop', 'get_prop']);
    expect(device.hellos).toBe(2);
  });

  it('gives up on a device that does not answer at all', async () => {
    await setup('zhimi.fan.za1', { retries: 2 });
    device.silent = true;
    await expect(client.call('get_prop', ['power'])).rejects.toMatchObject({
      name: 'MiioTimeoutError',
      handshakeAnswered: false,
    });
  });

  it('tells a device that answers only the handshake apart: that is a wrong token', async () => {
    await setup();
    device.dropRequests = true;
    await expect(client.call('get_prop', ['power'])).rejects.toMatchObject({
      name: 'MiioTimeoutError',
      handshakeAnswered: true,
    });
    expect(device.hellos).toBe(3);
  });

  it('does not take a second handshake reply for the reply to a request', async () => {
    await setup();
    device.strayHello = 1;
    await expect(client.call('get_prop', ['power'])).resolves.toEqual(['on']);
    expect(device.methods).toEqual(['get_prop', 'get_prop']);
  });

  it('answers the next request after a stray handshake reply arrives late', async () => {
    await setup();
    device.strayHello = 1;
    await client.call('get_prop', ['power']);
    await expect(client.call('get_prop', ['speed_level'])).resolves.toEqual([25]);
  });

  it('sends one request at a time', async () => {
    await setup();
    device.delayMs = 15;
    const replies = await Promise.all([
      client.call('get_prop', ['power']),
      client.call('get_prop', ['speed_level']),
      client.call('get_prop', ['angle']),
    ]);
    expect(replies).toEqual([['on'], [25], [120]]);
    expect(device.maxInFlight).toBe(1);
  });

  it('keeps going after a request fails', async () => {
    await setup();
    await expect(client.call('no_such_method', [])).rejects.toThrow();
    await expect(client.call('get_prop', ['power'])).resolves.toEqual(['on']);
  });

  it('reuses a handshake and renews it once it is old', async () => {
    await setup('zhimi.fan.za1', { handshakeTtlMs: 40 });
    await client.call('get_prop', ['power']);
    await client.call('get_prop', ['power']);
    expect(device.hellos).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await client.call('get_prop', ['power']);
    expect(device.hellos).toBe(2);
  });

  it('does not send a request again when told not to', async () => {
    await setup();
    device.dropReplies = 1;
    await expect(client.call('set_move', ['left'], { retry: false })).rejects.toMatchObject({
      name: 'MiioTimeoutError',
    });
    expect(device.moves).toEqual(['left']);
  });

  it('rejects the call that is waiting when it is closed', async () => {
    await setup('zhimi.fan.za1', { timeoutMs: 5000 });
    device.silent = true;
    const call = client.call('get_prop', ['power']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    client.close();
    await expect(call).rejects.toThrow(/closed/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('refuses a token that is not 32 hex characters', async () => {
    await setup();
    expect(() => new MiioClient({ address: '127.0.0.1', token: 'not-a-token' })).toThrow(/32 hex/);
  });
});
