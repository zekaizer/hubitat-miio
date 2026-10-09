import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MiioClient } from '../src/miio/client';
import { type FanModel, fanModel } from '../src/models';
import { FAKE_TOKEN, FakeDevice, type FakeModel } from './support/fake-device';

describe.each<FakeModel>(['zhimi.fan.za1', 'dmaker.fan.p33'])('%s', (name) => {
  let device: FakeDevice;
  let client: MiioClient;
  const fan = fanModel(name) as FanModel;

  // What someone does at the fan itself, behind the plugin's back.
  const atTheFan = {
    turnOff: (): void => {
      device.legacy.power = 'off';
      device.miot['2/1'] = false;
    },
    naturalWind: (): void => {
      device.legacy.mode = 'natural';
      device.legacy.natural_level = device.legacy.speed_level as number;
      device.miot['2/3'] = 1;
    },
    swing: (): void => {
      device.legacy.angle_enable = 'on';
      device.miot['2/4'] = true;
    },
  };

  beforeEach(async () => {
    device = await FakeDevice.start(name);
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

  it('reads the state of the fan', async () => {
    expect(await fan.read(client)).toEqual({
      power: true,
      level: 25,
      oscillation: false,
      natural: false,
      lock: false,
      buzzer: false,
      light: true,
    });
  });

  it('turns the fan off and on', async () => {
    await fan.setPower(client, false);
    expect((await fan.read(client)).power).toBe(false);
    await fan.setPower(client, true);
    expect((await fan.read(client)).power).toBe(true);
  });

  it('sets the speed', async () => {
    await fan.setLevel(client, 60, await fan.read(client));
    expect(await fan.read(client)).toMatchObject({ power: true, level: 60 });
  });

  it('turns the fan on when the speed is set while it is off', async () => {
    await fan.setPower(client, false);
    await fan.setLevel(client, 40, await fan.read(client));
    expect(await fan.read(client)).toMatchObject({ power: true, level: 40 });
  });

  it('turns the fan on when it was switched off at the fan since the last read', async () => {
    const known = await fan.read(client);
    atTheFan.turnOff();
    await fan.setLevel(client, 40, known);
    expect(await fan.read(client)).toMatchObject({ power: true, level: 40 });
  });

  it('turns the fan on when the speed is set before any state was read', async () => {
    atTheFan.turnOff();
    await fan.setLevel(client, 40);
    expect(await fan.read(client)).toMatchObject({ power: true, level: 40 });
  });

  it('keeps natural wind when the speed changes', async () => {
    atTheFan.naturalWind();
    await fan.setLevel(client, 70, await fan.read(client));
    expect(await fan.read(client)).toMatchObject({ natural: true, level: 70 });
  });

  it('rejects a speed the fan does not take', async () => {
    await expect(fan.setLevel(client, 101, await fan.read(client))).rejects.toMatchObject({
      name: 'MiioError',
    });
  });

  it('turns oscillation on and off', async () => {
    await fan.setOscillation(client, true);
    expect((await fan.read(client)).oscillation).toBe(true);
    await fan.setOscillation(client, false);
    expect((await fan.read(client)).oscillation).toBe(false);
  });

  it('sets the child lock, the buzzer and the light', async () => {
    await fan.setLock(client, true);
    await fan.setBuzzer(client, true);
    await fan.setLight(client, false);
    expect(await fan.read(client)).toMatchObject({ lock: true, buzzer: true, light: false });
    await fan.setLock(client, false);
    await fan.setBuzzer(client, false);
    await fan.setLight(client, true);
    expect(await fan.read(client)).toMatchObject({ lock: false, buzzer: false, light: true });
  });

  it('changes the lock, the buzzer and the light while the fan is off', async () => {
    await fan.setPower(client, false);
    await fan.setLock(client, true);
    await fan.setBuzzer(client, true);
    await fan.setLight(client, false);
    expect(await fan.read(client)).toMatchObject({
      power: false,
      lock: true,
      buzzer: true,
      light: false,
    });
  });

  it('turns the head one step', async () => {
    await fan.move(client, 'left');
    await fan.move(client, 'right');
    expect(device.moves).toEqual(['left', 'right']);
  });

  it('does not send a step again when its reply is lost', async () => {
    device.dropReplies = 1;
    await expect(fan.move(client, 'left')).rejects.toMatchObject({ name: 'MiioTimeoutError' });
    expect(device.moves).toEqual(['left']);
  });

  it('knows how many steps the head takes across its range', () => {
    expect(fan.moveSteps).toBeGreaterThan(20);
  });

  it('fails to read when the fan does not give every property', async () => {
    delete device.legacy.speed_level;
    device.unreadable.add('2/6');
    await expect(fan.read(client)).rejects.toThrow(/speed|level|2\/6/);
  });

  if (name === 'zhimi.fan.za1') {
    it('reports a move the fan refuses because it is swinging', async () => {
      atTheFan.swing();
      await expect(fan.move(client, 'left')).rejects.toMatchObject({ code: -6007 });
    });
  }
});

describe('fan models', () => {
  it('does not know other models', () => {
    expect(fanModel('zhimi.humidifier.ca4')).toBeUndefined();
  });
});
