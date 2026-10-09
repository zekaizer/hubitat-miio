import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MiioClient } from '../src/miio/client';
import { fanModel, type HumidifierModel, humidifierModel } from '../src/models';
import { FAKE_TOKEN, FakeDevice } from './support/fake-device';

describe('zhimi.humidifier.ca4', () => {
  let device: FakeDevice;
  let client: MiioClient;
  const humidifier = humidifierModel('zhimi.humidifier.ca4') as HumidifierModel;

  beforeEach(async () => {
    device = await FakeDevice.start('zhimi.humidifier.ca4');
    client = new MiioClient({
      address: device.address,
      port: device.port,
      token: FAKE_TOKEN,
      timeoutMs: 80,
    });
  });

  afterEach(async () => {
    client.close();
    await device.close();
  });

  it('reads the state of the humidifier', async () => {
    expect(await humidifier.read(client)).toEqual({
      power: false,
      mode: 'auto',
      targetHumidity: 70,
      humidity: 47,
      temperature: 29.1,
      waterLevel: 0,
      dry: true,
      fault: 0,
      lock: false,
      buzzer: false,
      light: true,
      brightness: 'bright',
    });
  });

  it('reads what was changed at the humidifier', async () => {
    Object.assign(device.humidifier, {
      '2/1': true,
      '2/5': 3,
      '2/6': 55,
      '2/7': 96,
      '2/8': false,
      '3/9': 38,
      '4/1': true,
      '5/2': 0,
      '6/1': true,
    });
    expect(await humidifier.read(client)).toMatchObject({
      power: true,
      mode: 'high',
      targetHumidity: 55,
      humidity: 38,
      waterLevel: 96,
      dry: false,
      lock: true,
      buzzer: true,
      brightness: 'off',
    });
  });

  it.each([
    [0, 'auto'],
    [1, 'low'],
    [2, 'medium'],
    [3, 'high'],
  ])('reads fan level %i as %s', async (level, mode) => {
    device.humidifier['2/5'] = level;
    expect((await humidifier.read(client)).mode).toBe(mode);
  });

  it.each([
    [0, 'off'],
    [1, 'dim'],
    [2, 'bright'],
  ])('reads screen brightness %i as %s', async (value, brightness) => {
    device.humidifier['5/2'] = value;
    expect((await humidifier.read(client)).brightness).toBe(brightness);
  });

  // A property the device does not have makes others in the same request fail as well.
  it('asks in one request, and only for properties the device has', async () => {
    await humidifier.read(client);
    expect(device.methods).toEqual(['get_properties']);
    const asked = device.requests[0]?.params as Array<{ siid: number; piid: number }>;
    expect(asked.length).toBeLessThanOrEqual(15);
    for (const item of asked) {
      expect(device.humidifier).toHaveProperty([`${item.siid}/${item.piid}`]);
    }
  });

  it('fails to read when the humidifier does not give every property', async () => {
    device.unreadable.add('3/9');
    await expect(humidifier.read(client)).rejects.toThrow(/humidity/);
  });

  it('fails to read a value it does not know the meaning of', async () => {
    device.humidifier['2/5'] = 7;
    await expect(humidifier.read(client)).rejects.toThrow(/mode.*7/);
  });

  // The writes follow the published spec; they were not measured on a real humidifier.
  describe('writes', () => {
    it('turns the humidifier on and off', async () => {
      await humidifier.setPower(client, true);
      expect((await humidifier.read(client)).power).toBe(true);
      await humidifier.setPower(client, false);
      expect((await humidifier.read(client)).power).toBe(false);
    });

    it.each(['low', 'medium', 'high', 'auto'] as const)('sets the mode to %s', async (mode) => {
      await humidifier.setMode(client, mode);
      expect((await humidifier.read(client)).mode).toBe(mode);
    });

    it('sets the target humidity', async () => {
      await humidifier.setTargetHumidity(client, 55);
      expect((await humidifier.read(client)).targetHumidity).toBe(55);
    });

    it('rejects a target humidity the humidifier does not take', async () => {
      await expect(humidifier.setTargetHumidity(client, 90)).rejects.toMatchObject({
        name: 'MiioError',
      });
    });

    it('sets the child lock and the buzzer', async () => {
      await humidifier.setLock(client, true);
      await humidifier.setBuzzer(client, true);
      expect(await humidifier.read(client)).toMatchObject({ lock: true, buzzer: true });
      await humidifier.setLock(client, false);
      await humidifier.setBuzzer(client, false);
      expect(await humidifier.read(client)).toMatchObject({ lock: false, buzzer: false });
    });

    it('turns the screen off and back to bright', async () => {
      await humidifier.setLight(client, false);
      expect(await humidifier.read(client)).toMatchObject({ light: false, brightness: 'off' });
      await humidifier.setLight(client, true);
      expect(await humidifier.read(client)).toMatchObject({ light: true, brightness: 'bright' });
    });

    it('reads a dim screen as a light that is on', async () => {
      device.humidifier['5/2'] = 1;
      expect(await humidifier.read(client)).toMatchObject({ light: true, brightness: 'dim' });
    });
  });

  it('is not a fan', () => {
    expect(fanModel('zhimi.humidifier.ca4')).toBeUndefined();
    expect(humidifierModel('zhimi.fan.za1')).toBeUndefined();
  });
});
