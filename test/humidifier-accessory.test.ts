import type { Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';
import { afterEach, describe, expect, it } from 'vitest';

import { Humidifier } from '../src/humidifier';
import { HumidifierAccessory } from '../src/humidifier-accessory';
import { MiioClient } from '../src/miio/client';
import { type HumidifierModel, humidifierModel } from '../src/models';
import { FAKE_TOKEN, FakeDevice } from './support/fake-device';

const api = new HomebridgeAPI();
const { Service: S, Characteristic: C, HAPStatus } = api.hap;
const Target = C.TargetHumidifierDehumidifierState;
const Current = C.CurrentHumidifierDehumidifierState;

describe('humidifier accessory', () => {
  let device: FakeDevice;
  let client: MiioClient;
  let humidifier: Humidifier;
  let accessory: PlatformAccessory;

  async function setup(at: Record<string, boolean | number> = {}): Promise<void> {
    device = await FakeDevice.start('zhimi.humidifier.ca4');
    Object.assign(device.humidifier, at);
    client = new MiioClient({
      address: device.address,
      port: device.port,
      token: FAKE_TOKEN,
      timeoutMs: 40,
    });
    humidifier = new Humidifier(
      client,
      humidifierModel('zhimi.humidifier.ca4') as HumidifierModel,
      { pollMs: 60_000 },
    );
    accessory = new api.platformAccessory('Humidifier', api.hap.uuid.generate('humidifier'));
    new HumidifierAccessory(api.hap, accessory, humidifier, {
      name: 'Humidifier',
      info: { model: 'zhimi.humidifier.ca4', firmware: '2.2.8', serial: 'AA:BB:CC:DD:EE:67' },
    });
    humidifier.start();
    await humidifier.idle();
  }

  afterEach(async () => {
    humidifier.stop();
    client.close();
    await device.close();
  });

  const service = (): Service => accessory.getService(S.HumidifierDehumidifier) as Service;
  const value = (characteristic: WithUUID<new () => Characteristic>): unknown =>
    service().getCharacteristic(characteristic).value;
  const set = async (
    characteristic: WithUUID<new () => Characteristic>,
    to: number,
  ): Promise<void> => {
    service().getCharacteristic(characteristic).setValue(to);
    await humidifier.idle();
  };
  const refreshed = async (at: Record<string, boolean | number>): Promise<void> => {
    Object.assign(device.humidifier, at);
    humidifier.refresh();
    await humidifier.idle();
  };

  it('shows the state of the humidifier', async () => {
    await setup();
    expect(value(C.Active)).toBe(C.Active.INACTIVE);
    expect(value(Current)).toBe(Current.INACTIVE);
    expect(value(Target)).toBe(Target.HUMIDIFIER_OR_DEHUMIDIFIER);
    expect(value(C.CurrentRelativeHumidity)).toBe(47);
    expect(value(C.RelativeHumidityHumidifierThreshold)).toBe(70);
    expect(value(C.LockPhysicalControls)).toBe(C.LockPhysicalControls.CONTROL_LOCK_DISABLED);
  });

  it('describes the device', async () => {
    await setup();
    const info = accessory.getService(S.AccessoryInformation) as Service;
    expect(info.getCharacteristic(C.Manufacturer).value).toBe('Xiaomi');
    expect(info.getCharacteristic(C.Model).value).toBe('zhimi.humidifier.ca4');
    expect(info.getCharacteristic(C.SerialNumber).value).toBe('AA:BB:CC:DD:EE:67');
  });

  it('offers automatic and humidifying, and never dehumidifying', async () => {
    await setup();
    expect(service().getCharacteristic(Target).props.validValues).toEqual([
      Target.HUMIDIFIER_OR_DEHUMIDIFIER,
      Target.HUMIDIFIER,
    ]);
  });

  it('turns the humidifier on and off from HomeKit', async () => {
    await setup();
    await set(C.Active, C.Active.ACTIVE);
    expect(device.humidifier['2/1']).toBe(true);
    await set(C.Active, C.Active.INACTIVE);
    expect(device.humidifier['2/1']).toBe(false);
  });

  it('shows humidifying below the target and idle at or above it', async () => {
    await setup({ '2/1': true, '3/9': 47, '2/6': 70 });
    expect(value(C.Active)).toBe(C.Active.ACTIVE);
    expect(value(Current)).toBe(Current.HUMIDIFYING);
    await refreshed({ '3/9': 70 });
    expect(value(Current)).toBe(Current.IDLE);
  });

  it('sets the target humidity from HomeKit, kept within what the humidifier takes', async () => {
    await setup();
    await set(C.RelativeHumidityHumidifierThreshold, 55);
    expect(device.humidifier['2/6']).toBe(55);
    await set(C.RelativeHumidityHumidifierThreshold, 100);
    expect(device.humidifier['2/6']).toBe(80);
    expect(value(C.RelativeHumidityHumidifierThreshold)).toBe(80);
  });

  it.each([
    [1, 33, 'low'],
    [2, 66, 'medium'],
    [3, 100, 'high'],
  ])('shows fan level %i as humidifying at speed %i', async (level, speed) => {
    await setup({ '2/5': level });
    expect(value(Target)).toBe(Target.HUMIDIFIER);
    expect(value(C.RotationSpeed)).toBe(speed);
  });

  it.each([
    [10, 1],
    [33, 1],
    [34, 2],
    [66, 2],
    [67, 3],
    [100, 3],
  ])('sets the fan level for speed %i to %i', async (speed, level) => {
    await setup();
    await set(C.RotationSpeed, speed);
    expect(device.humidifier['2/5']).toBe(level);
    expect(value(Target)).toBe(Target.HUMIDIFIER);
  });

  it('leaves the mode alone for speed 0, which HomeKit sends when it turns the device off', async () => {
    await setup({ '2/5': 2 });
    await set(C.RotationSpeed, 0);
    expect(device.humidifier['2/5']).toBe(2);
  });

  it('switches to the automatic mode and back to a manual one', async () => {
    await setup({ '2/5': 3 });
    await set(Target, Target.HUMIDIFIER_OR_DEHUMIDIFIER);
    expect(device.humidifier['2/5']).toBe(0);
    await set(Target, Target.HUMIDIFIER);
    expect(device.humidifier['2/5']).toBe(2);
    expect(value(C.RotationSpeed)).toBe(66);
  });

  it('does not change a manual level when HomeKit asks for humidifying again', async () => {
    await setup({ '2/5': 3 });
    await set(Target, Target.HUMIDIFIER);
    expect(device.humidifier['2/5']).toBe(3);
  });

  it.each([
    [0, 0],
    [60, 50],
    [120, 100],
    [125, 100],
    [127, 0],
  ])('shows water level %i as %i %%', async (raw, percent) => {
    await setup({ '2/7': raw });
    expect(value(C.WaterLevel)).toBe(percent);
  });

  it('sets the child lock from HomeKit', async () => {
    await setup();
    await set(C.LockPhysicalControls, C.LockPhysicalControls.CONTROL_LOCK_ENABLED);
    expect(device.humidifier['6/1']).toBe(true);
  });

  it('follows what is changed at the humidifier', async () => {
    await setup();
    await refreshed({ '2/1': true, '3/9': 52, '2/6': 60 });
    expect(value(C.Active)).toBe(C.Active.ACTIVE);
    expect(value(C.CurrentRelativeHumidity)).toBe(52);
    expect(value(C.RelativeHumidityHumidifierThreshold)).toBe(60);
  });

  it('answers "no response" while the humidifier does not answer, and recovers', async () => {
    await setup();
    const active = service().getCharacteristic(C.Active);
    device.silent = true;
    humidifier.refresh();
    await humidifier.idle();
    await expect(active.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    device.silent = false;
    humidifier.refresh();
    await humidifier.idle();
    await expect(active.handleGetRequest()).resolves.toBe(C.Active.INACTIVE);
  });
});
