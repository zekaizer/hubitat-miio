import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceOptions } from '../src/device';
import { Humidifier } from '../src/humidifier';
import { MiioClient, MiioError } from '../src/miio/client';
import { type HumidifierModel, humidifierModel } from '../src/models';
import { FAKE_TOKEN, FakeDevice } from './support/fake-device';
import { Log } from './support/fan-rig';

describe('humidifier', () => {
  let device: FakeDevice;
  let client: MiioClient;
  let humidifier: Humidifier;
  let model: HumidifierModel;
  const log = new Log();

  async function setup(options: DeviceOptions = {}): Promise<void> {
    log.lines.length = 0;
    device = await FakeDevice.start('zhimi.humidifier.ca4');
    client = new MiioClient({
      address: device.address,
      port: device.port,
      token: FAKE_TOKEN,
      timeoutMs: 40,
    });
    model = { ...(humidifierModel('zhimi.humidifier.ca4') as HumidifierModel) };
    humidifier = new Humidifier(client, model, {
      pollMs: 60_000,
      enforceIntervalMs: 0,
      log,
      ...options,
    });
    humidifier.start();
    await humidifier.idle();
  }

  const writes = (): string[] =>
    device.requests
      .filter((r) => r.method === 'set_properties')
      .map((r) =>
        (r.params as Array<{ siid: number; piid: number }>)
          .map((i) => `${i.siid}/${i.piid}`)
          .join(','),
      );

  afterEach(async () => {
    humidifier.stop();
    client.close();
    await device.close();
  });

  it('shows the state read from the humidifier once it is started', async () => {
    await setup();
    expect(humidifier.snapshot).toMatchObject({
      online: true,
      state: { power: false, mode: 'auto', targetHumidity: 70, humidity: 47 },
    });
  });

  it('shows the power at once and gives it to the humidifier', async () => {
    await setup();
    humidifier.setPower(true);
    expect(humidifier.snapshot.state?.power).toBe(true);
    await humidifier.idle();
    expect(device.humidifier['2/1']).toBe(true);
    humidifier.setPower(false);
    await humidifier.idle();
    expect(device.humidifier['2/1']).toBe(false);
    expect(humidifier.snapshot.state?.power).toBe(false);
  });

  it('sets the mode and the child lock', async () => {
    await setup();
    humidifier.setMode('high');
    humidifier.setLock(true);
    expect(humidifier.snapshot.state).toMatchObject({ mode: 'high', lock: true });
    await humidifier.idle();
    expect(device.humidifier).toMatchObject({ '2/5': 3, '6/1': true });
    expect(humidifier.snapshot.state).toMatchObject({ mode: 'high', lock: true });
  });

  it('sets the target humidity', async () => {
    await setup();
    humidifier.setTargetHumidity(55);
    expect(humidifier.snapshot.state?.targetHumidity).toBe(55);
    await humidifier.idle();
    expect(device.humidifier['2/6']).toBe(55);
  });

  it.each([
    [10, 30],
    [95, 80],
    [54.6, 55],
  ])('asks for target humidity %d as %d', async (asked, written) => {
    await setup();
    humidifier.setTargetHumidity(asked);
    expect(humidifier.snapshot.state?.targetHumidity).toBe(written);
    await humidifier.idle();
    expect(device.humidifier['2/6']).toBe(written);
  });

  it('writes only the last target humidity when several come in a row', async () => {
    await setup();
    humidifier.setTargetHumidity(40);
    humidifier.setTargetHumidity(50);
    humidifier.setTargetHumidity(60);
    await humidifier.idle();
    expect(device.humidifier['2/6']).toBe(60);
    expect(writes()).toEqual(['2/6']);
  });

  it('picks up what was changed at the humidifier', async () => {
    await setup();
    Object.assign(device.humidifier, { '2/1': true, '3/9': 52, '2/7': 100 });
    humidifier.refresh();
    await humidifier.idle();
    expect(humidifier.snapshot.state).toMatchObject({ power: true, humidity: 52, waterLevel: 100 });
  });

  it('shows what the humidifier has when it refuses a value', async () => {
    await setup();
    model.setMode = async () => {
      throw new MiioError(-4005, 'mode rejected');
    };
    humidifier.setMode('low');
    expect(humidifier.snapshot.state?.mode).toBe('low');
    await humidifier.idle();
    expect(humidifier.snapshot.state?.mode).toBe('auto');
    expect(log.matching(/warn mode failed: -4005/)).toHaveLength(1);
  });

  it('goes offline when the humidifier stops answering and comes back', async () => {
    await setup();
    device.silent = true;
    humidifier.setPower(true);
    await humidifier.idle();
    expect(humidifier.snapshot).toMatchObject({ online: false, state: { power: false } });
    expect(log.matching(/warn no reply from the humidifier/)).toHaveLength(1);
    device.silent = false;
    humidifier.refresh();
    await humidifier.idle();
    expect(humidifier.snapshot.online).toBe(true);
    expect(log.matching(/info the humidifier answers again/)).toHaveLength(1);
  });

  it('keeps the buzzer and the screen at the configured values', async () => {
    await setup({ buzzer: 'on', light: 'off' });
    expect(device.humidifier).toMatchObject({ '4/1': true, '5/2': 0 });
  });

  it('uses the night value of the screen and gives back what it had', async () => {
    let night = true;
    await setup({ lightAtNight: 'off', isNight: () => night });
    expect(device.humidifier['5/2']).toBe(0);
    night = false;
    humidifier.refresh();
    await humidifier.idle();
    expect(device.humidifier['5/2']).toBe(2);
  });
});
