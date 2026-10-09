import type { Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';
import { afterEach, describe, expect, it } from 'vitest';

import { FanAccessory, type FanAccessoryOptions } from '../src/fan-accessory';
import { MODELS, Rig } from './support/fan-rig';

const api = new HomebridgeAPI();
const { Service: S, Characteristic: C, HAPStatus } = api.hap;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(MODELS)('fan accessory: %s', (name) => {
  let rig: Rig;
  let accessory: PlatformAccessory;

  const attach = (options: Partial<FanAccessoryOptions> = {}): void => {
    new FanAccessory(api.hap, accessory, rig.fan, {
      name: 'Fan',
      moveSwitches: false,
      info: { model: name, firmware: '1.2.3', serial: 'AA:BB:CC:DD:FA:CE' },
      ...options,
    });
  };

  async function setup(options: Partial<FanAccessoryOptions> = {}, off = false): Promise<void> {
    rig = await Rig.create(name);
    rig.atTheFan.power(!off);
    accessory = new api.platformAccessory('Fan', api.hap.uuid.generate(name));
    attach(options);
    await rig.started();
  }

  afterEach(async () => {
    await rig.close();
  });

  const fanService = (): Service => accessory.getService(S.Fanv2) as Service;
  const moveSwitch = (direction: 'left' | 'right'): Service | undefined =>
    accessory.getServiceById(S.Switch, `move-${direction}`);
  const value = (service: Service, characteristic: WithUUID<new () => Characteristic>): unknown =>
    service.getCharacteristic(characteristic).value;
  const set = async (
    service: Service,
    characteristic: WithUUID<new () => Characteristic>,
    to: number | boolean,
  ): Promise<void> => {
    service.getCharacteristic(characteristic).setValue(to);
    await rig.fan.idle();
  };

  it('shows the state of the fan', async () => {
    await setup();
    const fan = fanService();
    expect(value(fan, C.Active)).toBe(C.Active.ACTIVE);
    expect(value(fan, C.CurrentFanState)).toBe(C.CurrentFanState.BLOWING_AIR);
    expect(value(fan, C.RotationSpeed)).toBe(25);
    expect(value(fan, C.SwingMode)).toBe(C.SwingMode.SWING_DISABLED);
    expect(value(fan, C.LockPhysicalControls)).toBe(C.LockPhysicalControls.CONTROL_LOCK_DISABLED);
  });

  it('shows a fan that is off as inactive, with the speed it will start at', async () => {
    await setup({}, true);
    const fan = fanService();
    expect(value(fan, C.Active)).toBe(C.Active.INACTIVE);
    expect(value(fan, C.CurrentFanState)).toBe(C.CurrentFanState.INACTIVE);
    expect(value(fan, C.RotationSpeed)).toBe(25);
  });

  it('describes the device', async () => {
    await setup();
    const info = accessory.getService(S.AccessoryInformation) as Service;
    expect(value(info, C.Manufacturer)).toBe('Xiaomi');
    expect(value(info, C.Model)).toBe(name);
    expect(value(info, C.SerialNumber)).toBe('AA:BB:CC:DD:FA:CE');
    expect(value(info, C.FirmwareRevision)).toBe('1.2.3');
  });

  it('sets the speed from HomeKit', async () => {
    await setup();
    await set(fanService(), C.RotationSpeed, 60);
    expect(rig.real).toMatchObject({ power: true, level: 60 });
    expect(value(fanService(), C.RotationSpeed)).toBe(60);
  });

  it('turns the fan off and on from HomeKit', async () => {
    await setup();
    await set(fanService(), C.Active, C.Active.INACTIVE);
    expect(rig.real.power).toBe(false);
    expect(value(fanService(), C.CurrentFanState)).toBe(C.CurrentFanState.INACTIVE);
    await set(fanService(), C.Active, C.Active.ACTIVE);
    expect(rig.real).toMatchObject({ power: true, level: 25 });
  });

  it('turns the fan off for speed 0', async () => {
    await setup();
    await set(fanService(), C.RotationSpeed, 0);
    expect(rig.real.power).toBe(false);
    expect(value(fanService(), C.Active)).toBe(C.Active.INACTIVE);
  });

  it('writes once when HomeKit sends the speed and then the power for a fan that is off', async () => {
    await setup({}, true);
    fanService().getCharacteristic(C.RotationSpeed).setValue(70);
    fanService().getCharacteristic(C.Active).setValue(C.Active.ACTIVE);
    await rig.fan.idle();
    expect(rig.real).toMatchObject({ power: true, level: 70 });
    expect(rig.writes.filter((w) => /set_speed_level|2\/6/.test(w))).toHaveLength(1);
    expect(rig.writes.filter((w) => w === 'set 2/1')).toEqual([]);
  });

  it('does not write when HomeKit repeats the power the fan already has', async () => {
    await setup();
    await set(fanService(), C.Active, C.Active.ACTIVE);
    expect(rig.writes).toEqual([]);
  });

  it('sets oscillation and the child lock from HomeKit', async () => {
    await setup();
    await set(fanService(), C.SwingMode, C.SwingMode.SWING_ENABLED);
    await set(fanService(), C.LockPhysicalControls, C.LockPhysicalControls.CONTROL_LOCK_ENABLED);
    expect(rig.real).toMatchObject({ swing: true, lock: true });
    expect(value(fanService(), C.SwingMode)).toBe(C.SwingMode.SWING_ENABLED);
    expect(value(fanService(), C.LockPhysicalControls)).toBe(
      C.LockPhysicalControls.CONTROL_LOCK_ENABLED,
    );
  });

  it('shows oscillation as off again when it was asked for while the fan is off', async () => {
    await setup({}, true);
    await set(fanService(), C.SwingMode, C.SwingMode.SWING_ENABLED);
    expect(value(fanService(), C.SwingMode)).toBe(C.SwingMode.SWING_DISABLED);
  });

  it('follows what is changed at the fan', async () => {
    await setup();
    rig.atTheFan.level(80);
    rig.atTheFan.swing(true);
    rig.fan.refresh();
    await rig.fan.idle();
    expect(value(fanService(), C.RotationSpeed)).toBe(80);
    expect(value(fanService(), C.SwingMode)).toBe(C.SwingMode.SWING_ENABLED);
  });

  it('answers "no response" while the fan does not answer, and recovers', async () => {
    await setup();
    const active = fanService().getCharacteristic(C.Active);
    await expect(active.handleGetRequest()).resolves.toBe(C.Active.ACTIVE);
    rig.device.silent = true;
    rig.fan.refresh();
    await rig.fan.idle();
    await expect(active.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    rig.device.silent = false;
    rig.fan.refresh();
    await rig.fan.idle();
    await expect(active.handleGetRequest()).resolves.toBe(C.Active.ACTIVE);
  });

  describe('move switches', () => {
    it('are not there unless asked for', async () => {
      await setup();
      expect(moveSwitch('left')).toBeUndefined();
      expect(moveSwitch('right')).toBeUndefined();
    });

    it('are two named switches that start off', async () => {
      await setup({ moveSwitches: true });
      const left = moveSwitch('left') as Service;
      const right = moveSwitch('right') as Service;
      expect(value(left, C.Name)).toBe('Move Left');
      expect(value(right, C.ConfiguredName)).toBe('Move Right');
      expect(value(left, C.On)).toBe(false);
      expect(value(right, C.On)).toBe(false);
    });

    it('turn the head while one is on and stop when it is turned off', async () => {
      await setup({ moveSwitches: true });
      const left = moveSwitch('left') as Service;
      left.getCharacteristic(C.On).setValue(true);
      await sleep(50);
      expect(rig.device.moves.length).toBeGreaterThanOrEqual(2);
      expect(value(left, C.On)).toBe(true);
      await set(left, C.On, false);
      const sent = rig.device.moves.length;
      await sleep(40);
      expect(rig.device.moves).toHaveLength(sent);
      expect(new Set(rig.device.moves)).toEqual(new Set(['left']));
    });

    it('turn one off when the other is turned on', async () => {
      await setup({ moveSwitches: true });
      const left = moveSwitch('left') as Service;
      const right = moveSwitch('right') as Service;
      left.getCharacteristic(C.On).setValue(true);
      await sleep(15);
      right.getCharacteristic(C.On).setValue(true);
      expect(value(left, C.On)).toBe(false);
      expect(value(right, C.On)).toBe(true);
      await set(right, C.On, false);
    });

    it('go back to off when the fan is off', async () => {
      await setup({ moveSwitches: true }, true);
      const left = moveSwitch('left') as Service;
      await set(left, C.On, true);
      expect(value(left, C.On)).toBe(false);
      expect(rig.device.moves).toEqual([]);
    });

    it('are removed from an accessory that had them once the option is off', async () => {
      await setup({ moveSwitches: true });
      expect(moveSwitch('left')).toBeDefined();
      attach({ moveSwitches: false });
      expect(moveSwitch('left')).toBeUndefined();
      expect(moveSwitch('right')).toBeUndefined();
    });
  });
});
